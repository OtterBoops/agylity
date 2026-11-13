import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppDatabase } from '../storage/db.js';
import { migrateColumns, renderColumns, type ColumnSpec } from '../storage/schema.js';
import type { QuotaFamily } from '../sentry/models.js';
import type { PrPolicy } from '../config/schema.js';
import {
  BacklogStatusSchema,
  ReasoningEffortSchema,
  TaskActorSchema,
  resolvePoolFamilyForModel,
  type BacklogStatus,
  type ReasoningEffort,
  type ScheduleMode,
  type TaskActor,
  type TaskStatus,
  type TaskTier,
  TERMINAL_TASK_STATUSES,
  isTerminalTaskStatus,
} from './models.js';
import { logger } from '../logs/logger.js';

export type { TaskActor, TaskTier, BacklogStatus };

export interface RunnerSystemInfo {
  hostname?: string;
  platform?: string;
  arch?: string;
}

export interface SwarmTask {
  id: string;
  taskNumber: number;
  title: string;
  tier: TaskTier;
  originId?: string;
  originNumber?: number;
  originTitle?: string;
  createdAt: string;
  updatedAt: string;
  repositoryId: string;
  repositoryName: string;
  repositoryPath: string;
  cloneUrl?: string;
  defaultBranch: string;
  prompt: string;
  requestedBy: string;
  actor: TaskActor;
  prPolicy?: PrPolicy;
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
  runnerId?: string;
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
  actor?: TaskActor;
  prPolicy?: PrPolicy;
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
  branchName?: string;
  prUrl?: string;
  output?: string;
  error?: string;
  durationMs?: number;
  numTurns?: number;
  totalTokens?: number;
  thinkingTokens?: number;
}

export interface SwarmRunnerRecord {
  runnerId: string;
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
  runnerId?: string;
  runnerName?: string;
  labels?: string[];
  repositories?: string[];
  systemInfo?: RunnerSystemInfo;
}

