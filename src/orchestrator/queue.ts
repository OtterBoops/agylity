import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppDatabase } from '../storage/db.js';
import type { QuotaFamily } from '../sentry/models.js';
import {
  resolvePoolFamilyForModel,
  type ReasoningEffort,
  type TaskPriority,
  type TaskStatus,
  type WorkerMode,
} from './models.js';

export interface RunnerSystemInfo {
  hostname?: string;
  platform?: string;
  arch?: string;
  agyVersion?: string;
}

export interface SwarmTask {
  id: string;
  dispatchId?: number;
  createdAt: string;
  updatedAt: string;
  repositoryId: string;
  repositoryName: string;
  repositoryPath: string;
  cloneUrl?: string;
  defaultBranch: string;
  prompt: string;
  requestedBy: string;
  priority: TaskPriority;
  workerMode: WorkerMode;
  requiredLabels: string[];
  model: string;
  poolFamily: QuotaFamily;
  effort: ReasoningEffort;
  allowOverage: boolean;
  pushBranch: boolean;
  verifyCommand?: string;
  status: TaskStatus;
  workerId?: string;
  claimedAt?: string;
  heartbeatAt?: string;
  completedAt?: string;
  branchName?: string;
  output?: string;
  error?: string;
  durationMs: number;
}

export interface EnqueueTaskInput {
  id?: string;
  repositoryId?: string;
  repositoryName: string;
  repositoryPath?: string;
  cloneUrl?: string;
  defaultBranch?: string;
  prompt: string;
  requestedBy?: string;
  priority?: TaskPriority;
  workerMode?: WorkerMode;
  requiredLabels?: string[];
  model: string;
  effort?: ReasoningEffort;
  allowOverage?: boolean;
  pushBranch?: boolean;
  verifyCommand?: string;
}

export interface ClaimTaskOptions {
  workerId: string;
  workerName?: string;
  workerMode?: WorkerMode;
  labels?: string[];
  repositories?: string[];
  systemInfo?: RunnerSystemInfo;
  eligibilityCheck?: (task: SwarmTask) => { allowed: boolean; resolvedModel?: string };
}

export interface TaskStatusPatch {
  status: TaskStatus;
  workerId?: string;
  branchName?: string;
  output?: string;
  error?: string;
  durationMs?: number;
}

export interface SwarmWorkerRecord {
  workerId: string;
  name: string;
  workerMode: WorkerMode;
  labels: string[];
  repositories: string[];
  systemInfo: RunnerSystemInfo;
  enabled: boolean;
  hasToken: boolean;
  activeTaskId?: string;
  status: 'idle' | 'busy' | 'offline';
  registeredAt: string;
  lastSeenAt: string;
}

export interface CreateRegistrationTokenInput {
  nameHint?: string;
  workerMode?: WorkerMode;
  labels?: string[];
  repositories?: string[];
  ttlMs?: number;
}

export interface RunnerRegistrationTokenResult {
  id: string;
  registrationToken: string;
  nameHint?: string;
  workerMode: WorkerMode;
  labels: string[];
  repositories: string[];
  expiresAt: string;
  createdAt: string;
}

export interface ExchangeRegistrationTokenInput {
  registrationToken: string;
  workerId?: string;
  workerName?: string;
  workerMode?: WorkerMode;
  labels?: string[];
  repositories?: string[];
  systemInfo?: RunnerSystemInfo;
}

const PRIORITY_RANK: Record<TaskPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
};

export const hashRunnerToken = (token: string): string =>
  createHash('sha256').update(token.trim()).digest('hex');

export class TaskQueue {
  private readonly appDb: AppDatabase;
  private readonly rawDb: DatabaseSync;

  constructor(database: AppDatabase) {
    this.appDb = database;
    this.rawDb = database.getRawDb();
    this.initSchema();
  }

