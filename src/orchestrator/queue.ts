import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppDatabase } from '../storage/db.js';
import type { QuotaFamily } from '../sentry/models.js';
import {
  resolvePoolFamilyForModel,
  type ReasoningEffort,
  type ScheduleMode,
  type TaskStatus,
} from './models.js';

export interface RunnerSystemInfo {
  hostname?: string;
  platform?: string;
  arch?: string;
  agyVersion?: string;
}

export interface SwarmTask {
  id: string;
  createdAt: string;
  updatedAt: string;
  repositoryId: string;
  repositoryName: string;
  repositoryPath: string;
  cloneUrl?: string;
  defaultBranch: string;
  prompt: string;
  requestedBy: string;
  scheduleMode: ScheduleMode;
  requiredLabels: string[];
  model: string;
  poolFamily: QuotaFamily;
  effort: ReasoningEffort;
  allowOverage: boolean;
  pushBranch: boolean;
  autoCreatePr: boolean;
  prUrl?: string;
  expiresAt?: string;
  standingTaskId?: string;
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
  numTurns?: number;
  totalTokens?: number;
  thinkingTokens?: number;
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
  scheduleMode?: ScheduleMode;
  requiredLabels?: string[];
  model: string;
  effort?: ReasoningEffort;
  allowOverage?: boolean;
  pushBranch?: boolean;
  autoCreatePr?: boolean;
  expiresAt?: string;
  standingTaskId?: string;
  verifyCommand?: string;
}

export interface ClaimTaskOptions {
  workerId: string;
  workerName?: string;
  labels?: string[];
  repositories?: string[];
  systemInfo?: RunnerSystemInfo;
  eligibilityCheck?: (task: SwarmTask) => { allowed: boolean; resolvedModel?: string };
}

export interface TaskStatusPatch {
  status: TaskStatus;
  workerId?: string;
  branchName?: string;
  prUrl?: string;
  output?: string;
  error?: string;
  durationMs?: number;
  numTurns?: number;
  totalTokens?: number;
  thinkingTokens?: number;
}

export interface SwarmWorkerRecord {
  workerId: string;
  name: string;
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
  labels?: string[];
  repositories?: string[];
  ttlMs?: number;
}

export interface RunnerRegistrationTokenResult {
  id: string;
  registrationToken: string;
  nameHint?: string;
  labels: string[];
  repositories: string[];
  expiresAt: string;
  createdAt: string;
}

export interface ExchangeRegistrationTokenInput {
  registrationToken: string;
  workerId?: string;
  workerName?: string;
  labels?: string[];
  repositories?: string[];
  systemInfo?: RunnerSystemInfo;
}

export interface StandingTaskRecord {
  id: string;
  title: string;
  prompt: string;
  repositoryId: string;
  model: string;
  effort: ReasoningEffort;
  verifyCommand?: string;
  autoCreatePr: boolean;
  enabled: boolean;
  sortOrder: number;
  triggerBeforeResetHours: number;
  lastTriggeredResetTime?: string;
  lastTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

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
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        repository_id TEXT NOT NULL,
        repository_name TEXT NOT NULL,
        repository_path TEXT NOT NULL,
        clone_url TEXT,
        default_branch TEXT NOT NULL DEFAULT 'main',
        prompt TEXT NOT NULL,
        requested_by TEXT NOT NULL DEFAULT 'web-ui',
        schedule_mode TEXT NOT NULL DEFAULT 'immediate',
        required_labels_json TEXT NOT NULL DEFAULT '[]',
        model TEXT NOT NULL,
        pool_family TEXT NOT NULL,
        effort TEXT NOT NULL DEFAULT 'high',
        allow_overage INTEGER NOT NULL DEFAULT 0,
        push_branch INTEGER NOT NULL DEFAULT 1,
        auto_create_pr INTEGER NOT NULL DEFAULT 1,
        pr_url TEXT,
        expires_at TEXT,
        standing_task_id TEXT,
        verify_command TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        worker_id TEXT,
        claimed_at TEXT,
        heartbeat_at TEXT,
        completed_at TEXT,
        branch_name TEXT,
        output TEXT,
        error TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        num_turns INTEGER,
        total_tokens INTEGER,
        thinking_tokens INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_swarm_tasks_queue
        ON swarm_tasks (status, created_at ASC);

