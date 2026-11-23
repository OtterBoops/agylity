import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppDatabase } from '../storage/db.js';
import { applyMigrations, SWARM_TASK_COLUMNS } from '../storage/migrations.js';
import type { PoolGroup } from '../sentry/models.js';
import { DEFAULT_QUOTA_BURN_MAX_HOURS } from '../config/schema.js';
import { resolveTaskTitle } from '../shared/titles.js';
import type {
  BacklogTaskRecord,
  PrPolicy,
  RoutineTaskRecord,
  RunnerRegistrationTokenResult,
  RunnerSystemInfo,
  SwarmRunnerRecord,
  SwarmTask,
} from '../shared/contracts.js';
import {
  BacklogStatusSchema,
  normalizeCascade,
  resolvePoolGroupForModel,
  resolveReasoningEffortForModel,
  type BacklogStatus,
  type CascadeHop,
  type ReasoningEffort,
  type ScheduleMode,
  type TaskStatus,
  type TaskTier,
  TERMINAL_TASK_STATUSES,
  isTerminalTaskStatus,
} from './models.js';

export type { TaskTier, BacklogStatus };

// The queue writes rows and returns them; the payload shapes belong to the shared wire contracts so
// the dashboard reads the same declaration.
export type {
  BacklogTaskRecord,
  RoutineTaskRecord,
  RunnerRegistrationTokenResult,
  RunnerSystemInfo,
  SwarmRunnerRecord,
  SwarmTask,
};

export interface EnqueueTaskInput {
  id?: string;
  taskNumber?: number;
  title?: string;
  tier?: TaskTier;
  originId?: string;
  originNumber?: number;
  originTitle?: string;
  repositoryId?: string;
  repositoryName: string;
  repositoryPath?: string;
  cloneUrl?: string;
  defaultBranch?: string;
  prompt: string;
  requestedBy?: string;
  prPolicy?: PrPolicy;
  scheduleMode?: ScheduleMode;
  requiredLabels?: string[];
  cascade?: readonly CascadeHop[];
  allowOverage?: boolean;
  pushBranch?: boolean;
  autoCreatePr?: boolean;
  expiresAt?: string;
  verifyCommand?: string;
}

export interface ClaimTaskOptions {
  runnerId: string;
  runnerName?: string;
  labels?: string[];
  repositories?: string[];
  systemInfo?: RunnerSystemInfo;
  eligibilityCheck?: (task: SwarmTask) => { allowed: boolean; resolvedModel?: string };
}

export interface TaskStatusPatch {
  status: TaskStatus;
  runnerId?: string;
  /** `null` clears the column: a discarded branch has no name to report. */
  branchName?: string | null;
  prUrl?: string;
  issueUrls?: string[];
  /** Settles the row's title when the run's deliverable names it better than the dispatch did. */
  title?: string;
  output?: string;
  error?: string;
  durationMs?: number;
  numTurns?: number;
  totalTokens?: number;
  thinkingTokens?: number;
}

export interface TaskListFilters {
  status?: TaskStatus;
  scheduleMode?: ScheduleMode;
  q?: string;
  taskNumber?: number;
}

export interface TaskListOptions extends TaskListFilters {
  limit?: number;
  offset?: number;
}

export interface CreateRegistrationTokenInput {
  nameHint?: string;
  labels?: string[];
  repositories?: string[];
  ttlMs?: number;
}

export interface ExchangeRegistrationTokenInput {
  registrationToken: string;
  runnerId?: string;
  runnerName?: string;
  labels?: string[];
  repositories?: string[];
  systemInfo?: RunnerSystemInfo;
}

export const hashRunnerToken = (token: string): string =>
  createHash('sha256').update(token.trim()).digest('hex');

const TASK_LIST_COLUMNS = SWARM_TASK_COLUMNS.filter((column) => column.name !== 'output')
  .map((column) => column.name)
  .join(', ');

export const OUTPUT_CAP = 512 * 1024;

/** The last `cap` UTF-16 units, nudged off a surrogate pair so the head never renders as U+FFFD. */
export const tailWindow = (text: string, cap: number): string => {
  let start = Math.max(0, text.length - cap);
  if (start > 0) {
    const code = text.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) start -= 1;
  }
  return text.slice(start);
};

/** Keeps the tail, which is where a failure explains itself, and says how much was dropped. */
export const capOutput = (text: string, cap: number = OUTPUT_CAP): string => {
  if (text.length <= cap) return text;
  const kept = tailWindow(text, cap);
  return `[truncated ${text.length - kept.length} characters]\n${kept}`;
};

const REGISTRATION_TOKEN_RETENTION = 50;

const TERMINAL_STATUS_SQL = TERMINAL_TASK_STATUSES.map((s) => `'${s}'`).join(', ');

/** The queue cannot read config, so an unconfigured cascade falls back to this catalog-wide model. */
const QUEUE_DEFAULT_DISPATCH_MODEL = 'gemini-4-hydrogen';

const coerceCascade = (value: unknown, fallbackModel?: string): CascadeHop[] =>
  normalizeCascade(value, fallbackModel ?? QUEUE_DEFAULT_DISPATCH_MODEL);

const coerceNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const coerceNullableNumber = (value: unknown, fallback: number | null): number | null => {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fallback;
};

const coerceBacklogStatus = (value: unknown, fallback: BacklogStatus): BacklogStatus => {
  if (value === undefined) return fallback;
  const parsed = BacklogStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
};

// An explicit null clears the column; an omitted key keeps it, so the two must not collapse.
const coerceNullableString = (value: unknown, fallback: string | null): string | null => {
  if (value === null) return null;
  return typeof value === 'string' ? value : fallback;
};

const coerceTrimmedString = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
};

const parseIssueUrls = (raw: unknown): string[] | undefined => {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const urls = parsed.filter(
      (entry): entry is string => typeof entry === 'string' && entry !== ''
    );
    return urls.length > 0 ? urls : undefined;
  } catch {
    return undefined;
  }
};

const parseCycleMap = (raw: unknown): Record<string, string> => {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim() !== '') {
        map[key] = value;
      }
    }
    return map;
  } catch {
    return {};
  }
};

export class RegistrationTokenError extends Error {}

export class TaskQueue {
  private readonly rawDb: DatabaseSync;