  private inTransaction<T>(fn: () => T): T {
    this.rawDb.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.rawDb.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.rawDb.exec('ROLLBACK');
      } catch {
        // Rollback best-effort
      }
      throw err;
    }
  }

  private initSchema(): void {
    this.rawDb.exec(`
      CREATE TABLE IF NOT EXISTS swarm_tasks (
        id TEXT PRIMARY KEY,
        dispatch_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        repository_id TEXT NOT NULL,
        repository_name TEXT NOT NULL,
        repository_path TEXT NOT NULL,
        clone_url TEXT,
        default_branch TEXT NOT NULL DEFAULT 'main',
        prompt TEXT NOT NULL,
        requested_by TEXT NOT NULL DEFAULT 'web-ui',
        priority TEXT NOT NULL DEFAULT 'P0',
        priority_rank INTEGER NOT NULL DEFAULT 0,
        worker_mode TEXT NOT NULL DEFAULT 'headless',
        required_labels_json TEXT NOT NULL DEFAULT '[]',
        model TEXT NOT NULL,
        pool_family TEXT NOT NULL,
        effort TEXT NOT NULL DEFAULT 'high',
        allow_overage INTEGER NOT NULL DEFAULT 0,
        push_branch INTEGER NOT NULL DEFAULT 1,
        verify_command TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        worker_id TEXT,
        claimed_at TEXT,
        heartbeat_at TEXT,
        completed_at TEXT,
        branch_name TEXT,
        output TEXT,
        error TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_swarm_tasks_queue
        ON swarm_tasks (status, priority_rank ASC, created_at ASC);

      CREATE TABLE IF NOT EXISTS swarm_workers (
        worker_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT,
        worker_mode TEXT NOT NULL DEFAULT 'headless',
        labels_json TEXT NOT NULL DEFAULT '[]',
        repositories_json TEXT NOT NULL DEFAULT '[]',
        system_info_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        active_task_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE IF NOT EXISTS swarm_runner_registrations (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        name_hint TEXT,
        worker_mode TEXT NOT NULL DEFAULT 'headless',
        labels_json TEXT NOT NULL DEFAULT '[]',
        repositories_json TEXT NOT NULL DEFAULT '[]',
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_by_worker_id TEXT,
        consumed_at TEXT
      );
    `);

    // Safe forward-migrations for existing SQLite databases
    const migrations = [
      "ALTER TABLE swarm_tasks ADD COLUMN required_labels_json TEXT NOT NULL DEFAULT '[]'",
      'ALTER TABLE swarm_tasks ADD COLUMN clone_url TEXT',
      'ALTER TABLE swarm_workers ADD COLUMN token_hash TEXT',
      "ALTER TABLE swarm_workers ADD COLUMN labels_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE swarm_workers ADD COLUMN system_info_json TEXT NOT NULL DEFAULT '{}'",
      'ALTER TABLE swarm_workers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1',
      "ALTER TABLE swarm_workers ADD COLUMN registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    ];
    for (const sql of migrations) {
      try {
        this.rawDb.exec(sql);
      } catch {
        // Column already exists
      }
    }
  }

  /**
   * Generates a short-lived one-time registration token (GitHub Actions Runner style).
   * The plaintext token is returned once and only its SHA-256 hash is persisted.
   */
  public createRegistrationToken(
    input: CreateRegistrationTokenInput = {}
  ): RunnerRegistrationTokenResult {
    const id = `reg-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const registrationToken = `agyr_reg_${randomBytes(24).toString('hex')}`;
    const tokenHash = hashRunnerToken(registrationToken);
    const now = new Date();
    const ttlMs = Math.max(60_000, input.ttlMs ?? 60 * 60 * 1000); // 1 hour default
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const createdAt = now.toISOString();
    const workerMode: WorkerMode = input.workerMode ?? 'headless';
    const labels = Array.from(
      new Set((input.labels ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean))
    );
    const repositories = Array.from(
      new Set((input.repositories ?? []).map((r) => r.trim()).filter(Boolean))
    );
    const nameHint = input.nameHint?.trim() || undefined;

    this.rawDb
      .prepare(
        `INSERT INTO swarm_runner_registrations (
          id, token_hash, name_hint, worker_mode, labels_json, repositories_json, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        tokenHash,
        nameHint ?? null,
        workerMode,
        JSON.stringify(labels),
        JSON.stringify(repositories),
        expiresAt,
        createdAt
      );

    return {
      id,
      registrationToken,
      nameHint,
      workerMode,
      labels,
      repositories,
      expiresAt,
      createdAt,
    };
  }

  /**
   * Exchanges a valid, unexpired one-time registration token for a persistent runner identity
   * and unique per-runner authentication token (`agyr_run_...`).
   */
  public exchangeRegistrationToken(
    input: ExchangeRegistrationTokenInput,
    nowMs = Date.now()
  ): { worker: SwarmWorkerRecord; runnerToken: string } {
    return this.inTransaction(() => {
      const rawToken = input.registrationToken?.trim();
      if (!rawToken) {
        throw new Error('Registration token is required');
      }

      const tokenHash = hashRunnerToken(rawToken);
      const regRow = this.rawDb
        .prepare('SELECT * FROM swarm_runner_registrations WHERE token_hash = ?')
        .get(tokenHash) as Record<string, any> | undefined;

      if (!regRow) {
        throw new Error('Invalid runner registration token');
      }

      if (regRow.consumed_by_worker_id) {
        throw new Error('Runner registration token has already been used');
      }

      const expiresEpoch = new Date(String(regRow.expires_at)).getTime();
      if (Number.isNaN(expiresEpoch) || nowMs > expiresEpoch) {
        throw new Error('Runner registration token has expired');
      }

      let defaultLabels: string[] = [];
      let defaultRepos: string[] = [];
      try {
        defaultLabels = JSON.parse(String(regRow.labels_json || '[]'));
      } catch {}
      try {
        defaultRepos = JSON.parse(String(regRow.repositories_json || '[]'));
      } catch {}

      const workerId = input.workerId?.trim() || `runner-${randomBytes(4).toString('hex')}`;
      const workerName =
        input.workerName?.trim() ||
        (regRow.name_hint ? String(regRow.name_hint) : undefined) ||
        workerId;
      const workerMode: WorkerMode =
        input.workerMode ?? ((regRow.worker_mode as WorkerMode) || 'headless');
      const labels = Array.from(
        new Set(
          (input.labels && input.labels.length > 0 ? input.labels : defaultLabels)
            .map((l) => l.trim().toLowerCase())
            .filter(Boolean)
        )
      );
      const repositories = Array.from(
        new Set(
          (input.repositories && input.repositories.length > 0 ? input.repositories : defaultRepos)
            .map((r) => r.trim())
            .filter(Boolean)
        )
      );
      const systemInfo: RunnerSystemInfo = input.systemInfo ?? {};

      const runnerToken = `agyr_run_${randomBytes(32).toString('hex')}`;
      const runnerTokenHash = hashRunnerToken(runnerToken);
      const nowIso = new Date(nowMs).toISOString();

      this.rawDb
        .prepare(
          `UPDATE swarm_runner_registrations
           SET consumed_by_worker_id = ?, consumed_at = ?
           WHERE id = ?`
        )
        .run(workerId, nowIso, String(regRow.id));

      this.rawDb
        .prepare(
          `INSERT INTO swarm_workers (
            worker_id, name, token_hash, worker_mode, labels_json, repositories_json,
            system_info_json, enabled, active_task_id, status, registered_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, 'idle', ?, ?)
          ON CONFLICT(worker_id) DO UPDATE SET
            name = excluded.name,
            token_hash = excluded.token_hash,
            worker_mode = excluded.worker_mode,
            labels_json = excluded.labels_json,
            repositories_json = excluded.repositories_json,
            system_info_json = excluded.system_info_json,
            enabled = 1,
            status = 'idle',
            last_seen_at = excluded.last_seen_at`
        )
        .run(
          workerId,
          workerName,
          runnerTokenHash,
          workerMode,
          JSON.stringify(labels),
          JSON.stringify(repositories),
          JSON.stringify(systemInfo),
          nowIso,
          nowIso
        );

      return {
        worker: this.getWorker(workerId)!,
        runnerToken,
      };
    });
  }

  /**
   * Authenticates a runner request using its unique `agyr_run_...` token
   * (or optional fallback `workerSharedSecret` for static/test setups).
   */
  public authenticateRunner(
    providedToken: string | undefined,
    fallbackSharedSecret?: string
  ): { authenticated: boolean; worker?: SwarmWorkerRecord; viaSharedSecret?: boolean } {
    const cleanToken = providedToken?.trim() || '';
    const cleanShared = fallbackSharedSecret?.trim() || '';

    if (cleanToken) {
      const tokenHash = hashRunnerToken(cleanToken);
      const row = this.rawDb
        .prepare('SELECT * FROM swarm_workers WHERE token_hash = ?')
        .get(tokenHash) as Record<string, any> | undefined;
      if (row) {
        return { authenticated: true, worker: this.mapRowToWorker(row) };
      }

      if (cleanShared && cleanToken === cleanShared) {
        return { authenticated: true, viaSharedSecret: true };
      }

      return { authenticated: false };
    }

    // If a shared secret is configured or at least one token-backed runner is registered, require a token
    if (cleanShared) {
      return { authenticated: false };
    }

    const registeredCountRow = this.rawDb
      .prepare('SELECT COUNT(*) as cnt FROM swarm_workers WHERE token_hash IS NOT NULL')
      .get() as { cnt?: number } | undefined;
    if ((registeredCountRow?.cnt ?? 0) > 0) {
      return { authenticated: false };
    }

    return { authenticated: true };
  }

  public getWorker(workerId: string): SwarmWorkerRecord | undefined {
    const row = this.rawDb
      .prepare('SELECT * FROM swarm_workers WHERE worker_id = ?')
      .get(workerId) as Record<string, any> | undefined;
    return row ? this.mapRowToWorker(row) : undefined;
  }

  public setWorkerEnabled(workerId: string, enabled: boolean): SwarmWorkerRecord | undefined {
    const existing = this.getWorker(workerId);
    if (!existing) return undefined;

    this.rawDb
      .prepare('UPDATE swarm_workers SET enabled = ? WHERE worker_id = ?')
      .run(enabled ? 1 : 0, workerId);

    return this.getWorker(workerId);
  }

  /**
   * Revokes a runner, deleting its record and credentials from `swarm_workers`.
   * Any in-flight task claimed by this runner is returned to `'queued'` status.
   */
  public revokeWorker(workerId: string): boolean {
    return this.inTransaction(() => {
      const existing = this.getWorker(workerId);
      if (!existing) return false;

      const now = new Date().toISOString();
      this.rawDb
        .prepare(
          `UPDATE swarm_tasks
           SET status = 'queued',
               worker_id = NULL,
               claimed_at = NULL,
               heartbeat_at = NULL,
               updated_at = ?
           WHERE worker_id = ? AND status IN ('claimed', 'executing')`
        )
        .run(now, workerId);

      this.rawDb.prepare('DELETE FROM swarm_workers WHERE worker_id = ?').run(workerId);
      return true;
    });
  }

  public enqueue(input: EnqueueTaskInput): SwarmTask {
    const id = input.id ?? `task-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const repoId = (input.repositoryId || input.repositoryName).trim();
    const repoName = input.repositoryName.trim();
    const repoPath = (input.repositoryPath || `/repos/${repoId}`).trim();
    const defaultBranch = (input.defaultBranch || 'main').trim();
    const prompt = input.prompt.slice(0, 4000);
    const requestedBy = (input.requestedBy || 'web-ui').trim();
    const priority: TaskPriority = input.priority ?? 'P0';
    const priorityRank = PRIORITY_RANK[priority] ?? 0;
    const workerMode: WorkerMode = input.workerMode ?? 'headless';
    const requiredLabels = Array.from(
      new Set((input.requiredLabels ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean))
    );
    const model = (input.model ?? 'gemini-4-argon-high').trim();
    const poolFamily = resolvePoolFamilyForModel(model);
    const effort: ReasoningEffort = input.effort ?? 'high';
    const allowOverage = Boolean(input.allowOverage);
    const pushBranch = input.pushBranch !== false;

    this.rawDb
      .prepare(
        `INSERT INTO swarm_tasks (
          id, created_at, updated_at, repository_id, repository_name, repository_path,
          clone_url, default_branch, prompt, requested_by, priority, priority_rank, worker_mode,
          required_labels_json, model, pool_family, effort, allow_overage, push_branch,
          verify_command, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`
      )
      .run(
        id,
        now,
        now,
        repoId,
        repoName,
        repoPath,
        input.cloneUrl ?? null,
        defaultBranch,
        prompt,
        requestedBy,
        priority,
        priorityRank,
        workerMode,
        JSON.stringify(requiredLabels),
        model,
        poolFamily,
        effort,
        allowOverage ? 1 : 0,
        pushBranch ? 1 : 0,
        input.verifyCommand ?? null
      );

    return this.getTask(id)!;
  }

  public getTask(id: string): SwarmTask | undefined {
    const row = this.rawDb.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(id) as
      Record<string, any> | undefined;
    return row ? this.mapRowToTask(row) : undefined;
  }

  public listTasks(options: { status?: TaskStatus; limit?: number } = {}): SwarmTask[] {
    const limit = Math.min(Math.max(1, options.limit ?? 50), 500);
    if (options.status) {
      const rows = this.rawDb
        .prepare(
          'SELECT * FROM swarm_tasks WHERE status = ? ORDER BY priority_rank ASC, created_at ASC LIMIT ?'
        )
        .all(options.status, limit) as Array<Record<string, any>>;
      return rows.map((r) => this.mapRowToTask(r));
    }

    const rows = this.rawDb
      .prepare('SELECT * FROM swarm_tasks ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(limit) as Array<Record<string, any>>;
    return rows.map((r) => this.mapRowToTask(r));
  }

  /**
   * Atomically claims the next eligible queued task for a worker.
   * Evaluates priority order (P0 -> P1 -> P2, FIFO within tier), worker enabled state,
   * workerMode, required labels, repository match, and optional live quota eligibility.
   */
  public claimNext(options: ClaimTaskOptions): SwarmTask | null {
    return this.inTransaction(() => {
      const existingWorker = this.getWorker(options.workerId);
      if (existingWorker && !existingWorker.enabled) {
        this.registerWorkerHeartbeat({
          workerId: options.workerId,
          name: options.workerName,
          workerMode: options.workerMode,
          labels: options.labels,
          repositories: options.repositories,
          systemInfo: options.systemInfo,
          status: 'idle',
        });
        return null;
      }

      const workerMode = options.workerMode ?? existingWorker?.workerMode ?? 'headless';
      const effectiveLabels =
        options.labels && options.labels.length > 0
          ? options.labels
          : (existingWorker?.labels ?? []);
      const workerLabelSet = new Set(effectiveLabels.map((l) => l.toLowerCase()));

      const effectiveRepos =
        options.repositories && options.repositories.length > 0
          ? options.repositories
          : (existingWorker?.repositories ?? []);
      const repoFilter =
        effectiveRepos.length > 0 ? new Set(effectiveRepos.map((r) => r.toLowerCase())) : null;

      const candidates = this.rawDb
        .prepare(
          `SELECT * FROM swarm_tasks
           WHERE status = 'queued'
           ORDER BY priority_rank ASC, created_at ASC, rowid ASC`
        )
        .all() as Array<Record<string, any>>;

      for (const row of candidates) {
        const task = this.mapRowToTask(row);

        // 1. Check workerMode compatibility
        if (task.workerMode !== 'any' && workerMode !== 'any' && task.workerMode !== workerMode) {
          continue;
        }

        // 2. Check required labels (if task specifies labels, worker must have all of them)
        if (task.requiredLabels.length > 0) {
          const hasAllLabels = task.requiredLabels.every((reqLabel) =>
            workerLabelSet.has(reqLabel.toLowerCase())
          );
          if (!hasAllLabels) {
            continue;
          }
        }

        // 3. Check repository capability filter if worker specified a subset
        if (
          repoFilter &&
          !repoFilter.has(task.repositoryId.toLowerCase()) &&
          !repoFilter.has(task.repositoryName.toLowerCase())
        ) {
          continue;
        }

        // 4. Check live quota / P2 burn eligibility
        let updatedModel = task.model;
        if (options.eligibilityCheck) {
          const check = options.eligibilityCheck(task);
          if (!check.allowed) {
            continue;
          }
          if (check.resolvedModel) {
            updatedModel = check.resolvedModel;
          }
        }

        const now = new Date().toISOString();
        const updateResult = this.rawDb
          .prepare(
            `UPDATE swarm_tasks
             SET status = 'claimed',
                 worker_id = ?,
                 model = ?,
                 pool_family = ?,
                 claimed_at = ?,
                 heartbeat_at = ?,
                 updated_at = ?
             WHERE id = ? AND status = 'queued'`
          )
          .run(
            options.workerId,
            updatedModel,
            resolvePoolFamilyForModel(updatedModel),
            now,
            now,
            now,
            task.id
          ) as unknown as { changes?: number };

        if ((updateResult?.changes ?? 0) > 0) {
          this.registerWorkerHeartbeat({
            workerId: options.workerId,
            name: options.workerName,
            workerMode,
            labels: options.labels,
            repositories: options.repositories,
            systemInfo: options.systemInfo,
            activeTaskId: task.id,
            status: 'busy',
          });
          return this.getTask(task.id) ?? null;
        }
      }

      this.registerWorkerHeartbeat({
        workerId: options.workerId,
        name: options.workerName,
        workerMode,
        labels: options.labels,
        repositories: options.repositories,
        systemInfo: options.systemInfo,
        status: 'idle',
      });

      return null;
    });
  }

  public updateTaskStatus(taskId: string, patch: TaskStatusPatch): SwarmTask | undefined {
    const existing = this.getTask(taskId);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const isTerminal =
      patch.status === 'completed' || patch.status === 'failed' || patch.status === 'aborted';
    const completedAt = isTerminal ? now : (existing.completedAt ?? null);
    const durationMs =
      patch.durationMs !== undefined
        ? Math.max(0, Math.round(patch.durationMs))
        : existing.claimedAt && isTerminal
          ? Math.max(0, Date.now() - new Date(existing.claimedAt).getTime())
          : existing.durationMs;

    const branchName = patch.branchName ?? existing.branchName ?? null;
    const output =
      patch.output !== undefined ? patch.output.slice(0, 16000) : (existing.output ?? null);
    const error = patch.error !== undefined ? patch.error.slice(0, 4000) : (existing.error ?? null);
    const workerId = patch.workerId ?? existing.workerId ?? null;

    this.rawDb
      .prepare(
        `UPDATE swarm_tasks
         SET status = ?,
             worker_id = ?,
             branch_name = ?,
             output = ?,
             error = ?,
             duration_ms = ?,
             heartbeat_at = ?,
             completed_at = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        patch.status,
        workerId,
        branchName,
        output,
        error,
        durationMs,
        now,
        completedAt,
        now,
        taskId
      );

    if (isTerminal && existing.dispatchId === undefined) {
      const dispatchId = this.appDb.recordDispatch({
        repository: existing.repositoryName,
        prompt: existing.prompt,
        requestedBy: existing.requestedBy,
        success: patch.status === 'completed',
        branch: branchName ?? undefined,
        error: error ?? undefined,
        durationMs,
      });
      if (dispatchId) {
        this.rawDb
          .prepare('UPDATE swarm_tasks SET dispatch_id = ? WHERE id = ?')
          .run(dispatchId, taskId);
      }
    }

    if (workerId && this.getWorker(workerId)) {
      this.registerWorkerHeartbeat({
        workerId,
        activeTaskId: isTerminal ? null : taskId,
        status: isTerminal ? 'idle' : 'busy',
      });
    }

    return this.getTask(taskId);
  }

  /**
   * Fails tasks whose worker lease heartbeat has expired and marks stale workers offline.
   */
  public reapStaleClaims(leaseTimeoutMs = 10 * 60 * 1000, nowMs = Date.now()): number {
    const activeRows = this.rawDb
      .prepare("SELECT * FROM swarm_tasks WHERE status IN ('claimed', 'executing')")
      .all() as Array<Record<string, any>>;

    let reaped = 0;
    for (const row of activeRows) {
      const task = this.mapRowToTask(row);
      const lastBeat = task.heartbeatAt || task.claimedAt || task.updatedAt;
      const beatEpoch = new Date(lastBeat).getTime();
      if (!Number.isNaN(beatEpoch) && nowMs - beatEpoch > leaseTimeoutMs) {
        this.updateTaskStatus(task.id, {
          status: 'failed',
          error: `Worker lease expired after ${Math.round(leaseTimeoutMs / 1000)}s without heartbeat`,
          durationMs: nowMs - beatEpoch,
        });
        reaped++;
      }
    }

    // Mark workers that haven't sent a heartbeat within threshold as offline
    const workerOfflineThresholdMs = Math.min(leaseTimeoutMs, 2 * 60 * 1000);
    const workerRows = this.rawDb
      .prepare("SELECT * FROM swarm_workers WHERE status != 'offline'")
      .all() as Array<Record<string, any>>;
    for (const w of workerRows) {
      const seenEpoch = new Date(String(w.last_seen_at)).getTime();
      const threshold = w.status === 'busy' ? leaseTimeoutMs : workerOfflineThresholdMs;
      if (!Number.isNaN(seenEpoch) && nowMs - seenEpoch > threshold) {
        this.rawDb
          .prepare(
            "UPDATE swarm_workers SET status = 'offline', active_task_id = NULL WHERE worker_id = ?"
          )
          .run(String(w.worker_id));
      }
    }

    return reaped;
  }

  public registerWorkerHeartbeat(info: {
    workerId: string;
    name?: string;
    workerMode?: WorkerMode;
    labels?: string[];
    repositories?: string[];
    systemInfo?: RunnerSystemInfo;
    activeTaskId?: string | null;
    status?: 'idle' | 'busy' | 'offline';
  }): void {
    const now = new Date().toISOString();
    const existing = this.rawDb
      .prepare('SELECT * FROM swarm_workers WHERE worker_id = ?')
      .get(info.workerId) as Record<string, any> | undefined;

    const name = info.name ?? existing?.name ?? info.workerId;
    const workerMode = info.workerMode ?? existing?.worker_mode ?? 'headless';
    const labelsJson =
      info.labels !== undefined
        ? JSON.stringify(info.labels.map((l) => l.trim().toLowerCase()).filter(Boolean))
        : (existing?.labels_json ?? '[]');
    const reposJson =
      info.repositories !== undefined
        ? JSON.stringify(info.repositories)
        : (existing?.repositories_json ?? '[]');
    const systemInfoJson =
      info.systemInfo !== undefined
        ? JSON.stringify(info.systemInfo)
        : (existing?.system_info_json ?? '{}');
    const status = info.status ?? existing?.status ?? 'idle';
    const activeTaskId =
      status === 'idle' || status === 'offline'
        ? null
        : info.activeTaskId !== undefined
          ? info.activeTaskId
          : (existing?.active_task_id ?? null);

    this.rawDb
      .prepare(
        `INSERT INTO swarm_workers (
          worker_id, name, worker_mode, labels_json, repositories_json, system_info_json,
          active_task_id, status, registered_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(worker_id) DO UPDATE SET
          name = excluded.name,
          worker_mode = excluded.worker_mode,
          labels_json = excluded.labels_json,
          repositories_json = excluded.repositories_json,
          system_info_json = excluded.system_info_json,
          active_task_id = excluded.active_task_id,
          status = excluded.status,
          last_seen_at = excluded.last_seen_at`
      )
      .run(
        info.workerId,
        name,
        workerMode,
        labelsJson,
        reposJson,
        systemInfoJson,
        activeTaskId,
        status,
        existing?.registered_at ?? now,
        now
      );
  }

  public listWorkers(): SwarmWorkerRecord[] {
    const rows = this.rawDb
      .prepare('SELECT * FROM swarm_workers ORDER BY last_seen_at DESC')
      .all() as Array<Record<string, any>>;

    return rows.map((r) => this.mapRowToWorker(r));
  }

  private mapRowToWorker(r: Record<string, any>): SwarmWorkerRecord {
    let labels: string[] = [];
    let repositories: string[] = [];
    let systemInfo: RunnerSystemInfo = {};
    try {
      labels = JSON.parse(String(r.labels_json || '[]'));
    } catch {}
    try {
      repositories = JSON.parse(String(r.repositories_json || '[]'));
    } catch {}
    try {
      systemInfo = JSON.parse(String(r.system_info_json || '{}'));
    } catch {}

    return {
      workerId: String(r.worker_id),
      name: String(r.name),
      workerMode: (r.worker_mode as WorkerMode) || 'headless',
      labels,
      repositories,
      systemInfo,
      enabled: r.enabled !== 0,
      hasToken: Boolean(r.token_hash),
      activeTaskId: r.active_task_id ? String(r.active_task_id) : undefined,
      status: (r.status as 'idle' | 'busy' | 'offline') || 'idle',
      registeredAt: String(r.registered_at || r.last_seen_at),
      lastSeenAt: String(r.last_seen_at),
    };
  }

  private mapRowToTask(row: Record<string, any>): SwarmTask {
    let requiredLabels: string[] = [];
    try {
      requiredLabels = JSON.parse(String(row.required_labels_json || '[]'));
    } catch {}

    return {
      id: String(row.id),
      dispatchId:
        row.dispatch_id !== null && row.dispatch_id !== undefined
          ? Number(row.dispatch_id)
          : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      repositoryId: String(row.repository_id),
      repositoryName: String(row.repository_name),
      repositoryPath: String(row.repository_path),
      cloneUrl: row.clone_url ? String(row.clone_url) : undefined,
      defaultBranch: String(row.default_branch || 'main'),
      prompt: String(row.prompt),
      requestedBy: String(row.requested_by || 'web-ui'),
      priority: (row.priority as TaskPriority) || 'P0',
      workerMode: (row.worker_mode as WorkerMode) || 'headless',
      requiredLabels,
      model: String(row.model),
      poolFamily: (row.pool_family as QuotaFamily) || 'gemini-argon',
      effort: (row.effort as ReasoningEffort) || 'high',
      allowOverage: row.allow_overage === 1,
      pushBranch: row.push_branch === 1,
      verifyCommand: row.verify_command ? String(row.verify_command) : undefined,
      status: (row.status as TaskStatus) || 'queued',
      workerId: row.worker_id ? String(row.worker_id) : undefined,
      claimedAt: row.claimed_at ? String(row.claimed_at) : undefined,
      heartbeatAt: row.heartbeat_at ? String(row.heartbeat_at) : undefined,
      completedAt: row.completed_at ? String(row.completed_at) : undefined,
      branchName: row.branch_name ? String(row.branch_name) : undefined,
      output: row.output ? String(row.output) : undefined,
      error: row.error ? String(row.error) : undefined,
      durationMs: Number(row.duration_ms || 0),
    };
  }
}