      CREATE TABLE IF NOT EXISTS standing_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL DEFAULT 'high',
        verify_command TEXT,
        auto_create_pr INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        trigger_before_reset_hours REAL NOT NULL DEFAULT 2,
        last_triggered_reset_time TEXT,
        last_task_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE IF NOT EXISTS swarm_workers (
        worker_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT,
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
        labels_json TEXT NOT NULL DEFAULT '[]',
        repositories_json TEXT NOT NULL DEFAULT '[]',
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_by_worker_id TEXT,
        consumed_at TEXT
      );
    `);
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
          id, token_hash, name_hint, labels_json, repositories_json, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        tokenHash,
        nameHint ?? null,
        JSON.stringify(labels),
        JSON.stringify(repositories),
        expiresAt,
        createdAt
      );

    return {
      id,
      registrationToken,
      nameHint,
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
            worker_id, name, token_hash, labels_json, repositories_json,
            system_info_json, enabled, active_task_id, status, registered_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, 'idle', ?, ?)
          ON CONFLICT(worker_id) DO UPDATE SET
            name = excluded.name,
            token_hash = excluded.token_hash,
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

    // Require a valid runner token (hash match) or valid configured fallback shared secret
    if (cleanToken) {
      const tokenHash = hashRunnerToken(cleanToken);
      const row = this.rawDb
        .prepare('SELECT * FROM swarm_workers WHERE token_hash = ?')
        .get(tokenHash) as Record<string, any> | undefined;
      if (row) {
        return { authenticated: true, worker: this.mapRowToWorker(row) };
      }

      if (cleanShared) {
        const tokenBuf = Buffer.from(cleanToken);
        const sharedBuf = Buffer.from(cleanShared);
        if (tokenBuf.length === sharedBuf.length && timingSafeEqual(tokenBuf, sharedBuf)) {
          return { authenticated: true, viaSharedSecret: true };
        }
      }

      return { authenticated: false };
    }

    return { authenticated: false };
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
    const scheduleMode: ScheduleMode = input.scheduleMode ?? 'immediate';
    const requiredLabels = Array.from(
      new Set((input.requiredLabels ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean))
    );
    const model = (input.model ?? 'gemini-3.8-flash').trim();
    const poolFamily = resolvePoolFamilyForModel(model);
    const effort: ReasoningEffort = input.effort ?? 'high';
    const allowOverage = Boolean(input.allowOverage);
    const pushBranch = input.pushBranch !== false;
    const autoCreatePr = input.autoCreatePr !== false;

    this.rawDb
      .prepare(
        `INSERT INTO swarm_tasks (
          id, created_at, updated_at, repository_id, repository_name, repository_path,
          clone_url, default_branch, prompt, requested_by, schedule_mode,
          required_labels_json, model, pool_family, effort, allow_overage, push_branch,
          auto_create_pr, expires_at, standing_task_id, verify_command, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`
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
        scheduleMode,
        JSON.stringify(requiredLabels),
        model,
        poolFamily,
        effort,
        allowOverage ? 1 : 0,
        pushBranch ? 1 : 0,
        autoCreatePr ? 1 : 0,
        input.expiresAt ?? null,
        input.standingTaskId ?? null,
        input.verifyCommand ?? null
      );

    this.pruneOldTasks();
    return this.getTask(id)!;
  }

  public pruneOldTasks(keepTerminalCount = 250): void {
    try {
      this.rawDb
        .prepare(
          `DELETE FROM swarm_tasks
           WHERE status IN ('completed', 'failed', 'aborted')
             AND id NOT IN (
               SELECT id FROM swarm_tasks
               WHERE status IN ('completed', 'failed', 'aborted')
               ORDER BY updated_at DESC
               LIMIT ?
             )`
        )
        .run(keepTerminalCount);
    } catch {
      // Best-effort pruning
    }
  }

  public getTask(id: string): SwarmTask | undefined {
    const row = this.rawDb.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(id) as
      Record<string, any> | undefined;
    return row ? this.mapRowToTask(row) : undefined;
  }

  public listTasks(
    options: {
      status?: TaskStatus;
      scheduleMode?: ScheduleMode;
      limit?: number;
    } = {}
  ): SwarmTask[] {
    const limit = Math.min(Math.max(1, options.limit ?? 50), 500);
    const conditions: string[] = [];
    const params: any[] = [];

    if (options.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }
    if (options.scheduleMode) {
      conditions.push('schedule_mode = ?');
      params.push(options.scheduleMode);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const rows = this.rawDb
      .prepare(
        `SELECT * FROM swarm_tasks ${whereClause} ORDER BY created_at DESC, rowid DESC LIMIT ?`
      )
      .all(...params) as Array<Record<string, any>>;
    return rows.map((r) => this.mapRowToTask(r));
  }

  /**
   * Atomically claims the next eligible queued task for a worker.
   * Evaluates worker enabled state, required labels, repository match,
   * expiration cutoff (pre-reset expiration), and live quota eligibility.
   */
  public claimNext(options: ClaimTaskOptions): SwarmTask | null {
    return this.inTransaction(() => {
      const existingWorker = this.getWorker(options.workerId);
      if (existingWorker && !existingWorker.enabled) {
        this.registerWorkerHeartbeat({
          workerId: options.workerId,
          name: options.workerName,
          labels: options.labels,
          repositories: options.repositories,
          systemInfo: options.systemInfo,
          status: 'idle',
        });
        return null;
      }

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
           ORDER BY created_at ASC, rowid ASC`
        )
        .all() as Array<Record<string, any>>;