  constructor(database: AppDatabase) {
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
      } catch {}
      throw err;
    }
  }

  private initSchema(): void {
    applyMigrations(this.rawDb);
  }

  public getRuntimeValue(key: string): string | undefined {
    const row = this.rawDb.prepare('SELECT value FROM runtime_state WHERE key = ?').get(key) as
      { value?: string } | undefined;
    return row?.value ?? undefined;
  }

  public setRuntimeValue(key: string, value: string): void {
    this.rawDb
      .prepare(
        `INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, new Date().toISOString());
  }

  // One-time registration token: plaintext is returned once, only its SHA-256 hash is persisted.
  public createRegistrationToken(
    input: CreateRegistrationTokenInput = {}
  ): RunnerRegistrationTokenResult {
    const id = `reg-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const registrationToken = `agyr_reg_${randomBytes(24).toString('hex')}`;
    const tokenHash = hashRunnerToken(registrationToken);
    const now = new Date();
    const ttlMs = Math.max(60_000, input.ttlMs ?? 60 * 60 * 1000);
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

    this.pruneRegistrationTokens();

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

  public pruneRegistrationTokens(keepCount = REGISTRATION_TOKEN_RETENTION): void {
    try {
      const now = new Date().toISOString();
      this.rawDb
        .prepare(
          `DELETE FROM swarm_runner_registrations
           WHERE (consumed_by_runner_id IS NOT NULL OR expires_at <= ?)
             AND id NOT IN (
               SELECT id FROM swarm_runner_registrations
               WHERE consumed_by_runner_id IS NOT NULL OR expires_at <= ?
               ORDER BY created_at DESC, rowid DESC
               LIMIT ?
             )`
        )
        .run(now, now, keepCount);
    } catch {}
  }

  public exchangeRegistrationToken(
    input: ExchangeRegistrationTokenInput,
    nowMs = Date.now()
  ): { runner: SwarmRunnerRecord; runnerToken: string } {
    return this.inTransaction(() => {
      const rawToken = input.registrationToken?.trim();
      if (!rawToken) {
        throw new RegistrationTokenError('Registration token is required');
      }

      const tokenHash = hashRunnerToken(rawToken);
      const regRow = this.rawDb
        .prepare('SELECT * FROM swarm_runner_registrations WHERE token_hash = ?')
        .get(tokenHash) as Record<string, any> | undefined;

      if (!regRow) {
        throw new RegistrationTokenError('Invalid runner registration token');
      }

      if (regRow.consumed_at) {
        throw new RegistrationTokenError('Runner registration token has already been used');
      }

      const expiresEpoch = new Date(String(regRow.expires_at)).getTime();
      if (Number.isNaN(expiresEpoch) || nowMs > expiresEpoch) {
        throw new RegistrationTokenError('Runner registration token has expired');
      }

      let defaultLabels: string[] = [];
      let defaultRepos: string[] = [];
      try {
        defaultLabels = JSON.parse(String(regRow.labels_json || '[]'));
      } catch {}
      try {
        defaultRepos = JSON.parse(String(regRow.repositories_json || '[]'));
      } catch {}

      const runnerId = input.runnerId?.trim() || `runner-${randomBytes(4).toString('hex')}`;
      const existingRunner = this.getRunner(runnerId);
      // Re-registering must not undo a pause an operator set deliberately.
      if (existingRunner && !existingRunner.enabled) {
        throw new RegistrationTokenError(
          `Runner "${runnerId}" is disabled; re-enable it before registering again`
        );
      }
      const runnerName =
        input.runnerName?.trim() ||
        (regRow.name_hint ? String(regRow.name_hint) : undefined) ||
        runnerId;
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

      // Issued, not spent: consumed_at stays null until the runner authenticates, so a runner that
      // crashed before persisting runner.json can exchange the same token again.
      this.rawDb
        .prepare(
          `UPDATE swarm_runner_registrations
           SET consumed_by_runner_id = ?
           WHERE id = ?`
        )
        .run(runnerId, String(regRow.id));

      this.rawDb
        .prepare(
          `INSERT INTO swarm_runners (
            runner_id, name, token_hash, labels_json, repositories_json,
            system_info_json, enabled, active_task_id, status, registered_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, 'idle', ?, ?)
          ON CONFLICT(runner_id) DO UPDATE SET
            name = excluded.name,
            token_hash = excluded.token_hash,
            labels_json = excluded.labels_json,
            repositories_json = excluded.repositories_json,
            system_info_json = excluded.system_info_json,
            status = 'idle',
            last_seen_at = excluded.last_seen_at`
        )
        .run(
          runnerId,
          runnerName,
          runnerTokenHash,
          JSON.stringify(labels),
          JSON.stringify(repositories),
          JSON.stringify(systemInfo),
          nowIso,
          nowIso
        );

      return {
        runner: this.getRunner(runnerId)!,
        runnerToken,
      };
    });
  }

  public markRegistrationTokenUsed(runnerId: string, nowMs = Date.now()): void {
    this.rawDb
      .prepare(
        `UPDATE swarm_runner_registrations
         SET consumed_at = ?
         WHERE consumed_by_runner_id = ? AND consumed_at IS NULL`
      )
      .run(new Date(nowMs).toISOString(), runnerId);
  }

  public authenticateRunner(
    providedToken: string | undefined,
    fallbackSharedSecret?: string
  ): { authenticated: boolean; runner?: SwarmRunnerRecord; viaSharedSecret?: boolean } {
    const cleanToken = providedToken?.trim() || '';
    const cleanShared = fallbackSharedSecret?.trim() || '';

    if (cleanToken) {
      const tokenHash = hashRunnerToken(cleanToken);
      const row = this.rawDb
        .prepare('SELECT * FROM swarm_runners WHERE token_hash = ?')
        .get(tokenHash) as Record<string, any> | undefined;
      if (row) {
        return { authenticated: true, runner: this.mapRowToRunner(row) };
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

  public getRunner(runnerId: string): SwarmRunnerRecord | undefined {
    const row = this.rawDb
      .prepare('SELECT * FROM swarm_runners WHERE runner_id = ?')
      .get(runnerId) as Record<string, any> | undefined;
    return row ? this.mapRowToRunner(row) : undefined;
  }

  public setRunnerEnabled(runnerId: string, enabled: boolean): SwarmRunnerRecord | undefined {
    const existing = this.getRunner(runnerId);
    if (!existing) return undefined;

    this.rawDb
      .prepare('UPDATE swarm_runners SET enabled = ? WHERE runner_id = ?')
      .run(enabled ? 1 : 0, runnerId);

    return this.getRunner(runnerId);
  }

  public revokeRunner(runnerId: string): boolean {
    return this.inTransaction(() => {
      const existing = this.getRunner(runnerId);
      if (!existing) return false;

      const now = new Date().toISOString();
      this.rawDb
        .prepare(
          `UPDATE swarm_tasks
           SET status = 'queued',
               runner_id = NULL,
               claimed_at = NULL,
               heartbeat_at = NULL,
               updated_at = ?
           WHERE runner_id = ? AND status IN ('claimed', 'executing')`
        )
        .run(now, runnerId);

      this.rawDb.prepare('DELETE FROM swarm_runners WHERE runner_id = ?').run(runnerId);
      return true;
    });
  }

  public enqueue(input: EnqueueTaskInput): SwarmTask {
    const id = input.id ?? `task-${Date.now()}-${randomBytes(3).toString('hex')}`;
    this.inTransaction(() => this.insertTaskRow(id, input));
    this.pruneOldTasks();
    return this.getTask(id)!;
  }

  // A tier that must also settle its origin row commits both writes here, because a crash between
  // them strands the origin and wedges the tier behind a run nothing will ever settle.
  public spawnBacklogTask(
    input: EnqueueTaskInput,
    origin: { id: string; attemptCount: number }
  ): SwarmTask {
    const id = input.id ?? `task-${Date.now()}-${randomBytes(3).toString('hex')}`;
    this.inTransaction(() => {
      this.insertTaskRow(id, input);
      const settled = this.rawDb
        .prepare(
          `UPDATE backlog_tasks
           SET status = 'dispatched', attempt_count = ?, swarm_task_id = ?, last_error = NULL,
               updated_at = ?
           WHERE id = ?`
        )
        .run(origin.attemptCount, id, new Date().toISOString(), origin.id) as unknown as {
        changes?: number;
      };
      // Neither write may land alone, so a vanished origin rolls the task insert back with it.
      if ((settled?.changes ?? 0) === 0) {
        throw new Error(`Backlog origin ${origin.id} no longer exists`);
      }
    });
    this.pruneOldTasks();
    return this.getTask(id)!;
  }

  // Assumes the caller holds the write transaction, so a spawn can add its own origin write to it.
  private insertTaskRow(id: string, input: EnqueueTaskInput): void {
    const now = new Date().toISOString();
    const repoId = (input.repositoryId || input.repositoryName).trim();
    const repoName = input.repositoryName.trim();
    const repoPath = (input.repositoryPath || `/repos/${repoId}`).trim();
    const defaultBranch = (input.defaultBranch || 'main').trim();
    const prompt = input.prompt.slice(0, 20000);
    const requestedBy = (input.requestedBy || 'web-ui').trim();
    const prPolicy = input.prPolicy ?? 'inherit';
    const scheduleMode: ScheduleMode = input.scheduleMode ?? 'immediate';
    const requiredLabels = Array.from(
      new Set((input.requiredLabels ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean))
    );
    const cascade = coerceCascade(input.cascade);
    const primaryHop = cascade[0]!;
    const model = primaryHop.model;
    const poolGroup = resolvePoolGroupForModel(model);
    const effort: ReasoningEffort = primaryHop.effort;
    const allowOverage = Boolean(input.allowOverage);
    const pushBranch = input.pushBranch !== false;
    const autoCreatePr = input.autoCreatePr !== false;

    const title = resolveTaskTitle(input.title, prompt);
    const tier: TaskTier = input.tier ?? 'immediate';
    const originId = input.originId ?? null;
    const originNumber = input.originNumber ?? null;
    const originTitle = input.originTitle ?? null;

    // Two concurrent enqueues must never pick the same number, so the max read and the insert share
    // one write transaction.
    const maxNumberRow = this.rawDb
      .prepare('SELECT MAX(task_number) as max_num FROM swarm_tasks')
      .get() as { max_num?: number } | undefined;
    const taskNumber = input.taskNumber ?? (maxNumberRow?.max_num ?? 0) + 1;
    this.rawDb
      .prepare(
        `INSERT INTO swarm_tasks (
        id, task_number, title, tier, origin_id, origin_number, origin_title,
        created_at, updated_at, repository_id, repository_name, repository_path,
        clone_url, default_branch, prompt, requested_by, pr_policy, schedule_mode,
        required_labels_json, model, candidate_models_json, pool_group, effort, allow_overage,
        push_branch, auto_create_pr, expires_at, verify_command, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`
      )
      .run(
        id,
        taskNumber,
        title,
        tier,
        originId,
        originNumber,
        originTitle,
        now,
        now,
        repoId,
        repoName,
        repoPath,
        input.cloneUrl ?? null,
        defaultBranch,
        prompt,
        requestedBy,
        prPolicy,
        scheduleMode,
        JSON.stringify(requiredLabels),
        model,
        JSON.stringify(cascade),
        poolGroup,
        effort,
        allowOverage ? 1 : 0,
        pushBranch ? 1 : 0,
        autoCreatePr ? 1 : 0,
        input.expiresAt ?? null,
        input.verifyCommand ?? null
      );
  }

  public pruneOldTasks(keepTerminalCount = 250): void {
    try {
      this.rawDb
        .prepare(
          `DELETE FROM swarm_tasks
           WHERE status IN (${TERMINAL_STATUS_SQL})
             AND id NOT IN (
               SELECT id FROM swarm_tasks
               WHERE status IN (${TERMINAL_STATUS_SQL})
               ORDER BY updated_at DESC
               LIMIT ?
             )
             -- The terminal row is the reconciler's proof its backlog origin ran; dropping it re-dispatches work.
             AND NOT (
               tier = 'backlog'
               AND origin_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM backlog_tasks AS b
                 WHERE b.id = swarm_tasks.origin_id AND b.status = 'dispatched'
               )
             )`
        )
        .run(keepTerminalCount);
    } catch {}
  }

  public pruneOldRunners(maxOfflineAgeMs = 10 * 60 * 1000): void {
    try {
      const cutoff = new Date(Date.now() - maxOfflineAgeMs).toISOString();
      this.rawDb
        .prepare(
          "DELETE FROM swarm_runners WHERE status = 'offline' AND token_hash IS NULL AND last_seen_at < ?"
        )
        .run(cutoff);
    } catch {}
  }

  public getTask(id: string): SwarmTask | undefined {
    const row = this.rawDb.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(id) as
      Record<string, any> | undefined;
    return row ? this.mapRowToTask(row) : undefined;
  }

  public getLatestTaskForOrigin(originId: string, poolGroup?: string): SwarmTask | undefined {
    const row = poolGroup
      ? (this.rawDb
          .prepare(
            `SELECT * FROM swarm_tasks
             WHERE origin_id = ? AND pool_group = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT 1`
          )
          .get(originId, poolGroup) as Record<string, any> | undefined)
      : (this.rawDb
          .prepare(
            `SELECT * FROM swarm_tasks
             WHERE origin_id = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT 1`
          )
          .get(originId) as Record<string, any> | undefined);
    return row ? this.mapRowToTask(row) : undefined;
  }

  public hasActiveTaskForOrigin(originId: string): boolean {
    const row = this.rawDb
      .prepare(
        `SELECT 1 AS active FROM swarm_tasks
         WHERE origin_id = ? AND status NOT IN (${TERMINAL_STATUS_SQL})
         LIMIT 1`
      )
      .get(originId) as { active?: number } | undefined;
    return row?.active === 1;
  }

  // Counted over the same terminal set the reconciler settles on so an inline status list can never drift.
  public countActiveBacklogTasks(): number {
    const row = this.rawDb
      .prepare(
        `SELECT COUNT(*) AS active FROM swarm_tasks
         WHERE tier = 'backlog' AND status NOT IN (${TERMINAL_STATUS_SQL})`
      )
      .get() as { active?: number } | undefined;
    return Number(row?.active ?? 0);
  }

  public listActiveBacklogTasks(): SwarmTask[] {
    const rows = this.rawDb
      .prepare(
        `SELECT * FROM swarm_tasks
         WHERE tier = 'backlog' AND status NOT IN (${TERMINAL_STATUS_SQL})`
      )
      .all() as Array<Record<string, any>>;
    return rows.map((row) => this.mapRowToTask(row));
  }

  // `q` is a LIKE term: `%%` would match every row and a stray `_` would silently widen a wildcard,
  // so the three metacharacters are escaped.
  private static escapeLikeTerm(term: string): string {
    return term.replace(/[\\%_]/g, (char) => `\\${char}`);
  }

  private buildTaskFilter(options: TaskListFilters): { whereClause: string; params: any[] } {
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
    if (options.taskNumber !== undefined && Number.isFinite(options.taskNumber)) {
      conditions.push('task_number = ?');
      params.push(Math.trunc(options.taskNumber));
    }

    const term = options.q?.trim();
    if (term) {
      const pattern = `%${TaskQueue.escapeLikeTerm(term)}%`;
      conditions.push(
        "(title LIKE ? ESCAPE '\\' OR repository_name LIKE ? ESCAPE '\\' OR origin_title LIKE ? ESCAPE '\\')"
      );
      params.push(pattern, pattern, pattern);
    }

    return {
      whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
      params,
    };
  }

  public listTasks(options: TaskListOptions = {}): SwarmTask[] {
    const requestedLimit = options.limit ?? 50;
    const limit = Math.min(
      Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 50),
      500
    );
    const requestedOffset = options.offset ?? 0;
    const offset = Math.max(0, Number.isFinite(requestedOffset) ? Math.floor(requestedOffset) : 0);
    const { whereClause, params } = this.buildTaskFilter(options);

    const rows = this.rawDb
      .prepare(
        `SELECT ${TASK_LIST_COLUMNS} FROM swarm_tasks ${whereClause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Array<Record<string, any>>;
    return rows.map((r) => this.mapRowToTask(r));
  }

  public countTasks(options: TaskListFilters = {}): number {
    const { whereClause, params } = this.buildTaskFilter(options);
    const row = this.rawDb
      .prepare(`SELECT COUNT(*) AS c FROM swarm_tasks ${whereClause}`)
      .get(...params) as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  }

  public claimNext(options: ClaimTaskOptions): SwarmTask | null {
    return this.inTransaction(() => {
      const existingRunner = this.getRunner(options.runnerId);
      // A non-empty registration narrows the poll payload; an empty one declares no restriction.
      const registeredLabels = existingRunner?.labels ?? [];
      const effectiveLabels =
        registeredLabels.length > 0 ? registeredLabels : (options.labels ?? []);
      const runnerLabelSet = new Set(effectiveLabels.map((l) => l.toLowerCase()));

      const registeredRepos = existingRunner?.repositories ?? [];
      const effectiveRepos =
        registeredRepos.length > 0 ? registeredRepos : (options.repositories ?? []);
      // A registered runner keeps its stored identity; only an ad-hoc runner adopts the poll payload.
      const persistedLabels = existingRunner ? registeredLabels : effectiveLabels;
      const persistedRepos = existingRunner ? registeredRepos : effectiveRepos;
      if (existingRunner && !existingRunner.enabled) {
        this.registerRunnerHeartbeat({
          runnerId: options.runnerId,
          name: options.runnerName,
          labels: persistedLabels,
          repositories: persistedRepos,
          systemInfo: options.systemInfo,
          status: 'idle',
        });
        return null;
      }

      // One active task per runner: a second claim would overwrite active_task_id and leave the
      // first task's lease to expire with no one executing it.
      if (existingRunner?.activeTaskId) {
        const activeTask = this.getTask(existingRunner.activeTaskId);
        if (activeTask && (activeTask.status === 'claimed' || activeTask.status === 'executing')) {
          return null;
        }
        // A finished or vanished task leaves a stale pointer behind; clearing it is what lets a
        // runner whose final status report was lost ever claim again.
        this.registerRunnerHeartbeat({
          runnerId: options.runnerId,
          name: options.runnerName,
          labels: persistedLabels,
          repositories: persistedRepos,
          systemInfo: options.systemInfo,
          status: 'idle',
        });
      }

      const repoFilter =
        effectiveRepos.length > 0 ? new Set(effectiveRepos.map((r) => r.toLowerCase())) : null;

      const candidates = this.rawDb
        .prepare(
          `SELECT * FROM swarm_tasks
           WHERE status = 'queued'
           ORDER BY created_at ASC, rowid ASC`
        )
        .all() as Array<Record<string, any>>;

      const activeOrigins = new Set(
        (
          this.rawDb
            .prepare(
              `SELECT DISTINCT origin_id FROM swarm_tasks
               WHERE origin_id IS NOT NULL AND status IN ('claimed', 'executing')`
            )
            .all() as Array<{ origin_id: string }>
        ).map((row) => row.origin_id)
      );

      const now = new Date().toISOString();
      const nowEpoch = Date.now();

      for (const row of candidates) {
        const task = this.mapRowToTask(row);

        if (task.expiresAt) {
          const expEpoch = Date.parse(task.expiresAt);
          if (!Number.isNaN(expEpoch) && nowEpoch >= expEpoch) {
            this.expireQueuedTask(task, now);
            continue;
          }
        }

        // Serialize stacked runs of the same origin (e.g. a routine triggered multiple times):
        // at most one claimed/executing task per origin_id at a time so concurrent runners do not
        // duplicate the same investigation from the same base commit.
        if (task.originId && activeOrigins.has(task.originId)) {
          continue;
        }

        if (task.requiredLabels.length > 0) {
          const hasAllLabels = task.requiredLabels.every((reqLabel) =>
            runnerLabelSet.has(reqLabel.toLowerCase())
          );
          if (!hasAllLabels) {
            continue;
          }
        }

        if (
          repoFilter &&
          !repoFilter.has(task.repositoryId.toLowerCase()) &&
          !repoFilter.has(task.repositoryName.toLowerCase())
        ) {
          continue;
        }

        let updatedModel = task.model;
        let updatedEffort = task.effort;
        if (options.eligibilityCheck) {
          const check = options.eligibilityCheck(task);
          if (!check.allowed) {
            continue;
          }
          if (check.resolvedModel) {
            updatedModel = check.resolvedModel;
            const hop = task.cascade.find((candidate) => candidate.model === updatedModel);
            updatedEffort =
              hop?.effort ?? resolveReasoningEffortForModel(updatedModel, task.effort);
          }
        }
        const claimCascade: CascadeHop[] = [
          { model: updatedModel, effort: updatedEffort },
          ...task.cascade.filter((candidate) => candidate.model !== updatedModel),
        ];

        const updateResult = this.rawDb
          .prepare(
            `UPDATE swarm_tasks
             SET status = 'claimed',
                 runner_id = ?,
                 model = ?,
                 candidate_models_json = ?,
                 pool_group = ?,
                 effort = ?,
                 claimed_at = ?,
                 heartbeat_at = ?,
                 updated_at = ?
             WHERE id = ? AND status = 'queued'`
          )
          .run(
            options.runnerId,
            updatedModel,
            JSON.stringify(claimCascade),
            resolvePoolGroupForModel(updatedModel),
            updatedEffort,
            now,
            now,
            now,
            task.id
          ) as unknown as { changes?: number };

        if ((updateResult?.changes ?? 0) > 0) {
          this.registerRunnerHeartbeat({
            runnerId: options.runnerId,
            name: options.runnerName,
            labels: persistedLabels,
            repositories: persistedRepos,
            systemInfo: options.systemInfo,
            activeTaskId: task.id,
            status: 'busy',
          });
          return this.getTask(task.id) ?? null;
        }
      }

      this.registerRunnerHeartbeat({
        runnerId: options.runnerId,
        name: options.runnerName,
        labels: persistedLabels,
        repositories: persistedRepos,
        systemInfo: options.systemInfo,
        status: 'idle',
      });

      return null;
    });
  }

  public updateTaskStatus(
    taskId: string,
    patch: TaskStatusPatch,
    options: { preserveRunnerLastSeen?: boolean } = {}
  ): { task: SwarmTask; applied: boolean } | undefined {
    const existing = this.getTask(taskId);
    if (!existing) return undefined;

    const refused = { task: existing, applied: false };

    const existingTerminal = isTerminalTaskStatus(existing.status);
    if (existingTerminal) {
      return refused;
    }

    const patchIsActive = patch.status === 'claimed' || patch.status === 'executing';
    if (patchIsActive && existing.status === 'queued') {
      return refused;
    }

    // An external report claims ownership: a runner may only touch the task it was given.
    if (patch.runnerId && existing.runnerId !== patch.runnerId) return refused;

    const now = new Date().toISOString();
    const isTerminal = isTerminalTaskStatus(patch.status);
    const completedAt = isTerminal ? now : (existing.completedAt ?? null);
    const elapsedMs = existing.claimedAt
      ? Date.now() - new Date(existing.claimedAt).getTime()
      : Number.NaN;
    const durationMs =
      patch.durationMs !== undefined
        ? Math.max(0, Math.round(patch.durationMs))
        : existing.claimedAt && isTerminal && Number.isFinite(elapsedMs)
          ? Math.max(0, elapsedMs)
          : existing.durationMs;

    const branchName =
      patch.branchName === null ? null : (patch.branchName ?? existing.branchName ?? null);
    // A blank title never erases one: only a non-empty settled title replaces the stored title.
    const title = patch.title?.trim()
      ? resolveTaskTitle(patch.title, existing.prompt)
      : existing.title;
    const prUrl = patch.prUrl ?? existing.prUrl ?? null;
    // The column is NOT NULL DEFAULT '[]', so "no issues" is an empty array, never NULL.
    const issueUrlsJson =
      patch.issueUrls !== undefined
        ? JSON.stringify(patch.issueUrls)
        : existing.issueUrls
          ? JSON.stringify(existing.issueUrls)
          : '[]';
    const output = patch.output !== undefined ? capOutput(patch.output) : (existing.output ?? null);
    const error = patch.error !== undefined ? patch.error.slice(0, 4000) : (existing.error ?? null);
    const runnerId = patch.runnerId ?? existing.runnerId ?? null;
    const numTurns = patch.numTurns !== undefined ? patch.numTurns : (existing.numTurns ?? null);
    const totalTokens =
      patch.totalTokens !== undefined ? patch.totalTokens : (existing.totalTokens ?? null);
    const thinkingTokens =
      patch.thinkingTokens !== undefined ? patch.thinkingTokens : (existing.thinkingTokens ?? null);

    // Internal settlement (cancel, reaper) carries no runner id and may settle any task; a runner
    // report must match runner_id, so a queued task is only ever settled by the coordinator itself.
    const ownershipClause = patch.runnerId ? 'AND runner_id = ?' : '';
    const ownershipParams = patch.runnerId ? [patch.runnerId] : [];

    // Ownership and the queued->active guard sit in the predicate so the check and write are atomic.
    const updateResult = this.rawDb
      .prepare(
        `UPDATE swarm_tasks
         SET status = ?,
             runner_id = ?,
             title = ?,
             branch_name = ?,
             pr_url = ?,
             issue_urls_json = ?,
             output = ?,
             error = ?,
             duration_ms = ?,
             num_turns = ?,
             total_tokens = ?,
             thinking_tokens = ?,
             heartbeat_at = ?,
             completed_at = ?,
             updated_at = ?
         WHERE id = ?
           ${ownershipClause}
           AND NOT (status = 'queued' AND ? IN ('claimed', 'executing'))`
      )
      .run(
        patch.status,
        runnerId,
        title,
        branchName,
        prUrl,
        issueUrlsJson,
        output,
        error,
        durationMs,
        numTurns,
        totalTokens,
        thinkingTokens,
        now,
        completedAt,
        now,
        taskId,
        ...ownershipParams,
        patch.status
      ) as unknown as { changes?: number };

    if ((updateResult?.changes ?? 0) === 0) {
      return { task: this.getTask(taskId) ?? existing, applied: false };
    }

    if (isTerminal) {
      this.pruneOldTasks();
    }

    if (runnerId && this.getRunner(runnerId)) {
      this.registerRunnerHeartbeat(
        {
          runnerId,
          activeTaskId: isTerminal ? null : taskId,
          status: isTerminal ? 'idle' : 'busy',
        },
        { touchLastSeen: !options.preserveRunnerLastSeen }
      );
    }

    return { task: this.getTask(taskId) ?? existing, applied: true };
  }

  public heartbeatTask(
    taskId: string,
    runnerId: string,
    leaseDurationMs?: number,
    outputTail?: string
  ): { task: SwarmTask; applied: boolean } | undefined {
    const existing = this.getTask(taskId);
    if (!existing) return undefined;

    if (existing.status !== 'claimed' && existing.status !== 'executing') {
      return { task: existing, applied: false };
    }
    if (existing.runnerId !== undefined && existing.runnerId !== runnerId) {
      return { task: existing, applied: false };
    }

    const lastBeatMs = Date.parse(existing.heartbeatAt ?? existing.claimedAt ?? existing.updatedAt);
    if (
      leaseDurationMs !== undefined &&
      leaseDurationMs > 0 &&
      !Number.isNaN(lastBeatMs) &&
      Date.now() - lastBeatMs > leaseDurationMs
    ) {
      return { task: existing, applied: false };
    }

    const now = new Date().toISOString();
    const tail = outputTail && outputTail.length > 0 ? tailWindow(outputTail, 16384) : undefined;
    const updateResult = this.rawDb
      .prepare(
        `UPDATE swarm_tasks
         SET heartbeat_at = ?,
             output = COALESCE(?, output),
             updated_at = ?
         WHERE id = ? AND status IN ('claimed', 'executing')`
      )
      .run(now, tail ?? null, now, taskId) as unknown as { changes?: number };

    if ((updateResult?.changes ?? 0) === 0) {
      return { task: this.getTask(taskId) ?? existing, applied: false };
    }

    this.registerRunnerHeartbeat({ runnerId, activeTaskId: taskId, status: 'busy' });
    return { task: this.getTask(taskId) ?? existing, applied: true };
  }

  // A queued row is settled by the coordinator alone, so the runner that never received it is not
  // blamed and an unclaimed backlog origin returns to pending without burning a retry it never used.
  private expireQueuedTask(task: SwarmTask, now: string): boolean {
    // A pre-reset or routine task expires with the reset window it was queued for; a backlog or
    // immediate task expires because no runner claimed it. The two tell the operator different things.
    const resetWindowExpired = task.scheduleMode === 'pre_reset' || task.tier === 'routine';
    const error = resetWindowExpired
      ? 'Expired: weekly quota reset window passed'
      : 'Expired: no runner claimed the task within its queue window';

    const result = this.rawDb
      .prepare(
        `UPDATE swarm_tasks
         SET status = 'aborted', error = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`
      )
      .run(error, now, now, task.id) as unknown as { changes?: number };
    if ((result?.changes ?? 0) === 0) return false;

    if (!task.originId || task.claimedAt) return true;
    const origin = this.getBacklogTask(task.originId);
    if (!origin || origin.status !== 'dispatched' || origin.swarmTaskId !== task.id) return true;
    this.rawDb
      .prepare(
        `UPDATE backlog_tasks
         SET status = 'pending', attempt_count = ?, swarm_task_id = NULL, last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(Math.max(0, origin.attemptCount - 1), error, now, origin.id);
    return true;
  }

  // The claim path expires lazily, which never runs when no runner polls at all; this sweep is what
  // stops an offline runner or a pool dip from wedging the backlog tier indefinitely.
  public reapExpiredQueuedTasks(nowMs = Date.now()): SwarmTask[] {
    const rows = this.rawDb
      .prepare("SELECT * FROM swarm_tasks WHERE status = 'queued' AND expires_at IS NOT NULL")
      .all() as Array<Record<string, any>>;

    const now = new Date(nowMs).toISOString();
    const expired: SwarmTask[] = [];
    for (const row of rows) {
      const task = this.mapRowToTask(row);
      const expEpoch = task.expiresAt ? Date.parse(task.expiresAt) : NaN;
      if (Number.isNaN(expEpoch) || nowMs < expEpoch) continue;
      if (this.expireQueuedTask(task, now)) {
        const reaped = this.getTask(task.id);
        if (reaped) expired.push(reaped);
      }
    }
    return expired;
  }

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
        const claimedEpoch = task.claimedAt ? new Date(task.claimedAt).getTime() : NaN;
        const durationMs = Number.isNaN(claimedEpoch) ? nowMs - beatEpoch : nowMs - claimedEpoch;
        const updated = this.updateTaskStatus(
          task.id,
          {
            status: 'failed',
            error: `Runner lease expired after ${Math.round(leaseTimeoutMs / 1000)}s without heartbeat`,
            durationMs: Math.max(0, durationMs),
          },
          // The reaper must not refresh last_seen_at, or the offline sweep below misses the dead runner.
          { preserveRunnerLastSeen: true }
        );
        if (updated?.applied) reapedTasks.push(updated.task);
      }
    }

    const runnerOfflineThresholdMs = Math.min(leaseTimeoutMs, 2 * 60 * 1000);
    const runnerRows = this.rawDb
      .prepare("SELECT * FROM swarm_runners WHERE status != 'offline'")
      .all() as Array<Record<string, any>>;
    for (const w of runnerRows) {
      const seenEpoch = new Date(String(w.last_seen_at)).getTime();
      const threshold = w.status === 'busy' ? leaseTimeoutMs : runnerOfflineThresholdMs;
      if (!Number.isNaN(seenEpoch) && nowMs - seenEpoch > threshold) {
        this.rawDb
          .prepare(
            "UPDATE swarm_runners SET status = 'offline', active_task_id = NULL WHERE runner_id = ?"
          )
          .run(String(w.runner_id));
      }
    }

    this.pruneOldRunners();

    return reapedTasks;
  }

  public registerRunnerHeartbeat(
    info: {
      runnerId: string;
      name?: string;
      labels?: string[];
      repositories?: string[];
      systemInfo?: RunnerSystemInfo;
      activeTaskId?: string | null;
      status?: 'idle' | 'busy' | 'offline';
    },
    options: { touchLastSeen?: boolean } = {}
  ): void {
    const now = new Date().toISOString();
    const existing = this.rawDb
      .prepare('SELECT * FROM swarm_runners WHERE runner_id = ?')
      .get(info.runnerId) as Record<string, any> | undefined;

    const name = info.name ?? existing?.name ?? info.runnerId;
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
    const lastSeenAt = options.touchLastSeen === false ? (existing?.last_seen_at ?? now) : now;

    this.rawDb
      .prepare(
        `INSERT INTO swarm_runners (
          runner_id, name, labels_json, repositories_json, system_info_json,
          active_task_id, status, registered_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(runner_id) DO UPDATE SET
          name = excluded.name,
          labels_json = excluded.labels_json,
          repositories_json = excluded.repositories_json,
          system_info_json = excluded.system_info_json,
          active_task_id = excluded.active_task_id,
          status = excluded.status,
          last_seen_at = excluded.last_seen_at`
      )
      .run(
        info.runnerId,
        name,
        labelsJson,
        reposJson,
        systemInfoJson,
        activeTaskId,
        status,
        existing?.registered_at ?? now,
        lastSeenAt
      );
  }

  public listRunners(): SwarmRunnerRecord[] {
    const rows = this.rawDb
      .prepare('SELECT * FROM swarm_runners ORDER BY last_seen_at DESC')
      .all() as Array<Record<string, any>>;

    return rows.map((r) => this.mapRowToRunner(r));
  }

  private mapRowToRunner(r: Record<string, any>): SwarmRunnerRecord {
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
      runnerId: String(r.runner_id ?? ''),
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

    let storedCascade: unknown = [];
    try {
      storedCascade = JSON.parse(String(row.candidate_models_json || '[]'));
    } catch {}

    const primaryModel = String(row.model);
    const primaryEffort = resolveReasoningEffortForModel(primaryModel, row.effort);
    const cascade: CascadeHop[] = [
      { model: primaryModel, effort: primaryEffort },
      ...normalizeCascade(storedCascade, primaryModel).filter((hop) => hop.model !== primaryModel),
    ];

    const title = resolveTaskTitle(
      typeof row.title === 'string' ? row.title : '',
      String(row.prompt || '')
    );

    return {
      id: String(row.id),
      taskNumber: Number(row.task_number || 0),
      title,
      tier: (row.tier as TaskTier) || 'immediate',
      originId: row.origin_id ? String(row.origin_id) : undefined,
      originNumber:
        row.origin_number !== null && row.origin_number !== undefined
          ? Number(row.origin_number)
          : undefined,
      originTitle: row.origin_title ? String(row.origin_title) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      repositoryId: String(row.repository_id),
      repositoryName: String(row.repository_name),
      repositoryPath: String(row.repository_path),
      cloneUrl: row.clone_url ? String(row.clone_url) : undefined,
      defaultBranch: String(row.default_branch || 'main'),
      prompt: String(row.prompt),
      requestedBy: String(row.requested_by || 'web-ui'),
      prPolicy:
        row.pr_policy && row.pr_policy !== 'inherit' ? (row.pr_policy as PrPolicy) : undefined,
      scheduleMode: (row.schedule_mode as ScheduleMode) || 'immediate',
      requiredLabels,
      model: String(row.model),
      cascade,
      poolGroup: (row.pool_group as PoolGroup) || 'gemini',
      effort: primaryEffort,
      allowOverage: row.allow_overage === 1,
      pushBranch: row.push_branch === 1,
      autoCreatePr: row.auto_create_pr !== 0,
      prUrl: row.pr_url ? String(row.pr_url) : undefined,
      issueUrls: parseIssueUrls(row.issue_urls_json),
      expiresAt: row.expires_at ? String(row.expires_at) : undefined,
      verifyCommand: row.verify_command ? String(row.verify_command) : undefined,
      status: (row.status as TaskStatus) || 'queued',
      runnerId: row.runner_id ? String(row.runner_id) : undefined,
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

  public listBacklogTasks(status?: BacklogStatus): BacklogTaskRecord[] {
    let query = 'SELECT * FROM backlog_tasks';
    const params: any[] = [];
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    query += ' ORDER BY priority_order ASC, task_number ASC, created_at ASC';
    const rows = this.rawDb.prepare(query).all(...params) as Array<Record<string, any>>;
    return rows.map((r) => this.mapRowToBacklogTask(r));
  }

  public getBacklogTask(id: string): BacklogTaskRecord | undefined {
    const row = this.rawDb.prepare('SELECT * FROM backlog_tasks WHERE id = ?').get(id) as
      Record<string, any> | undefined;
    return row ? this.mapRowToBacklogTask(row) : undefined;
  }

  public listEligibleBacklogTasks(): BacklogTaskRecord[] {
    const rows = this.rawDb
      .prepare(
        `SELECT * FROM backlog_tasks
         WHERE status = 'pending' AND attempt_count < max_attempts
         ORDER BY priority_order ASC, task_number ASC, created_at ASC`
      )
      .all() as Array<Record<string, any>>;
    return rows.map((r) => this.mapRowToBacklogTask(r));
  }

  public getNextEligibleBacklogTask(): BacklogTaskRecord | undefined {
    const row = this.rawDb
      .prepare(
        `SELECT * FROM backlog_tasks
         WHERE status = 'pending' AND attempt_count < max_attempts
         ORDER BY priority_order ASC, task_number ASC, created_at ASC
         LIMIT 1`
      )
      .get() as Record<string, any> | undefined;
    return row ? this.mapRowToBacklogTask(row) : undefined;
  }

  public listDispatchedBacklogTasks(): BacklogTaskRecord[] {
    const rows = this.rawDb
      .prepare(
        "SELECT * FROM backlog_tasks WHERE status = 'dispatched' AND swarm_task_id IS NOT NULL"
      )
      .all() as Array<Record<string, any>>;
    return rows.map((r) => this.mapRowToBacklogTask(r));
  }

  public createBacklogTask(input: {
    id?: string;
    taskNumber?: number;
    title: string;
    prompt: string;
    repositoryId: string;
    cascade?: readonly CascadeHop[];
    verifyCommand?: string;
    autoCreatePr?: boolean;
    priorityOrder?: number;
    maxAttempts?: number;
    githubIssueNumber?: number;
    githubIssueUrl?: string;
  }): BacklogTaskRecord {
    const id = input.id ?? `backlog-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const cascade = coerceCascade(input.cascade);
    const autoCreatePr = input.autoCreatePr !== false ? 1 : 0;
    const priorityOrder = coerceNumber(input.priorityOrder, 0);
    const maxAttempts = coerceNumber(input.maxAttempts, 2);

    // Two concurrent creates must never pick the same number, so the max read and insert share one
    // write transaction.
    this.inTransaction(() => {
      const maxNumberRow = this.rawDb
        .prepare('SELECT MAX(task_number) as max_num FROM backlog_tasks')
        .get() as { max_num?: number } | undefined;
      const taskNumber = input.taskNumber ?? (maxNumberRow?.max_num ?? 0) + 1;

      this.rawDb
        .prepare(
          `INSERT INTO backlog_tasks (
          id, task_number, title, prompt, repository_id, models_json,
          verify_command, auto_create_pr, priority_order, status,
          attempt_count, max_attempts, github_issue_number, github_issue_url,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          taskNumber,
          input.title.trim(),
          input.prompt.trim(),
          input.repositoryId.trim(),
          JSON.stringify(cascade),
          input.verifyCommand ?? null,
          autoCreatePr,
          priorityOrder,
          maxAttempts,
          input.githubIssueNumber ?? null,
          input.githubIssueUrl ?? null,
          now,
          now
        );
    });

    return this.getBacklogTask(id)!;
  }

  public updateBacklogTask(
    id: string,
    patch: Partial<{
      title: string;
      prompt: string;
      repositoryId: string;
      cascade: CascadeHop[];
      verifyCommand: string | null;
      autoCreatePr: boolean;
      priorityOrder: number;
      status: BacklogStatus;
      attemptCount: number;
      maxAttempts: number;
      lastError: string | null;
      swarmTaskId: string | null;
      githubIssueNumber: number | null;
      githubIssueUrl: string | null;
    }>
  ): BacklogTaskRecord | undefined {
    const existing = this.getBacklogTask(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const title = coerceTrimmedString(patch.title, existing.title);
    const prompt = coerceTrimmedString(patch.prompt, existing.prompt);
    const repositoryId = coerceTrimmedString(patch.repositoryId, existing.repositoryId);
    const cascade = coerceCascade(
      patch.cascade !== undefined ? patch.cascade : existing.cascade,
      existing.cascade[0]?.model
    );
    const verifyCommand = coerceNullableString(patch.verifyCommand, existing.verifyCommand ?? null);
    const autoCreatePr =
      typeof patch.autoCreatePr === 'boolean'
        ? patch.autoCreatePr
          ? 1
          : 0
        : existing.autoCreatePr
          ? 1
          : 0;
    const priorityOrder = coerceNumber(patch.priorityOrder, existing.priorityOrder);
    const status = coerceBacklogStatus(patch.status ?? existing.status, existing.status);
    const attemptCount = coerceNumber(patch.attemptCount, existing.attemptCount);
    const maxAttempts = coerceNumber(patch.maxAttempts, existing.maxAttempts);
    const lastError = coerceNullableString(patch.lastError, existing.lastError ?? null);
    const swarmTaskId = coerceNullableString(patch.swarmTaskId, existing.swarmTaskId ?? null);
    const githubIssueNumber = coerceNullableNumber(
      patch.githubIssueNumber,
      existing.githubIssueNumber ?? null
    );
    const githubIssueUrl = coerceNullableString(
      patch.githubIssueUrl,
      existing.githubIssueUrl ?? null
    );

    this.rawDb
      .prepare(
        `UPDATE backlog_tasks
         SET title = ?,
             prompt = ?,
             repository_id = ?,
             models_json = ?,
             verify_command = ?,
             auto_create_pr = ?,
             priority_order = ?,
             status = ?,
             attempt_count = ?,
             max_attempts = ?,
             last_error = ?,
             swarm_task_id = ?,
             github_issue_number = ?,
             github_issue_url = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        title,
        prompt,
        repositoryId,
        JSON.stringify(cascade),
        verifyCommand,
        autoCreatePr,
        priorityOrder,
        status,
        attemptCount,
        maxAttempts,
        lastError,
        swarmTaskId,
        githubIssueNumber,
        githubIssueUrl,
        now,
        id
      );

    return this.getBacklogTask(id);
  }

  public deleteBacklogTask(id: string): boolean {
    const info = this.rawDb
      .prepare('DELETE FROM backlog_tasks WHERE id = ?')
      .run(id) as unknown as { changes?: number };
    return (info?.changes ?? 0) > 0;
  }

  private mapRowToBacklogTask(r: Record<string, any>): BacklogTaskRecord {
    let storedCascade: unknown = [];
    try {
      storedCascade = JSON.parse(String(r.models_json || '[]'));
    } catch {}

    return {
      id: String(r.id),
      taskNumber: Number(r.task_number || 0),
      title: String(r.title),
      prompt: String(r.prompt),
      repositoryId: String(r.repository_id),
      cascade: coerceCascade(storedCascade),
      verifyCommand: r.verify_command ? String(r.verify_command) : undefined,
      autoCreatePr: r.auto_create_pr !== 0,
      priorityOrder: Number(r.priority_order ?? 0),
      status: (r.status as BacklogStatus) || 'pending',
      attemptCount: Number(r.attempt_count ?? 0),
      maxAttempts: Number(r.max_attempts ?? 2),
      lastError: r.last_error ? String(r.last_error) : undefined,
      swarmTaskId: r.swarm_task_id ? String(r.swarm_task_id) : undefined,
      githubIssueNumber:
        r.github_issue_number !== null &&
        r.github_issue_number !== undefined &&
        Number(r.github_issue_number) > 0
          ? Number(r.github_issue_number)
          : undefined,
      githubIssueUrl: r.github_issue_url ? String(r.github_issue_url) : undefined,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  public listRoutineTasks(): RoutineTaskRecord[] {
    const rows = this.rawDb
      .prepare(
        'SELECT * FROM routine_tasks ORDER BY sort_order ASC, task_number ASC, created_at ASC'
      )
      .all() as Array<Record<string, any>>;
    return rows.map((r) => this.mapRowToRoutineTask(r));
  }

  public getRoutineTask(id: string): RoutineTaskRecord | undefined {
    const row = this.rawDb.prepare('SELECT * FROM routine_tasks WHERE id = ?').get(id) as
      Record<string, any> | undefined;
    return row ? this.mapRowToRoutineTask(row) : undefined;
  }

  public createRoutineTask(input: {
    id?: string;
    taskNumber?: number;
    title: string;
    prompt: string;
    repositoryId: string;
    cascade?: readonly CascadeHop[];
    verifyCommand?: string;
    autoCreatePr?: boolean;
    prPolicy?: PrPolicy | null;
    enabled?: boolean;
    sortOrder?: number;
    triggerBeforeResetHours?: number;
    minHeadroomPercent?: number;
  }): RoutineTaskRecord {
    const id = input.id ?? `routine-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const cascade = coerceCascade(input.cascade);
    const autoCreatePr = input.autoCreatePr !== false ? 1 : 0;
    const prPolicy =
      input.prPolicy === 'docs_only' ||
      input.prPolicy === 'issues_only' ||
      input.prPolicy === 'all' ||
      input.prPolicy === 'none'
        ? input.prPolicy
        : 'inherit';
    const enabled = input.enabled !== false ? 1 : 0;
    const sortOrder = coerceNumber(input.sortOrder, 0);
    const triggerHours = coerceNumber(input.triggerBeforeResetHours, DEFAULT_QUOTA_BURN_MAX_HOURS);
    const minHeadroom = coerceNumber(input.minHeadroomPercent, 10);

    // Two concurrent creates must never pick the same number, so the max read and insert share one
    // write transaction.
    this.inTransaction(() => {
      const maxNumberRow = this.rawDb
        .prepare('SELECT MAX(task_number) as max_num FROM routine_tasks')
        .get() as { max_num?: number } | undefined;
      const taskNumber = input.taskNumber ?? (maxNumberRow?.max_num ?? 0) + 1;

      this.rawDb
        .prepare(
          `INSERT INTO routine_tasks (
          id, task_number, title, prompt, repository_id, models_json,
          verify_command, auto_create_pr, pr_policy, enabled, sort_order,
          trigger_before_reset_hours, min_headroom_percent, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          taskNumber,
          input.title.trim(),
          input.prompt.trim(),
          input.repositoryId.trim(),
          JSON.stringify(cascade),
          input.verifyCommand ?? null,
          autoCreatePr,
          prPolicy,
          enabled,
          sortOrder,
          triggerHours,
          minHeadroom,
          now,
          now
        );
    });

    return this.getRoutineTask(id)!;
  }

  public updateRoutineTask(
    id: string,
    patch: Partial<{
      title: string;
      prompt: string;
      repositoryId: string;
      cascade: CascadeHop[];
      verifyCommand: string | null;
      autoCreatePr: boolean;
      prPolicy: PrPolicy | null;
      enabled: boolean;
      sortOrder: number;
      triggerBeforeResetHours: number;
      minHeadroomPercent: number;
      lastTriggeredResetTime: string | null;
      lastTriggeredCycles: Record<string, string>;
      lastTaskId: string | null;
    }>
  ): RoutineTaskRecord | undefined {
    const existing = this.getRoutineTask(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const title = coerceTrimmedString(patch.title, existing.title);
    const prompt = coerceTrimmedString(patch.prompt, existing.prompt);
    const repositoryId = coerceTrimmedString(patch.repositoryId, existing.repositoryId);
    const cascade = coerceCascade(
      patch.cascade !== undefined ? patch.cascade : existing.cascade,
      existing.cascade[0]?.model
    );
    const verifyCommand = coerceNullableString(patch.verifyCommand, existing.verifyCommand ?? null);
    const autoCreatePr =
      typeof patch.autoCreatePr === 'boolean'
        ? patch.autoCreatePr
          ? 1
          : 0
        : existing.autoCreatePr
          ? 1
          : 0;
    const prPolicy =
      patch.prPolicy === null
        ? 'inherit'
        : patch.prPolicy === 'docs_only' ||
            patch.prPolicy === 'issues_only' ||
            patch.prPolicy === 'all' ||
            patch.prPolicy === 'none'
          ? patch.prPolicy
          : (existing.prPolicy ?? 'inherit');
    const enabled =
      typeof patch.enabled === 'boolean' ? (patch.enabled ? 1 : 0) : existing.enabled ? 1 : 0;
    const sortOrder = coerceNumber(patch.sortOrder, existing.sortOrder);
    const triggerHours = coerceNumber(
      patch.triggerBeforeResetHours,
      existing.triggerBeforeResetHours
    );
    const minHeadroom = coerceNumber(patch.minHeadroomPercent, existing.minHeadroomPercent);
    const lastReset = coerceNullableString(
      patch.lastTriggeredResetTime,
      existing.lastTriggeredResetTime ?? null
    );
    const lastTriggeredCyclesJson = JSON.stringify(
      patch.lastTriggeredCycles ?? existing.lastTriggeredCycles ?? {}
    );
    const lastTaskId = coerceNullableString(patch.lastTaskId, existing.lastTaskId ?? null);

    this.rawDb
      .prepare(
        `UPDATE routine_tasks
         SET title = ?,
             prompt = ?,
             repository_id = ?,
             models_json = ?,
             verify_command = ?,
             auto_create_pr = ?,
             pr_policy = ?,
             enabled = ?,
             sort_order = ?,
             trigger_before_reset_hours = ?,
             min_headroom_percent = ?,
             last_triggered_reset_time = ?,
             last_triggered_cycles_json = ?,
             last_task_id = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        title,
        prompt,
        repositoryId,
        JSON.stringify(cascade),
        verifyCommand,
        autoCreatePr,
        prPolicy,
        enabled,
        sortOrder,
        triggerHours,
        minHeadroom,
        lastReset,
        lastTriggeredCyclesJson,
        lastTaskId,
        now,
        id
      );

    return this.getRoutineTask(id);
  }

  public deleteRoutineTask(id: string): boolean {
    const info = this.rawDb
      .prepare('DELETE FROM routine_tasks WHERE id = ?')
      .run(id) as unknown as { changes?: number };
    return (info?.changes ?? 0) > 0;
  }

  private mapRowToRoutineTask(r: Record<string, any>): RoutineTaskRecord {
    let storedCascade: unknown = [];
    try {
      storedCascade = JSON.parse(String(r.models_json || '[]'));
    } catch {}

    return {
      id: String(r.id),
      taskNumber: Number(r.task_number || 0),
      title: String(r.title),
      prompt: String(r.prompt),
      repositoryId: String(r.repository_id),
      cascade: coerceCascade(storedCascade),
      verifyCommand: r.verify_command ? String(r.verify_command) : undefined,
      autoCreatePr: r.auto_create_pr !== 0,
      prPolicy: r.pr_policy && r.pr_policy !== 'inherit' ? (r.pr_policy as PrPolicy) : undefined,
      enabled: r.enabled !== 0,
      sortOrder: Number(r.sort_order ?? 0),
      triggerBeforeResetHours: Number(r.trigger_before_reset_hours ?? DEFAULT_QUOTA_BURN_MAX_HOURS),
      minHeadroomPercent: Number(r.min_headroom_percent ?? 10),
      lastTriggeredResetTime: r.last_triggered_reset_time
        ? String(r.last_triggered_reset_time)
        : undefined,
      lastTriggeredCycles: parseCycleMap(r.last_triggered_cycles_json),
      lastTaskId: r.last_task_id ? String(r.last_task_id) : undefined,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
}