export interface BacklogTaskRecord {
  id: string;
  taskNumber: number;
  title: string;
  prompt: string;
  repositoryId: string;
  models: string[];
  effort: ReasoningEffort;
  verifyCommand?: string;
  autoCreatePr: boolean;
  actor: TaskActor;
  priorityOrder: number;
  status: BacklogStatus;
  attemptCount: number;
  maxAttempts: number;
  lastError?: string;
  swarmTaskId?: string;
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineTaskRecord {
  id: string;
  taskNumber: number;
  title: string;
  prompt: string;
  repositoryId: string;
  models: string[];
  effort: ReasoningEffort;
  verifyCommand?: string;
  autoCreatePr: boolean;
  actor: TaskActor;
  prPolicy?: PrPolicy;
  enabled: boolean;
  sortOrder: number;
  triggerBeforeResetHours: number;
  minHeadroomPercent: number;
  lastTriggeredResetTime?: string;
  lastTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

// Retained for transitional coordinator references
export interface StandingTaskRecord {
  id: string;
  title: string;
  prompt: string;
  repositoryId: string;
  model: string;
  effort: ReasoningEffort;
  verifyCommand?: string;
  autoCreatePr: boolean;
  actor: TaskActor;
  prPolicy?: PrPolicy;
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

// Single source of truth for every managed table: initSchema renders CREATE TABLE from these and
// migrateSchema ALTER TABLE ADD COLUMNs any that an older database is missing.
const SWARM_TASK_COLUMNS: readonly ColumnSpec[] = [
  { name: 'id', ddl: 'id TEXT PRIMARY KEY' },
  { name: 'task_number', ddl: 'task_number INTEGER NOT NULL DEFAULT 0' },
  { name: 'title', ddl: "title TEXT NOT NULL DEFAULT ''" },
  { name: 'tier', ddl: "tier TEXT NOT NULL DEFAULT 'immediate'" },
  { name: 'origin_id', ddl: 'origin_id TEXT' },
  { name: 'origin_number', ddl: 'origin_number INTEGER' },
  { name: 'origin_title', ddl: 'origin_title TEXT' },
  {
    name: 'created_at',
    ddl: "created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  },
  {
    name: 'updated_at',
    ddl: "updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  },
  { name: 'repository_id', ddl: 'repository_id TEXT NOT NULL' },
  { name: 'repository_name', ddl: 'repository_name TEXT NOT NULL' },
  { name: 'repository_path', ddl: 'repository_path TEXT NOT NULL' },
  { name: 'clone_url', ddl: 'clone_url TEXT' },
  { name: 'default_branch', ddl: "default_branch TEXT NOT NULL DEFAULT 'main'" },
  { name: 'prompt', ddl: 'prompt TEXT NOT NULL' },
  { name: 'requested_by', ddl: "requested_by TEXT NOT NULL DEFAULT 'web-ui'" },
  { name: 'actor', ddl: "actor TEXT NOT NULL DEFAULT 'user'" },
  { name: 'pr_policy', ddl: 'pr_policy TEXT' },
  { name: 'schedule_mode', ddl: "schedule_mode TEXT NOT NULL DEFAULT 'immediate'" },
  { name: 'required_labels_json', ddl: "required_labels_json TEXT NOT NULL DEFAULT '[]'" },
  { name: 'model', ddl: 'model TEXT NOT NULL' },
  { name: 'pool_family', ddl: 'pool_family TEXT NOT NULL' },
  { name: 'effort', ddl: "effort TEXT NOT NULL DEFAULT 'high'" },
  { name: 'allow_overage', ddl: 'allow_overage INTEGER NOT NULL DEFAULT 0' },
  { name: 'push_branch', ddl: 'push_branch INTEGER NOT NULL DEFAULT 1' },
  { name: 'auto_create_pr', ddl: 'auto_create_pr INTEGER NOT NULL DEFAULT 1' },
  { name: 'pr_url', ddl: 'pr_url TEXT' },
  { name: 'expires_at', ddl: 'expires_at TEXT' },
  { name: 'standing_task_id', ddl: 'standing_task_id TEXT' },
  { name: 'verify_command', ddl: 'verify_command TEXT' },
  { name: 'status', ddl: "status TEXT NOT NULL DEFAULT 'queued'" },
  { name: 'runner_id', ddl: 'runner_id TEXT' },
  { name: 'claimed_at', ddl: 'claimed_at TEXT' },
  { name: 'heartbeat_at', ddl: 'heartbeat_at TEXT' },
  { name: 'completed_at', ddl: 'completed_at TEXT' },
  { name: 'branch_name', ddl: 'branch_name TEXT' },
  { name: 'output', ddl: 'output TEXT' },
  { name: 'error', ddl: 'error TEXT' },
  { name: 'duration_ms', ddl: 'duration_ms INTEGER NOT NULL DEFAULT 0' },
  { name: 'num_turns', ddl: 'num_turns INTEGER' },
  { name: 'total_tokens', ddl: 'total_tokens INTEGER' },
  { name: 'thinking_tokens', ddl: 'thinking_tokens INTEGER' },
];

const BACKLOG_TASK_COLUMNS: readonly ColumnSpec[] = [
  { name: 'id', ddl: 'id TEXT PRIMARY KEY' },
  { name: 'task_number', ddl: 'task_number INTEGER NOT NULL DEFAULT 0' },
  { name: 'title', ddl: 'title TEXT NOT NULL' },
  { name: 'prompt', ddl: 'prompt TEXT NOT NULL' },
  { name: 'repository_id', ddl: 'repository_id TEXT NOT NULL' },
  { name: 'models_json', ddl: "models_json TEXT NOT NULL DEFAULT '[]'" },
  { name: 'effort', ddl: "effort TEXT NOT NULL DEFAULT 'high'" },
  { name: 'verify_command', ddl: 'verify_command TEXT' },
  { name: 'auto_create_pr', ddl: 'auto_create_pr INTEGER NOT NULL DEFAULT 1' },
  { name: 'actor', ddl: "actor TEXT NOT NULL DEFAULT 'bot'" },
  { name: 'priority_order', ddl: 'priority_order INTEGER NOT NULL DEFAULT 0' },
  { name: 'status', ddl: "status TEXT NOT NULL DEFAULT 'pending'" },
  { name: 'attempt_count', ddl: 'attempt_count INTEGER NOT NULL DEFAULT 0' },
  { name: 'max_attempts', ddl: 'max_attempts INTEGER NOT NULL DEFAULT 2' },
  { name: 'last_error', ddl: 'last_error TEXT' },
  { name: 'swarm_task_id', ddl: 'swarm_task_id TEXT' },
  { name: 'github_issue_number', ddl: 'github_issue_number INTEGER' },
  { name: 'github_issue_url', ddl: 'github_issue_url TEXT' },
  {
    name: 'created_at',
    ddl: "created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  },
  {
    name: 'updated_at',
    ddl: "updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  },
];

const ROUTINE_TASK_COLUMNS: readonly ColumnSpec[] = [
  { name: 'id', ddl: 'id TEXT PRIMARY KEY' },
  { name: 'task_number', ddl: 'task_number INTEGER NOT NULL DEFAULT 0' },
  { name: 'title', ddl: 'title TEXT NOT NULL' },
  { name: 'prompt', ddl: 'prompt TEXT NOT NULL' },
  { name: 'repository_id', ddl: 'repository_id TEXT NOT NULL' },
  { name: 'models_json', ddl: "models_json TEXT NOT NULL DEFAULT '[]'" },
  { name: 'effort', ddl: "effort TEXT NOT NULL DEFAULT 'high'" },
  { name: 'verify_command', ddl: 'verify_command TEXT' },
  { name: 'auto_create_pr', ddl: 'auto_create_pr INTEGER NOT NULL DEFAULT 1' },
  { name: 'actor', ddl: "actor TEXT NOT NULL DEFAULT 'bot'" },
  { name: 'pr_policy', ddl: 'pr_policy TEXT' },
  { name: 'enabled', ddl: 'enabled INTEGER NOT NULL DEFAULT 1' },
  { name: 'sort_order', ddl: 'sort_order INTEGER NOT NULL DEFAULT 0' },
  { name: 'trigger_before_reset_hours', ddl: 'trigger_before_reset_hours REAL NOT NULL DEFAULT 2' },
  { name: 'min_headroom_percent', ddl: 'min_headroom_percent REAL NOT NULL DEFAULT 10' },
  { name: 'last_triggered_reset_time', ddl: 'last_triggered_reset_time TEXT' },
  { name: 'last_task_id', ddl: 'last_task_id TEXT' },
  {
    name: 'created_at',
    ddl: "created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  },
  {
    name: 'updated_at',
    ddl: "updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  },
];

const SWARM_RUNNER_COLUMNS: readonly ColumnSpec[] = [
  { name: 'runner_id', ddl: 'runner_id TEXT PRIMARY KEY' },
  { name: 'name', ddl: 'name TEXT NOT NULL' },
  { name: 'token_hash', ddl: 'token_hash TEXT' },
  { name: 'labels_json', ddl: "labels_json TEXT NOT NULL DEFAULT '[]'" },
  { name: 'repositories_json', ddl: "repositories_json TEXT NOT NULL DEFAULT '[]'" },
  { name: 'system_info_json', ddl: "system_info_json TEXT NOT NULL DEFAULT '{}'" },
  { name: 'enabled', ddl: 'enabled INTEGER NOT NULL DEFAULT 1' },
  { name: 'active_task_id', ddl: 'active_task_id TEXT' },
  { name: 'status', ddl: "status TEXT NOT NULL DEFAULT 'idle'" },
  {
    name: 'registered_at',
    ddl: "registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  },
  {
    name: 'last_seen_at',
    ddl: "last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  },
];

const RUNNER_REGISTRATION_COLUMNS: readonly ColumnSpec[] = [
  { name: 'id', ddl: 'id TEXT PRIMARY KEY' },
  { name: 'token_hash', ddl: 'token_hash TEXT NOT NULL UNIQUE' },
  { name: 'name_hint', ddl: 'name_hint TEXT' },
  { name: 'labels_json', ddl: "labels_json TEXT NOT NULL DEFAULT '[]'" },
  { name: 'repositories_json', ddl: "repositories_json TEXT NOT NULL DEFAULT '[]'" },
  { name: 'expires_at', ddl: 'expires_at TEXT NOT NULL' },
  { name: 'created_at', ddl: 'created_at TEXT NOT NULL' },
  { name: 'consumed_by_runner_id', ddl: 'consumed_by_runner_id TEXT' },
  { name: 'consumed_at', ddl: 'consumed_at TEXT' },
];

const RUNTIME_STATE_COLUMNS: readonly ColumnSpec[] = [
  { name: 'key', ddl: 'key TEXT PRIMARY KEY' },
  { name: 'value', ddl: 'value TEXT' },
  { name: 'updated_at', ddl: 'updated_at TEXT NOT NULL' },
];

const SCHEMA_TABLES: ReadonlyArray<{ name: string; columns: readonly ColumnSpec[] }> = [
  { name: 'swarm_tasks', columns: SWARM_TASK_COLUMNS },
  { name: 'backlog_tasks', columns: BACKLOG_TASK_COLUMNS },
  { name: 'routine_tasks', columns: ROUTINE_TASK_COLUMNS },
  { name: 'swarm_runners', columns: SWARM_RUNNER_COLUMNS },
  { name: 'swarm_runner_registrations', columns: RUNNER_REGISTRATION_COLUMNS },
  { name: 'runtime_state', columns: RUNTIME_STATE_COLUMNS },
];

const SCHEMA_VERSION = 4;

const REGISTRATION_TOKEN_RETENTION = 50;

const TERMINAL_STATUS_SQL = TERMINAL_TASK_STATUSES.map((s) => `'${s}'`).join(', ');

// Patches are untyped JSON: a string `models` would make `models[0]` a single character.
const coerceModelList = (value: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(value)) return fallback;
  const list = value.map((v) => String(v).trim()).filter(Boolean);
  return list.length > 0 ? list : fallback;
};

const coerceNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const coerceNullableNumber = (value: unknown, fallback: number | null): number | null => {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fallback;
};

// The schemas carry defaults, so `undefined` must not be parsed: it means "keep the fallback".
const coerceEffort = (value: unknown, fallback: ReasoningEffort): ReasoningEffort => {
  if (value === undefined) return fallback;
  const parsed = ReasoningEffortSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
};

const coerceActor = (value: unknown, fallback: TaskActor): TaskActor => {
  if (value === undefined) return fallback;
  const parsed = TaskActorSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
};

const coerceBacklogStatus = (value: unknown, fallback: BacklogStatus): BacklogStatus => {
  if (value === undefined) return fallback;
  const parsed = BacklogStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
};

const coerceNullableString = (value: unknown, fallback: string | null): string | null =>
  typeof value === 'string' ? value : fallback;

/** Raised for every rejected one-time registration token, so callers can map it to a 401. */
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
      } catch {
        // Rollback best-effort
      }
      throw err;
    }
  }

  private initSchema(): void {
    this.rawDb.exec(`
      CREATE TABLE IF NOT EXISTS swarm_tasks (
${renderColumns(SWARM_TASK_COLUMNS)}
      );

      CREATE INDEX IF NOT EXISTS idx_swarm_tasks_queue
        ON swarm_tasks (status, created_at ASC);

      CREATE TABLE IF NOT EXISTS backlog_tasks (
${renderColumns(BACKLOG_TASK_COLUMNS)}
      );

      CREATE TABLE IF NOT EXISTS routine_tasks (
${renderColumns(ROUTINE_TASK_COLUMNS)}
      );

      CREATE TABLE IF NOT EXISTS swarm_runners (
${renderColumns(SWARM_RUNNER_COLUMNS)}
      );

      CREATE TABLE IF NOT EXISTS swarm_runner_registrations (
${renderColumns(RUNNER_REGISTRATION_COLUMNS)}
      );

      CREATE TABLE IF NOT EXISTS runtime_state (
${renderColumns(RUNTIME_STATE_COLUMNS)}
      );
    `);

    this.migrateSchema();
  }

  // Additively upgrades an existing database, except the two legacy renames that copy then drop.
  private migrateSchema(): void {
    // 1. Migrate legacy swarm_workers table to swarm_runners if present
    try {
      const hasOldWorkers = this.rawDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='swarm_workers'")
        .get();
      if (hasOldWorkers) {
        this.rawDb.exec(`
          INSERT OR IGNORE INTO swarm_runners (runner_id, name, token_hash, labels_json, repositories_json, system_info_json, enabled, active_task_id, status, registered_at, last_seen_at)
          SELECT worker_id, name, token_hash, labels_json, repositories_json, system_info_json, enabled, active_task_id, status, registered_at, last_seen_at FROM swarm_workers;
          DROP TABLE swarm_workers;
        `);
      }
    } catch (err) {
      logger.warn('Legacy swarm_workers migration failed: %s', err);
    }

    // worker_id only exists in pre-runner databases, so the statement is invalid elsewhere.
    try {
      const hasWorkerColumn = (
        this.rawDb.prepare('PRAGMA table_info(swarm_tasks)').all() as Array<{ name?: string }>
      ).some((column) => column.name === 'worker_id');
      if (hasWorkerColumn) {
        this.rawDb.exec(
          'UPDATE swarm_tasks SET runner_id = worker_id WHERE runner_id IS NULL AND worker_id IS NOT NULL'
        );
      }
    } catch (err) {
      logger.warn('Legacy worker_id backfill failed: %s', err);
    }

    // 2. Migrate legacy standing_tasks to routine_tasks if present
    try {
      const hasStanding = this.rawDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='standing_tasks'")
        .get();
      if (hasStanding) {
        const oldRows = this.rawDb.prepare('SELECT * FROM standing_tasks').all() as any[];
        for (let i = 0; i < oldRows.length; i++) {
          const row = oldRows[i];
          const modelsJson = JSON.stringify([row.model || 'gemini-3.8-flash']);
          this.rawDb
            .prepare(
              `INSERT OR IGNORE INTO routine_tasks (
                id, task_number, title, prompt, repository_id, models_json, effort,
                verify_command, auto_create_pr, actor, enabled, sort_order,
                trigger_before_reset_hours, min_headroom_percent,
                last_triggered_reset_time, last_task_id, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              row.id,
              i + 1,
              row.title,
              row.prompt,
              row.repository_id,
              modelsJson,
              row.effort || 'high',
              row.verify_command ?? null,
              row.auto_create_pr !== undefined ? row.auto_create_pr : 1,
              row.actor || 'bot',
              row.enabled !== undefined ? row.enabled : 1,
              row.sort_order || 0,
              row.trigger_before_reset_hours || 2,
              10,
              row.last_triggered_reset_time ?? null,
              row.last_task_id ?? null,
              row.created_at || new Date().toISOString(),
              row.updated_at || new Date().toISOString()
            );
        }
        this.rawDb.exec('DROP TABLE standing_tasks');
      }
    } catch (err) {
      logger.warn('Legacy standing_tasks migration failed: %s', err);
    }

    const versionRow = this.rawDb.prepare('PRAGMA user_version').get() as
      { user_version?: number } | undefined;
    const currentVersion = Number(versionRow?.user_version ?? 0);

    if (currentVersion > SCHEMA_VERSION) {
      logger.warn(
        'Database schema version %d is ahead of the known version %d; skipping migration',
        currentVersion,
        SCHEMA_VERSION
      );
      return;
    }

    for (const table of SCHEMA_TABLES) {
      migrateColumns(this.rawDb, table.name, table.columns);
    }

    // 3. Backfill sequential task_number on swarm_tasks if 0 or null
    try {
      this.rawDb.exec(`
        UPDATE swarm_tasks
        SET task_number = (
          SELECT count(*) FROM swarm_tasks t2 WHERE t2.rowid <= swarm_tasks.rowid
        )
        WHERE task_number IS NULL OR task_number = 0;
      `);
    } catch (err) {
      logger.warn('task_number backfill failed: %s', err);
    }

    // 4. Backfill human-readable title on swarm_tasks if empty
    try {
      const untitled = this.rawDb
        .prepare("SELECT id, prompt FROM swarm_tasks WHERE title IS NULL OR title = ''")
        .all() as any[];
      for (const r of untitled) {
        const firstLine = (
          String(r.prompt || '')
            .trim()
            .split('\n')[0] ?? ''
        )
          .trim()
          .slice(0, 100);
        this.rawDb
          .prepare('UPDATE swarm_tasks SET title = ? WHERE id = ?')
          .run(firstLine || 'Task', r.id);
      }
    } catch (err) {
      logger.warn('title backfill failed: %s', err);
    }

    // 5. Backfill tier and origin information from legacy standing task runs
    try {
      const standingRuns = this.rawDb
        .prepare(
          "SELECT id, requested_by, standing_task_id FROM swarm_tasks WHERE tier = 'immediate' AND (requested_by LIKE 'standing-task:%' OR standing_task_id IS NOT NULL)"
        )
        .all() as any[];
      for (const r of standingRuns) {
        const originId =
          r.standing_task_id ||
          (r.requested_by ? String(r.requested_by).replace(/^standing-task:/, '') : undefined);
        if (originId) {
          const routine = this.rawDb
            .prepare('SELECT task_number, title FROM routine_tasks WHERE id = ?')
            .get(originId) as any;
          this.rawDb
            .prepare(
              "UPDATE swarm_tasks SET tier = 'routine', origin_id = ?, origin_number = ?, origin_title = ? WHERE id = ?"
            )
            .run(originId, routine?.task_number ?? null, routine?.title ?? null, r.id);
        }
      }
    } catch (err) {
      logger.warn('tier/origin backfill failed: %s', err);
    }

    if (currentVersion < SCHEMA_VERSION) {
      this.rawDb.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  // Runtime counters that outlive a restart, kept out of `settings` so they never look like overrides.
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

  // Deletes consumed or expired registration rows beyond the most-recent `keepCount` entries.
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
    } catch {
      // Best-effort pruning
    }
  }

  // Exchanges a valid, unexpired one-time registration token for a persistent runner identity
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

      if (regRow.consumed_by_runner_id) {
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

      this.rawDb
        .prepare(
          `UPDATE swarm_runner_registrations
           SET consumed_by_runner_id = ?, consumed_at = ?
           WHERE id = ?`
        )
        .run(runnerId, nowIso, String(regRow.id));

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
            enabled = 1,
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

  // Authenticates a runner request using its unique `agyr_run_...` token
  public authenticateRunner(
    providedToken: string | undefined,
    fallbackSharedSecret?: string
  ): { authenticated: boolean; runner?: SwarmRunnerRecord; viaSharedSecret?: boolean } {
    const cleanToken = providedToken?.trim() || '';
    const cleanShared = fallbackSharedSecret?.trim() || '';

    // Require a valid runner token (hash match) or valid configured fallback shared secret
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

  // Revokes a runner, deleting its record and credentials from `swarm_runners`.
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
    const now = new Date().toISOString();
    const repoId = (input.repositoryId || input.repositoryName).trim();
    const repoName = input.repositoryName.trim();
    const repoPath = (input.repositoryPath || `/repos/${repoId}`).trim();
    const defaultBranch = (input.defaultBranch || 'main').trim();
    // Bounded, not truncated for real input: GitHub's own issue body limit is 65536.
    const prompt = input.prompt.slice(0, 20000);
    const requestedBy = (input.requestedBy || 'web-ui').trim();
    const actor: TaskActor = input.actor ?? 'user';
    const prPolicy = input.prPolicy ?? null;
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

    const maxNumberRow = this.rawDb
      .prepare('SELECT MAX(task_number) as max_num FROM swarm_tasks')
      .get() as { max_num?: number } | undefined;
    const taskNumber = input.taskNumber ?? (maxNumberRow?.max_num ?? 0) + 1;
    const firstLinePrompt = (prompt.split('\n')[0] ?? '').trim().slice(0, 100);
    const title = (input.title || firstLinePrompt || 'Task').trim();
    const tier: TaskTier = input.tier ?? 'immediate';
    const originId = input.originId ?? input.standingTaskId ?? null;
    const originNumber = input.originNumber ?? null;
    const originTitle = input.originTitle ?? null;

    this.rawDb
      .prepare(
        `INSERT INTO swarm_tasks (
          id, task_number, title, tier, origin_id, origin_number, origin_title,
          created_at, updated_at, repository_id, repository_name, repository_path,
          clone_url, default_branch, prompt, requested_by, actor, pr_policy, schedule_mode,
          required_labels_json, model, pool_family, effort, allow_overage, push_branch,
          auto_create_pr, expires_at, standing_task_id, verify_command, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`
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
        actor,
        prPolicy,
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
           WHERE status IN (${TERMINAL_STATUS_SQL})
             AND id NOT IN (
               SELECT id FROM swarm_tasks
               WHERE status IN (${TERMINAL_STATUS_SQL})
               ORDER BY updated_at DESC
               LIMIT ?
             )`
        )
        .run(keepTerminalCount);
    } catch {
      // Best-effort pruning
    }
  }

  // Without this the list grows a row every time a container is recreated, since a runner
  // re-registers on boot. Age-gated rather than immediate so the offline transition stays visible
  // for a while after the reaper makes it. Live runners are never touched.
  public pruneOldRunners(maxOfflineAgeMs = 10 * 60 * 1000): void {
    try {
      const cutoff = new Date(Date.now() - maxOfflineAgeMs).toISOString();
      this.rawDb
        .prepare(
          "DELETE FROM swarm_runners WHERE status = 'offline' AND token_hash IS NULL AND last_seen_at < ?"
        )
        .run(cutoff);
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

  // Atomically claims the next eligible queued task for a runner.
  public claimNext(options: ClaimTaskOptions): SwarmTask | null {
    return this.inTransaction(() => {
      const existingRunner = this.getRunner(options.runnerId);
      // A registered runner's scope is its registration; the poll payload may only narrow
      // an unregistered (shared-secret) runner's view, and must never widen a registration.
      const effectiveLabels =
        existingRunner?.labels ??
        (options.labels && options.labels.length > 0 ? options.labels : []);
      const runnerLabelSet = new Set(effectiveLabels.map((l) => l.toLowerCase()));

      const effectiveRepos =
        existingRunner?.repositories ??
        (options.repositories && options.repositories.length > 0 ? options.repositories : []);
      if (existingRunner && !existingRunner.enabled) {
        this.registerRunnerHeartbeat({
          runnerId: options.runnerId,
          name: options.runnerName,
          labels: effectiveLabels,
          repositories: effectiveRepos,
          systemInfo: options.systemInfo,
          status: 'idle',
        });
        return null;
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

        // Check required labels (if task specifies labels, runner must have all of them)
        if (task.requiredLabels.length > 0) {
          const hasAllLabels = task.requiredLabels.every((reqLabel) =>
            runnerLabelSet.has(reqLabel.toLowerCase())
          );
          if (!hasAllLabels) {
            continue;
          }
        }

        // Check repository capability filter if runner specified a subset
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
                 runner_id = ?,
                 model = ?,
                 pool_family = ?,
                 claimed_at = ?,
                 heartbeat_at = ?,
                 updated_at = ?
             WHERE id = ? AND status = 'queued'`
          )
          .run(
            options.runnerId,
            updatedModel,
            resolvePoolFamilyForModel(updatedModel),
            now,
            now,
            now,
            task.id
          ) as unknown as { changes?: number };

        if ((updateResult?.changes ?? 0) > 0) {
          this.registerRunnerHeartbeat({
            runnerId: options.runnerId,
            name: options.runnerName,
            labels: effectiveLabels,
            repositories: effectiveRepos,
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
        labels: effectiveLabels,
        repositories: effectiveRepos,
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

    // Guard against status updates on already terminal tasks
    const existingTerminal = isTerminalTaskStatus(existing.status);
    if (existingTerminal) {
      return refused;
    }

    // Active states are only ever entered through claimNext.
    const patchIsActive = patch.status === 'claimed' || patch.status === 'executing';
    if (patchIsActive && existing.status === 'queued') {
      return refused;
    }

    // Ownership: a runner patch must match the row's current owner; an unowned row may only be
    // patched while it is still queued.
    if (patch.runnerId) {
      if (existing.runnerId !== undefined) {
        if (existing.runnerId !== patch.runnerId) return refused;
      } else if (existing.status !== 'queued') {
        return refused;
      }
    }

    const now = new Date().toISOString();
    const isTerminal = isTerminalTaskStatus(patch.status);
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
    const runnerId = patch.runnerId ?? existing.runnerId ?? null;
    const numTurns = patch.numTurns !== undefined ? patch.numTurns : (existing.numTurns ?? null);
    const totalTokens =
      patch.totalTokens !== undefined ? patch.totalTokens : (existing.totalTokens ?? null);
    const thinkingTokens =
      patch.thinkingTokens !== undefined ? patch.thinkingTokens : (existing.thinkingTokens ?? null);

    // Ownership and the queued->active guard sit in the predicate so the check and write are atomic.
    const updateResult = this.rawDb
      .prepare(
        `UPDATE swarm_tasks
         SET status = ?,
             runner_id = ?,
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
         WHERE id = ?
           AND (runner_id IS NULL OR runner_id = ?)
           AND NOT (status = 'queued' AND ? IN ('claimed', 'executing'))`
      )
      .run(
        patch.status,
        runnerId,
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
        taskId,
        runnerId,
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

  // Fails tasks whose runner lease heartbeat has expired and marks stale runners offline.
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
        // Report real elapsed work time; the lease age is only a fallback when claimedAt is unknown.
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

    // Mark runners that haven't sent a heartbeat within threshold as offline
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
    // Preserving last_seen_at keeps the offline sweep honest when the reaper updates runner state.
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
      runnerId: String(r.runner_id || r.worker_id),
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

    const firstLinePrompt = (
      String(row.prompt || '')
        .trim()
        .split('\n')[0] ?? ''
    )
      .trim()
      .slice(0, 100);
    const title = row.title ? String(row.title) : firstLinePrompt || 'Task';

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
      actor: (row.actor as TaskActor) || 'user',
      prPolicy: (row.pr_policy as PrPolicy) || undefined,
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

  // --- Backlog Tasks CRUD Methods ---

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

  // Dispatched rows, for the reconciler that settles the ones no runner ever reported.
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
    models?: string[];
    effort?: ReasoningEffort;
    verifyCommand?: string;
    autoCreatePr?: boolean;
    actor?: TaskActor;
    priorityOrder?: number;
    maxAttempts?: number;
    githubIssueNumber?: number;
    githubIssueUrl?: string;
  }): BacklogTaskRecord {
    const id = input.id ?? `backlog-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const maxNumberRow = this.rawDb
      .prepare('SELECT MAX(task_number) as max_num FROM backlog_tasks')
      .get() as { max_num?: number } | undefined;
    const taskNumber = input.taskNumber ?? (maxNumberRow?.max_num ?? 0) + 1;
    const models = coerceModelList(input.models, ['gemini-3.8-flash']);
    const effort: ReasoningEffort = coerceEffort(input.effort, 'high');
    const autoCreatePr = input.autoCreatePr !== false ? 1 : 0;
    const actor: TaskActor = coerceActor(input.actor, 'bot');
    const priorityOrder = coerceNumber(input.priorityOrder, 0);
    const maxAttempts = coerceNumber(input.maxAttempts, 2);

    this.rawDb
      .prepare(
        `INSERT INTO backlog_tasks (
          id, task_number, title, prompt, repository_id, models_json, effort,
          verify_command, auto_create_pr, actor, priority_order, status,
          attempt_count, max_attempts, github_issue_number, github_issue_url,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        taskNumber,
        input.title.trim(),
        input.prompt.trim(),
        input.repositoryId.trim(),
        JSON.stringify(models),
        effort,
        input.verifyCommand ?? null,
        autoCreatePr,
        actor,
        priorityOrder,
        maxAttempts,
        input.githubIssueNumber ?? null,
        input.githubIssueUrl ?? null,
        now,
        now
      );

    return this.getBacklogTask(id)!;
  }

  public updateBacklogTask(
    id: string,
    patch: Partial<{
      title: string;
      prompt: string;
      repositoryId: string;
      models: string[];
      effort: ReasoningEffort;
      verifyCommand: string | null;
      autoCreatePr: boolean;
      actor: TaskActor;
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
    const title = patch.title !== undefined ? patch.title.trim() : existing.title;
    const prompt = patch.prompt !== undefined ? patch.prompt.trim() : existing.prompt;
    const repositoryId =
      patch.repositoryId !== undefined ? patch.repositoryId.trim() : existing.repositoryId;
    const modelsJson = JSON.stringify(
      patch.models !== undefined ? coerceModelList(patch.models, existing.models) : existing.models
    );
    const effort = coerceEffort(patch.effort ?? existing.effort, existing.effort);
    const verifyCommand = coerceNullableString(patch.verifyCommand, existing.verifyCommand ?? null);
    const autoCreatePr =
      typeof patch.autoCreatePr === 'boolean'
        ? patch.autoCreatePr
          ? 1
          : 0
        : existing.autoCreatePr
          ? 1
          : 0;
    const actor = coerceActor(patch.actor ?? existing.actor, existing.actor);
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
             effort = ?,
             verify_command = ?,
             auto_create_pr = ?,
             actor = ?,
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
        modelsJson,
        effort,
        verifyCommand,
        autoCreatePr,
        actor,
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
    let models: string[] = [];
    try {
      models = JSON.parse(String(r.models_json || '[]'));
    } catch {}
    if (models.length === 0) {
      models = ['gemini-3.8-flash'];
    }

    return {
      id: String(r.id),
      taskNumber: Number(r.task_number || 0),
      title: String(r.title),
      prompt: String(r.prompt),
      repositoryId: String(r.repository_id),
      models,
      effort: (r.effort as ReasoningEffort) || 'high',
      verifyCommand: r.verify_command ? String(r.verify_command) : undefined,
      autoCreatePr: r.auto_create_pr !== 0,
      actor: (r.actor as TaskActor) || 'bot',
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

  // --- Routine Tasks CRUD Methods ---

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
    models?: string[];
    effort?: ReasoningEffort;
    verifyCommand?: string;
    autoCreatePr?: boolean;
    actor?: TaskActor;
    prPolicy?: PrPolicy | null;
    enabled?: boolean;
    sortOrder?: number;
    triggerBeforeResetHours?: number;
    minHeadroomPercent?: number;
  }): RoutineTaskRecord {
    const id = input.id ?? `routine-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const maxNumberRow = this.rawDb
      .prepare('SELECT MAX(task_number) as max_num FROM routine_tasks')
      .get() as { max_num?: number } | undefined;
    const taskNumber = input.taskNumber ?? (maxNumberRow?.max_num ?? 0) + 1;
    const models = coerceModelList(input.models, ['gemini-3.8-flash']);
    const effort: ReasoningEffort = coerceEffort(input.effort, 'high');
    const autoCreatePr = input.autoCreatePr !== false ? 1 : 0;
    const actor: TaskActor = coerceActor(input.actor, 'bot');
    const prPolicy =
      input.prPolicy === 'docs_only' || input.prPolicy === 'all' || input.prPolicy === 'none'
        ? input.prPolicy
        : null;
    const enabled = input.enabled !== false ? 1 : 0;
    const sortOrder = coerceNumber(input.sortOrder, 0);
    const triggerHours = coerceNumber(input.triggerBeforeResetHours, 2);
    const minHeadroom = coerceNumber(input.minHeadroomPercent, 10);

    this.rawDb
      .prepare(
        `INSERT INTO routine_tasks (
          id, task_number, title, prompt, repository_id, models_json, effort,
          verify_command, auto_create_pr, actor, pr_policy, enabled, sort_order,
          trigger_before_reset_hours, min_headroom_percent, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        taskNumber,
        input.title.trim(),
        input.prompt.trim(),
        input.repositoryId.trim(),
        JSON.stringify(models),
        effort,
        input.verifyCommand ?? null,
        autoCreatePr,
        actor,
        prPolicy,
        enabled,
        sortOrder,
        triggerHours,
        minHeadroom,
        now,
        now
      );

    return this.getRoutineTask(id)!;
  }

  public updateRoutineTask(
    id: string,
    patch: Partial<{
      title: string;
      prompt: string;
      repositoryId: string;
      models: string[];
      effort: ReasoningEffort;
      verifyCommand: string | null;
      autoCreatePr: boolean;
      actor: TaskActor;
      prPolicy: PrPolicy | null;
      enabled: boolean;
      sortOrder: number;
      triggerBeforeResetHours: number;
      minHeadroomPercent: number;
      lastTriggeredResetTime: string | null;
      lastTaskId: string | null;
    }>
  ): RoutineTaskRecord | undefined {
    const existing = this.getRoutineTask(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const title = patch.title !== undefined ? patch.title.trim() : existing.title;
    const prompt = patch.prompt !== undefined ? patch.prompt.trim() : existing.prompt;
    const repositoryId =
      patch.repositoryId !== undefined ? patch.repositoryId.trim() : existing.repositoryId;
    const modelsJson = JSON.stringify(
      patch.models !== undefined ? coerceModelList(patch.models, existing.models) : existing.models
    );
    const effort = coerceEffort(patch.effort ?? existing.effort, existing.effort);
    const verifyCommand = coerceNullableString(patch.verifyCommand, existing.verifyCommand ?? null);
    const autoCreatePr =
      typeof patch.autoCreatePr === 'boolean'
        ? patch.autoCreatePr
          ? 1
          : 0
        : existing.autoCreatePr
          ? 1
          : 0;
    const actor = coerceActor(patch.actor ?? existing.actor, existing.actor);
    const prPolicy =
      patch.prPolicy === null
        ? null
        : patch.prPolicy === 'docs_only' || patch.prPolicy === 'all' || patch.prPolicy === 'none'
          ? patch.prPolicy
          : (existing.prPolicy ?? null);
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
    const lastTaskId = coerceNullableString(patch.lastTaskId, existing.lastTaskId ?? null);

    this.rawDb
      .prepare(
        `UPDATE routine_tasks
         SET title = ?,
             prompt = ?,
             repository_id = ?,
             models_json = ?,
             effort = ?,
             verify_command = ?,
             auto_create_pr = ?,
             actor = ?,
             pr_policy = ?,
             enabled = ?,
             sort_order = ?,
             trigger_before_reset_hours = ?,
             min_headroom_percent = ?,
             last_triggered_reset_time = ?,
             last_task_id = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        title,
        prompt,
        repositoryId,
        modelsJson,
        effort,
        verifyCommand,
        autoCreatePr,
        actor,
        prPolicy,
        enabled,
        sortOrder,
        triggerHours,
        minHeadroom,
        lastReset,
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
    let models: string[] = [];
    try {
      models = JSON.parse(String(r.models_json || '[]'));
    } catch {}
    if (models.length === 0) {
      models = ['gemini-3.8-flash'];
    }

    return {
      id: String(r.id),
      taskNumber: Number(r.task_number || 0),
      title: String(r.title),
      prompt: String(r.prompt),
      repositoryId: String(r.repository_id),
      models,
      effort: (r.effort as ReasoningEffort) || 'high',
      verifyCommand: r.verify_command ? String(r.verify_command) : undefined,
      autoCreatePr: r.auto_create_pr !== 0,
      actor: (r.actor as TaskActor) || 'bot',
      prPolicy: (r.pr_policy as PrPolicy) || undefined,
      enabled: r.enabled !== 0,
      sortOrder: Number(r.sort_order ?? 0),
      triggerBeforeResetHours: Number(r.trigger_before_reset_hours ?? 2),
      minHeadroomPercent: Number(r.min_headroom_percent ?? 10),
      lastTriggeredResetTime: r.last_triggered_reset_time
        ? String(r.last_triggered_reset_time)
        : undefined,
      lastTaskId: r.last_task_id ? String(r.last_task_id) : undefined,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
}