      const now = new Date().toISOString();
      const nowEpoch = Date.now();

      for (const row of candidates) {
        const task = this.mapRowToTask(row);

        // Check pre-reset expiration: if expiresAt is set and has passed, abort task immediately
        if (task.expiresAt) {
          const expEpoch = Date.parse(task.expiresAt);
          if (!Number.isNaN(expEpoch) && nowEpoch >= expEpoch) {
            this.rawDb
              .prepare(
                `UPDATE swarm_tasks
                 SET status = 'aborted',
                     error = 'Expired: weekly quota reset window passed',
                     completed_at = ?,
                     updated_at = ?
                 WHERE id = ? AND status = 'queued'`
              )
              .run(now, now, task.id);
            continue;
          }
        }

        // Check required labels (if task specifies labels, worker must have all of them)
        if (task.requiredLabels.length > 0) {
          const hasAllLabels = task.requiredLabels.every((reqLabel) =>
            workerLabelSet.has(reqLabel.toLowerCase())
          );
          if (!hasAllLabels) {
            continue;
          }
        }

        // Check repository capability filter if worker specified a subset
        if (
          repoFilter &&
          !repoFilter.has(task.repositoryId.toLowerCase()) &&
          !repoFilter.has(task.repositoryName.toLowerCase())
        ) {
          continue;
        }

        // Check live quota eligibility
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

    // Guard against status updates on already terminal tasks
    const existingTerminal =
      existing.status === 'completed' ||
      existing.status === 'failed' ||
      existing.status === 'aborted';
    if (existingTerminal) {
      return existing;
    }

    // Guard against cross-worker task status tampering
    if (patch.workerId && existing.workerId && patch.workerId !== existing.workerId) {
      return existing;
    }

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
    const prUrl = patch.prUrl ?? existing.prUrl ?? null;
    const output =
      patch.output !== undefined ? patch.output.slice(0, 16000) : (existing.output ?? null);
    const error = patch.error !== undefined ? patch.error.slice(0, 4000) : (existing.error ?? null);
    const workerId = patch.workerId ?? existing.workerId ?? null;
    const numTurns = patch.numTurns !== undefined ? patch.numTurns : (existing.numTurns ?? null);
    const totalTokens =
      patch.totalTokens !== undefined ? patch.totalTokens : (existing.totalTokens ?? null);
    const thinkingTokens =
      patch.thinkingTokens !== undefined ? patch.thinkingTokens : (existing.thinkingTokens ?? null);

    this.rawDb
      .prepare(
        `UPDATE swarm_tasks
         SET status = ?,
             worker_id = ?,
             branch_name = ?,
             pr_url = ?,
             output = ?,
             error = ?,
             duration_ms = ?,
             num_turns = ?,
             total_tokens = ?,
             thinking_tokens = ?,
             heartbeat_at = ?,
             completed_at = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        patch.status,
        workerId,
        branchName,
        prUrl,
        output,
        error,
        durationMs,
        numTurns,
        totalTokens,
        thinkingTokens,
        now,
        completedAt,
        now,
        taskId
      );

    if (isTerminal) {
      this.pruneOldTasks();
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
  public reapStaleClaims(leaseTimeoutMs = 10 * 60 * 1000, nowMs = Date.now()): SwarmTask[] {
    const activeRows = this.rawDb
      .prepare("SELECT * FROM swarm_tasks WHERE status IN ('claimed', 'executing')")
      .all() as Array<Record<string, any>>;

    const reapedTasks: SwarmTask[] = [];
    for (const row of activeRows) {
      const task = this.mapRowToTask(row);
      const lastBeat = task.heartbeatAt || task.claimedAt || task.updatedAt;
      const beatEpoch = new Date(lastBeat).getTime();
      if (!Number.isNaN(beatEpoch) && nowMs - beatEpoch > leaseTimeoutMs) {
        const updated = this.updateTaskStatus(task.id, {
          status: 'failed',
          error: `Worker lease expired after ${Math.round(leaseTimeoutMs / 1000)}s without heartbeat`,
          durationMs: nowMs - beatEpoch,
        });
        if (updated) reapedTasks.push(updated);
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

    return reapedTasks;
  }

  public registerWorkerHeartbeat(info: {
    workerId: string;
    name?: string;
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
          worker_id, name, labels_json, repositories_json, system_info_json,
          active_task_id, status, registered_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(worker_id) DO UPDATE SET
          name = excluded.name,
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
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      repositoryId: String(row.repository_id),
      repositoryName: String(row.repository_name),
      repositoryPath: String(row.repository_path),
      cloneUrl: row.clone_url ? String(row.clone_url) : undefined,
      defaultBranch: String(row.default_branch || 'main'),
      prompt: String(row.prompt),
      requestedBy: String(row.requested_by || 'web-ui'),
      scheduleMode: (row.schedule_mode as ScheduleMode) || 'immediate',
      requiredLabels,
      model: String(row.model),
      poolFamily: (row.pool_family as QuotaFamily) || 'gemini-argon',
      effort: (row.effort as ReasoningEffort) || 'high',
      allowOverage: row.allow_overage === 1,
      pushBranch: row.push_branch === 1,
      autoCreatePr: row.auto_create_pr !== 0,
      prUrl: row.pr_url ? String(row.pr_url) : undefined,
      expiresAt: row.expires_at ? String(row.expires_at) : undefined,
      standingTaskId: row.standing_task_id ? String(row.standing_task_id) : undefined,
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
      numTurns:
        row.num_turns !== null && row.num_turns !== undefined ? Number(row.num_turns) : undefined,
      totalTokens:
        row.total_tokens !== null && row.total_tokens !== undefined
          ? Number(row.total_tokens)
          : undefined,
      thinkingTokens:
        row.thinking_tokens !== null && row.thinking_tokens !== undefined
          ? Number(row.thinking_tokens)
          : undefined,
    };
  }

  // --- Standing Tasks CRUD Methods ---

  public listStandingTasks(): StandingTaskRecord[] {
    const rows = this.rawDb
      .prepare('SELECT * FROM standing_tasks ORDER BY sort_order ASC, created_at ASC')
      .all() as Array<Record<string, any>>;
    return rows.map((r) => this.mapRowToStandingTask(r));
  }

  public getStandingTask(id: string): StandingTaskRecord | undefined {
    const row = this.rawDb.prepare('SELECT * FROM standing_tasks WHERE id = ?').get(id) as
      Record<string, any> | undefined;
    return row ? this.mapRowToStandingTask(row) : undefined;
  }

  public createStandingTask(input: {
    id?: string;
    title: string;
    prompt: string;
    repositoryId: string;
    model: string;
    effort?: ReasoningEffort;
    verifyCommand?: string;
    autoCreatePr?: boolean;
    enabled?: boolean;
    sortOrder?: number;
    triggerBeforeResetHours?: number;
  }): StandingTaskRecord {
    const id = input.id ?? `standing-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const effort: ReasoningEffort = input.effort ?? 'high';
    const autoCreatePr = input.autoCreatePr !== false ? 1 : 0;
    const enabled = input.enabled !== false ? 1 : 0;
    const sortOrder = input.sortOrder ?? 0;
    const triggerHours = input.triggerBeforeResetHours ?? 2;

    this.rawDb
      .prepare(
        `INSERT INTO standing_tasks (
          id, title, prompt, repository_id, model, effort, verify_command,
          auto_create_pr, enabled, sort_order, trigger_before_reset_hours,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.title.trim(),
        input.prompt.trim(),
        input.repositoryId.trim(),
        input.model.trim(),
        effort,
        input.verifyCommand ?? null,
        autoCreatePr,
        enabled,
        sortOrder,
        triggerHours,
        now,
        now
      );

    return this.getStandingTask(id)!;
  }

  public updateStandingTask(
    id: string,
    patch: Partial<{
      title: string;
      prompt: string;
      repositoryId: string;
      model: string;
      effort: ReasoningEffort;
      verifyCommand: string | null;
      autoCreatePr: boolean;
      enabled: boolean;
      sortOrder: number;
      triggerBeforeResetHours: number;
      lastTriggeredResetTime: string | null;
      lastTaskId: string | null;
    }>
  ): StandingTaskRecord | undefined {
    const existing = this.getStandingTask(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const title = patch.title !== undefined ? patch.title.trim() : existing.title;
    const prompt = patch.prompt !== undefined ? patch.prompt.trim() : existing.prompt;
    const repositoryId =
      patch.repositoryId !== undefined ? patch.repositoryId.trim() : existing.repositoryId;
    const model = patch.model !== undefined ? patch.model.trim() : existing.model;
    const effort = patch.effort !== undefined ? patch.effort : existing.effort;
    const verifyCommand =
      patch.verifyCommand !== undefined ? patch.verifyCommand : (existing.verifyCommand ?? null);
    const autoCreatePr =
      patch.autoCreatePr !== undefined
        ? patch.autoCreatePr
          ? 1
          : 0
        : existing.autoCreatePr
          ? 1
          : 0;
    const enabled =
      patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled ? 1 : 0;
    const sortOrder = patch.sortOrder !== undefined ? patch.sortOrder : existing.sortOrder;
    const triggerHours =
      patch.triggerBeforeResetHours !== undefined
        ? patch.triggerBeforeResetHours
        : existing.triggerBeforeResetHours;
    const lastReset =
      patch.lastTriggeredResetTime !== undefined
        ? patch.lastTriggeredResetTime
        : (existing.lastTriggeredResetTime ?? null);
    const lastTaskId =
      patch.lastTaskId !== undefined ? patch.lastTaskId : (existing.lastTaskId ?? null);

    this.rawDb
      .prepare(
        `UPDATE standing_tasks
         SET title = ?,
             prompt = ?,
             repository_id = ?,
             model = ?,
             effort = ?,
             verify_command = ?,
             auto_create_pr = ?,
             enabled = ?,
             sort_order = ?,
             trigger_before_reset_hours = ?,
             last_triggered_reset_time = ?,
             last_task_id = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        title,
        prompt,
        repositoryId,
        model,
        effort,
        verifyCommand,
        autoCreatePr,
        enabled,
        sortOrder,
        triggerHours,
        lastReset,
        lastTaskId,
        now,
        id
      );

    return this.getStandingTask(id);
  }

  public deleteStandingTask(id: string): boolean {
    const info = this.rawDb
      .prepare('DELETE FROM standing_tasks WHERE id = ?')
      .run(id) as unknown as { changes?: number };
    return (info?.changes ?? 0) > 0;
  }

  private mapRowToStandingTask(r: Record<string, any>): StandingTaskRecord {
    return {
      id: String(r.id),
      title: String(r.title),
      prompt: String(r.prompt),
      repositoryId: String(r.repository_id),
      model: String(r.model),
      effort: (r.effort as ReasoningEffort) || 'high',
      verifyCommand: r.verify_command ? String(r.verify_command) : undefined,
      autoCreatePr: r.auto_create_pr !== 0,
      enabled: r.enabled !== 0,
      sortOrder: Number(r.sort_order ?? 0),
      triggerBeforeResetHours: Number(r.trigger_before_reset_hours ?? 2),
      lastTriggeredResetTime: r.last_triggered_reset_time
        ? String(r.last_triggered_reset_time)
        : undefined,
      lastTaskId: r.last_task_id ? String(r.last_task_id) : undefined,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
}
