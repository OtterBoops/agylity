import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppDatabase } from '../storage/db.js';
import { applyMigrations, SWARM_TASK_COLUMNS } from '../storage/migrations.js';
import type { PoolGroup } from '../sentry/models.js';
import { DEFAULT_QUOTA_BURN_MAX_HOURS } from '../config/env.js';
import { isHttpUrl } from '../shared/urls.js';
import { resolveTaskTitle } from '../shared/titles.js';
import { tailWindow } from '../shared/text.js';
import { DEFAULT_DISPATCH_MODEL } from '../shared/models.js';
import { readJsonColumn } from '../storage/json.js';
import { RunnerRegistry } from './runnerRegistry.js';
import { settleBacklogOrigin } from './backlogOrigin.js';
import { HEARTBEAT_TAIL_BYTES, PR_POLICY_VALUES } from '../shared/contracts.js';
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
  originIssueNumber?: number;
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

interface ClaimTaskOptions {
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

interface TaskListFilters {
  status?: TaskStatus;
  scheduleMode?: ScheduleMode;
  q?: string;
  taskNumber?: number;
}

interface TaskListOptions extends TaskListFilters {
  limit?: number;
  offset?: number;
}

const TASK_LIST_COLUMNS = SWARM_TASK_COLUMNS.filter((column) => column.name !== 'output')
  .map((column) => column.name)
  .join(', ');

export const OUTPUT_CAP = 512 * 1024;

/** Keeps the tail, which is where a failure explains itself, and says how much was dropped. */
export const capOutput = (text: string, cap: number = OUTPUT_CAP): string => {
  if (text.length <= cap) return text;
  const kept = tailWindow(text, cap);
  return `[truncated ${text.length - kept.length} characters]\n${kept}`;
};

const ELIGIBLE_BACKLOG_SQL = `SELECT * FROM backlog_tasks
   WHERE status = 'pending' AND attempt_count < max_attempts
   ORDER BY priority_order ASC, task_number ASC, created_at ASC`;

const TERMINAL_STATUS_SQL = TERMINAL_TASK_STATUSES.map((s) => `'${s}'`).join(', ');

/** The queue cannot read config, so an unconfigured cascade falls back to this catalog-wide model. */

const coerceCascade = (value: unknown, fallbackModel?: string): CascadeHop[] =>
  normalizeCascade(value, fallbackModel ?? DEFAULT_DISPATCH_MODEL);

const coerceNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

// Attempt bookkeeping is a domain invariant, not a caller's choice: a row may never carry a negative
// number of spent attempts or fewer than one allowed attempt.
const coerceAttempts = (value: unknown, fallback: number, minimum: number): number =>
  Math.max(minimum, Math.trunc(coerceNumber(value, fallback)));

// The scheduler only selects attempt_count < max_attempts, so a refund at the cap must settle terminal.
const settleStatusForAttempts = (attemptCount: number, maxAttempts: number): BacklogStatus =>
  attemptCount >= maxAttempts ? 'failed' : 'pending';

const coerceNullableNumber = (value: unknown, fallback: number | null): number | null => {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fallback;
};

const bitFlag = (value: boolean): 0 | 1 => (value ? 1 : 0);

const PR_POLICY_SET: ReadonlySet<string> = new Set(PR_POLICY_VALUES);

// An unrecognised policy string must never be stored, or it would read as "no restriction".
const coercePrPolicy = (value: unknown): PrPolicy | undefined =>
  typeof value === 'string' && PR_POLICY_SET.has(value) ? (value as PrPolicy) : undefined;

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

const numberOrUndefined = (value: unknown): number | undefined =>
  value !== null && value !== undefined ? Number(value) : undefined;

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

export class TaskQueue {
  private readonly rawDb: DatabaseSync;
  public readonly runners: RunnerRegistry;

  constructor(database: AppDatabase) {
    this.rawDb = database.getRawDb();
    applyMigrations(this.rawDb);
    this.runners = new RunnerRegistry(this.rawDb, (fn) => this.inTransaction(fn));
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

  // The max read and the insert share the caller's write transaction, so two creates cannot collide.
  private nextTaskNumber(table: 'swarm_tasks' | 'backlog_tasks' | 'routine_tasks'): number {
    const row = this.rawDb.prepare(`SELECT MAX(task_number) as max_num FROM ${table}`).get() as
      { max_num?: number } | undefined;
    return (row?.max_num ?? 0) + 1;
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
      const current = this.getBacklogTask(origin.id);
      if (!current) {
        throw new Error(`Backlog origin ${origin.id} no longer exists`);
      }
      // Only a fresh dispatch consumes an attempt; a stacked spawn reuses the count.
      const spawnSpentAttempt = origin.attemptCount > current.attemptCount;
      this.insertTaskRow(id, input, spawnSpentAttempt);
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
  private insertTaskRow(id: string, input: EnqueueTaskInput, spawnSpentAttempt = false): void {
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
    const originIssueNumber = input.originIssueNumber ?? null;

    const taskNumber = input.taskNumber ?? this.nextTaskNumber('swarm_tasks');
    this.rawDb
      .prepare(
        `INSERT INTO swarm_tasks (
        id, task_number, title, tier, origin_id, origin_number, origin_title, origin_issue_number,
        created_at, updated_at, repository_id, repository_name, repository_path,
        clone_url, default_branch, prompt, requested_by, pr_policy, schedule_mode,
        required_labels_json, model, candidate_models_json, pool_group, effort, allow_overage,
        push_branch, auto_create_pr, expires_at, verify_command, spawn_spent_attempt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        taskNumber,
        title,
        tier,
        originId,
        originNumber,
        originTitle,
        originIssueNumber,
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
        input.verifyCommand ?? null,
        bitFlag(spawnSpentAttempt)
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

  public getTask(id: string): SwarmTask | undefined {
    const row = this.rawDb.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(id) as
      Record<string, any> | undefined;
    return row ? this.mapRowToTask(row) : undefined;
  }

  public getLatestTaskForOrigin(originId: string, poolGroup?: string): SwarmTask | undefined {
    const row = this.rawDb
      .prepare(
        `SELECT * FROM swarm_tasks
         WHERE origin_id = ?${poolGroup ? ' AND pool_group = ?' : ''}
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`
      )
      .get(...(poolGroup ? [originId, poolGroup] : [originId])) as Record<string, any> | undefined;
    return row ? this.mapRowToTask(row) : undefined;
  }

  // A delivered run or an open PR finishes the origin; a later failed stacked run must not re-dispatch it.
  public hasDeliveredRunForOrigin(originId: string): boolean {
    const row = this.rawDb
      .prepare(
        `SELECT 1 AS delivered FROM swarm_tasks
         WHERE origin_id = ? AND (status IN ('completed', 'no_changes') OR pr_url IS NOT NULL)
         LIMIT 1`
      )
      .get(originId) as { delivered?: number } | undefined;
    return row?.delivered === 1;
  }

  // Whether this task's own spawn consumed a backlog attempt (stacked spawns never do).
  public taskSpawnSpentAttempt(taskId: string): boolean {
    const row = this.rawDb
      .prepare('SELECT spawn_spent_attempt FROM swarm_tasks WHERE id = ?')
      .get(taskId) as { spawn_spent_attempt?: number } | undefined;
    return Number(row?.spawn_spent_attempt) === 1;
  }

  /** Hands a refundable spawn-attempt flag to one surviving active sibling for the same origin. */
  public transferSpawnSpentAttempt(fromTaskId: string, originId: string): boolean {
    return this.inTransaction(() => {
      if (!this.taskSpawnSpentAttempt(fromTaskId)) return false;
      const recipient = this.rawDb
        .prepare(
          `SELECT id FROM swarm_tasks
           WHERE origin_id = ? AND id != ? AND status NOT IN (${TERMINAL_STATUS_SQL})
             AND spawn_spent_attempt = 0
           ORDER BY created_at ASC, rowid ASC
           LIMIT 1`
        )
        .get(originId, fromTaskId) as { id?: string } | undefined;
      if (!recipient?.id) return false;
      this.rawDb
        .prepare('UPDATE swarm_tasks SET spawn_spent_attempt = 0 WHERE id = ?')
        .run(fromTaskId);
      this.rawDb
        .prepare('UPDATE swarm_tasks SET spawn_spent_attempt = 1 WHERE id = ?')
        .run(recipient.id);
      return true;
    });
  }

  public hasActiveTaskForOrigin(originId: string, excludeTaskId?: string): boolean {
    const row = this.rawDb
      .prepare(
        `SELECT 1 AS active FROM swarm_tasks
         WHERE origin_id = ? AND status NOT IN (${TERMINAL_STATUS_SQL})
         ${excludeTaskId ? 'AND id != ?' : ''}
         LIMIT 1`
      )
      .get(...(excludeTaskId ? [originId, excludeTaskId] : [originId])) as
      { active?: number } | undefined;
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
        "(title LIKE ? ESCAPE '\\' OR repository_name LIKE ? ESCAPE '\\' OR origin_title LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\')"
      );
      params.push(pattern, pattern, pattern, pattern);
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
      const existingRunner = this.runners.getRunner(options.runnerId);
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
      const beat = (status: 'idle' | 'busy', activeTaskId?: string): void =>
        this.runners.registerRunnerHeartbeat({
          runnerId: options.runnerId,
          name: options.runnerName,
          labels: persistedLabels,
          repositories: persistedRepos,
          systemInfo: options.systemInfo,
          activeTaskId,
          status,
        });
      if (existingRunner && !existingRunner.enabled) {
        beat('idle');
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
        beat('idle');
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
          beat('busy', task.id);
          return this.getTask(task.id) ?? null;
        }
      }

      beat('idle');

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
    // A runner may not put its own task back in the claim pool.
    if (patch.runnerId && (patch.status === 'queued' || patch.status === 'claimed')) {
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
    // A runner is the least-trusted writer here: anything but a web URL is dropped at the door.
    const prUrl =
      patch.prUrl !== undefined
        ? isHttpUrl(patch.prUrl)
          ? patch.prUrl
          : null
        : (existing.prUrl ?? null);
    const issueUrls =
      patch.issueUrls !== undefined
        ? patch.issueUrls.filter(isHttpUrl)
        : (existing.issueUrls ?? []);
    // The column is NOT NULL DEFAULT '[]', so "no issues" is an empty array, never NULL.
    const issueUrlsJson = JSON.stringify(issueUrls);
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
           AND status NOT IN (${TERMINAL_STATUS_SQL})
           AND NOT (status = 'queued' AND ? IN ('claimed', 'executing'))
           AND NOT (? IS NOT NULL AND ? IN ('queued', 'claimed'))`
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
        patch.status,
        patch.runnerId ?? null,
        patch.status
      ) as unknown as { changes?: number };

    if ((updateResult?.changes ?? 0) === 0) {
      return { task: this.getTask(taskId) ?? existing, applied: false };
    }

    if (isTerminal) {
      this.pruneOldTasks();
    }

    if (runnerId && this.runners.getRunner(runnerId)) {
      this.runners.registerRunnerHeartbeat(
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
    const tail =
      outputTail && outputTail.length > 0
        ? tailWindow(outputTail, HEARTBEAT_TAIL_BYTES)
        : undefined;
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

    this.runners.registerRunnerHeartbeat({ runnerId, activeTaskId: taskId, status: 'busy' });
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
    settleBacklogOrigin(
      this,
      { originId: task.originId, taskId: task.id, status: 'aborted', claimed: false, error },
      undefined
    );
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

    this.runners.pruneOldRunners();

    return reapedTasks;
  }

  private mapRowToTask(row: Record<string, any>): SwarmTask {
    const requiredLabels = readJsonColumn<string[]>(row.required_labels_json || '[]', []);
    const storedCascade = readJsonColumn<unknown>(row.candidate_models_json || '[]', []);

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
      originNumber: numberOrUndefined(row.origin_number),
      originIssueNumber: numberOrUndefined(row.origin_issue_number),
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
      numTurns: numberOrUndefined(row.num_turns),
      totalTokens: numberOrUndefined(row.total_tokens),
      thinkingTokens: numberOrUndefined(row.thinking_tokens),
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
    const rows = this.rawDb.prepare(ELIGIBLE_BACKLOG_SQL).all() as Array<Record<string, any>>;
    return rows.map((r) => this.mapRowToBacklogTask(r));
  }

  public getNextEligibleBacklogTask(): BacklogTaskRecord | undefined {
    const row = this.rawDb.prepare(`${ELIGIBLE_BACKLOG_SQL} LIMIT 1`).get() as
      Record<string, any> | undefined;
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
    const autoCreatePr = bitFlag(input.autoCreatePr !== false);
    const priorityOrder = coerceNumber(input.priorityOrder, 0);
    const maxAttempts = coerceAttempts(input.maxAttempts, 2, 1);

    this.inTransaction(() => {
      const taskNumber = input.taskNumber ?? this.nextTaskNumber('backlog_tasks');

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
    const cascade = coerceCascade(patch.cascade ?? existing.cascade, existing.cascade[0]?.model);
    const verifyCommand = coerceNullableString(patch.verifyCommand, existing.verifyCommand ?? null);
    const autoCreatePr = bitFlag(
      typeof patch.autoCreatePr === 'boolean' ? patch.autoCreatePr : existing.autoCreatePr
    );
    const priorityOrder = coerceNumber(patch.priorityOrder, existing.priorityOrder);
    const requestedStatus = coerceBacklogStatus(patch.status ?? existing.status, existing.status);
    const attemptCount = coerceAttempts(patch.attemptCount, existing.attemptCount, 0);
    const maxAttempts = coerceAttempts(patch.maxAttempts, existing.maxAttempts, 1);
    const status =
      requestedStatus === 'pending'
        ? settleStatusForAttempts(attemptCount, maxAttempts)
        : requestedStatus;
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

  private deleteByTable(table: 'backlog_tasks' | 'routine_tasks', id: string): boolean {
    const info = this.rawDb.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id) as unknown as {
      changes?: number;
    };
    return (info?.changes ?? 0) > 0;
  }

  public deleteBacklogTask(id: string): boolean {
    return this.deleteByTable('backlog_tasks', id);
  }

  /** The columns `backlog_tasks` and `routine_tasks` share, read once so the two mappers cannot drift. */
  private mapSharedTaskColumns(r: Record<string, any>) {
    return {
      id: String(r.id),
      taskNumber: Number(r.task_number || 0),
      title: String(r.title),
      prompt: String(r.prompt),
      repositoryId: String(r.repository_id),
      cascade: coerceCascade(readJsonColumn<unknown>(r.models_json || '[]', [])),
      verifyCommand: r.verify_command ? String(r.verify_command) : undefined,
      autoCreatePr: r.auto_create_pr !== 0,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  private mapRowToBacklogTask(r: Record<string, any>): BacklogTaskRecord {
    return {
      ...this.mapSharedTaskColumns(r),
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
    const autoCreatePr = bitFlag(input.autoCreatePr !== false);
    const prPolicy = coercePrPolicy(input.prPolicy) ?? 'inherit';
    const enabled = bitFlag(input.enabled !== false);
    const sortOrder = coerceNumber(input.sortOrder, 0);
    const triggerHours = coerceNumber(input.triggerBeforeResetHours, DEFAULT_QUOTA_BURN_MAX_HOURS);
    const minHeadroom = coerceNumber(input.minHeadroomPercent, 10);

    this.inTransaction(() => {
      const taskNumber = input.taskNumber ?? this.nextTaskNumber('routine_tasks');

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
    const cascade = coerceCascade(patch.cascade ?? existing.cascade, existing.cascade[0]?.model);
    const verifyCommand = coerceNullableString(patch.verifyCommand, existing.verifyCommand ?? null);
    const autoCreatePr = bitFlag(
      typeof patch.autoCreatePr === 'boolean' ? patch.autoCreatePr : existing.autoCreatePr
    );
    const prPolicy =
      patch.prPolicy === null
        ? 'inherit'
        : (coercePrPolicy(patch.prPolicy) ?? existing.prPolicy ?? 'inherit');
    const enabled = bitFlag(typeof patch.enabled === 'boolean' ? patch.enabled : existing.enabled);
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
    return this.deleteByTable('routine_tasks', id);
  }

  private mapRowToRoutineTask(r: Record<string, any>): RoutineTaskRecord {
    return {
      ...this.mapSharedTaskColumns(r),
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
    };
  }
}

export { RegistrationTokenError } from './runnerRegistry.js';
export type {
  CreateRegistrationTokenInput,
  ExchangeRegistrationTokenInput,
} from './runnerRegistry.js';
