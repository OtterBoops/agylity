import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppDatabase } from '../storage/db.js';
import { renderColumns, type ColumnSpec } from '../storage/schema.js';
import { LEGACY_POOL_FAMILY_IDS, upgradePoolFamilyId } from '../shared/models.js';
import type { QuotaFamily } from '../sentry/models.js';
import type { PrPolicy } from '../config/schema.js';
import { DEFAULT_QUOTA_BURN_MAX_HOURS } from '../config/schema.js';
import {
  BacklogStatusSchema,
  CATALOG_BY_ID,
  normalizeCascade,
  resolvePoolFamilyForModel,
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
import { logger } from '../logs/logger.js';
import { ensureSentryStateSchema } from '../sentry/store.js';

export type { TaskTier, BacklogStatus };

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
  prPolicy?: PrPolicy;
  scheduleMode: ScheduleMode;
  requiredLabels: string[];
  model: string;
  cascade: CascadeHop[];
  poolFamily: QuotaFamily;
  effort: ReasoningEffort;
  allowOverage: boolean;
  pushBranch: boolean;
  autoCreatePr: boolean;
  prUrl?: string;
  expiresAt?: string;
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
  branchName?: string;
  prUrl?: string;
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
  cascade: CascadeHop[];
  verifyCommand?: string;
  autoCreatePr: boolean;
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
  cascade: CascadeHop[];
  verifyCommand?: string;
  autoCreatePr: boolean;
  prPolicy?: PrPolicy;
  enabled: boolean;
  sortOrder: number;
  triggerBeforeResetHours: number;
  minHeadroomPercent: number;
  lastTriggeredResetTime?: string;
  lastTriggeredCycles: Record<string, string>;
  lastTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

export const hashRunnerToken = (token: string): string =>
  createHash('sha256').update(token.trim()).digest('hex');

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
  { name: 'pr_policy', ddl: "pr_policy TEXT NOT NULL DEFAULT 'inherit'" },
  { name: 'schedule_mode', ddl: "schedule_mode TEXT NOT NULL DEFAULT 'immediate'" },
  { name: 'required_labels_json', ddl: "required_labels_json TEXT NOT NULL DEFAULT '[]'" },
  { name: 'model', ddl: 'model TEXT NOT NULL' },
  { name: 'candidate_models_json', ddl: "candidate_models_json TEXT NOT NULL DEFAULT '[]'" },
  { name: 'pool_family', ddl: 'pool_family TEXT NOT NULL' },
  { name: 'effort', ddl: "effort TEXT NOT NULL DEFAULT 'high'" },
  { name: 'allow_overage', ddl: 'allow_overage INTEGER NOT NULL DEFAULT 0' },
  { name: 'push_branch', ddl: 'push_branch INTEGER NOT NULL DEFAULT 1' },
  { name: 'auto_create_pr', ddl: 'auto_create_pr INTEGER NOT NULL DEFAULT 1' },
  { name: 'pr_url', ddl: 'pr_url TEXT' },
  { name: 'expires_at', ddl: 'expires_at TEXT' },
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

const TASK_LIST_COLUMNS = SWARM_TASK_COLUMNS.filter((column) => column.name !== 'output')
  .map((column) => column.name)
  .join(', ');

const OUTPUT_CAP = 512 * 1024;

/** Keeps the tail, which is where a failure explains itself, and says how much was dropped. */
const capOutput = (text: string, cap: number = OUTPUT_CAP): string => {
  if (text.length <= cap) return text;
  const kept = text.slice(-cap);
  return `[truncated ${text.length - kept.length} bytes]\n${kept}`;
};

/** The last `cap` UTF-16 units, nudged off a surrogate pair so the head never renders as U+FFFD. */
export const tailWindow = (text: string, cap: number): string => {
  let start = Math.max(0, text.length - cap);
  if (start > 0) {
    const code = text.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) start -= 1;
  }
  return text.slice(start);
};

const BACKLOG_TASK_COLUMNS: readonly ColumnSpec[] = [
  { name: 'id', ddl: 'id TEXT PRIMARY KEY' },
  { name: 'task_number', ddl: 'task_number INTEGER NOT NULL DEFAULT 0' },
  { name: 'title', ddl: 'title TEXT NOT NULL' },
  { name: 'prompt', ddl: 'prompt TEXT NOT NULL' },
  { name: 'repository_id', ddl: 'repository_id TEXT NOT NULL' },
  { name: 'models_json', ddl: "models_json TEXT NOT NULL DEFAULT '[]'" },
  { name: 'verify_command', ddl: 'verify_command TEXT' },
  { name: 'auto_create_pr', ddl: 'auto_create_pr INTEGER NOT NULL DEFAULT 1' },
  { name: 'pr_policy', ddl: "pr_policy TEXT NOT NULL DEFAULT 'inherit'" },
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
  { name: 'verify_command', ddl: 'verify_command TEXT' },
  { name: 'auto_create_pr', ddl: 'auto_create_pr INTEGER NOT NULL DEFAULT 1' },
  { name: 'pr_policy', ddl: "pr_policy TEXT NOT NULL DEFAULT 'inherit'" },
  { name: 'enabled', ddl: 'enabled INTEGER NOT NULL DEFAULT 1' },
  { name: 'sort_order', ddl: 'sort_order INTEGER NOT NULL DEFAULT 0' },
  {
    name: 'trigger_before_reset_hours',
    ddl: `trigger_before_reset_hours REAL NOT NULL DEFAULT ${DEFAULT_QUOTA_BURN_MAX_HOURS}`,
  },
  { name: 'min_headroom_percent', ddl: 'min_headroom_percent REAL NOT NULL DEFAULT 10' },
  { name: 'last_triggered_reset_time', ddl: 'last_triggered_reset_time TEXT' },
  {
    name: 'last_triggered_cycles_json',
    ddl: "last_triggered_cycles_json TEXT NOT NULL DEFAULT '{}'",
  },
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

const SCHEMA_MIGRATIONS_COLUMNS: readonly ColumnSpec[] = [
  { name: 'version', ddl: 'version INTEGER PRIMARY KEY' },
  { name: 'name', ddl: 'name TEXT NOT NULL' },
  { name: 'applied_at', ddl: 'applied_at TEXT NOT NULL' },
];

// Indexes are part of the schema, so they live in a migration and never in a boot-time repair.
const V1_INDEXES = `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_swarm_tasks_number ON swarm_tasks (task_number);
      CREATE INDEX IF NOT EXISTS idx_swarm_tasks_queue ON swarm_tasks (status, created_at ASC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_backlog_tasks_number ON backlog_tasks (task_number);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_tasks_number ON routine_tasks (task_number);
    `;

interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

/** A fresh database is built from the current column specs, so the ALTERs must tolerate re-running. */
const tableHasColumn = (db: DatabaseSync, table: string, column: string): boolean => {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return rows.some((row) => String(row.name) === column);
};

const legacyHopEffort = (model: string): ReasoningEffort =>
  CATALOG_BY_ID.get(model)?.defaultEffort ?? 'medium';

const upgradeStoredChain = (raw: unknown): string | null => {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  let changed = false;
  const seen = new Set<string>();
  const hops: CascadeHop[] = [];

  for (const entry of parsed) {
    if (typeof entry === 'string') {
      changed = true;
      const model = entry.trim();
      if (model === '' || seen.has(model)) continue;
      seen.add(model);
      hops.push({ model, effort: legacyHopEffort(model) });
      continue;
    }
    if (!entry || typeof entry !== 'object') {
      changed = true;
      continue;
    }
    const hop = entry as { model?: unknown; effort?: unknown };
    const model = typeof hop.model === 'string' ? hop.model.trim() : '';
    if (model === '' || seen.has(model)) {
      changed = true;
      continue;
    }
    seen.add(model);
    hops.push({
      model,
      effort: resolveReasoningEffortForModel(
        model,
        typeof hop.effort === 'string' ? hop.effort : undefined
      ),
    });
  }

  return changed ? JSON.stringify(hops) : null;
};

const rewriteChainColumn = (db: DatabaseSync, table: string, column: string): void => {
  const rows = db
    .prepare(`SELECT rowid AS row_id, ${column} AS chain FROM ${table}`)
    .all() as Array<{
    row_id?: number;
    chain?: unknown;
  }>;
  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
  let rewritten = 0;
  for (const row of rows) {
    const next = upgradeStoredChain(row.chain);
    if (next === null) continue;
    update.run(next, Number(row.row_id));
    rewritten += 1;
  }
  if (rewritten > 0) {
    logger.info(
      'Migration v3: rewrote %d legacy %s.%s row(s) into cascade hops',
      rewritten,
      table,
      column
    );
  }
};

const tableExists = (db: DatabaseSync, table: string): boolean =>
  db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
  undefined;

// A pool id is the family or `family:slug`, so only the prefix carries the family name. The id is a
// primary or unique key in every table it appears, so a row already carrying the new id wins and the
// legacy duplicate is dropped instead of failing the boot.
const renameLegacyPoolIds = (db: DatabaseSync, table: string, column = 'pool_id'): void => {
  if (!tableExists(db, table) || !tableHasColumn(db, table, column)) return;
  let renamed = 0;
  for (const legacy of LEGACY_POOL_FAMILY_IDS) {
    const upgraded = upgradePoolFamilyId(legacy);
    const match = `${column} = ? OR ${column} LIKE ?`;
    const info = db
      .prepare(`UPDATE OR IGNORE ${table} SET ${column} = ? || substr(${column}, ?) WHERE ${match}`)
      .run(upgraded, legacy.length + 1, legacy, `${legacy}:%`) as unknown as { changes?: number };
    renamed += Number(info?.changes ?? 0);
    db.prepare(`DELETE FROM ${table} WHERE ${match}`).run(legacy, `${legacy}:%`);
  }
  if (renamed > 0) {
    logger.info('Migration v4: renamed %d legacy %s.%s row(s)', renamed, table, column);
  }
};

const renameLegacyTaskPoolFamilies = (db: DatabaseSync): void => {
  if (!tableExists(db, 'swarm_tasks') || !tableHasColumn(db, 'swarm_tasks', 'pool_family')) return;
  for (const legacy of LEGACY_POOL_FAMILY_IDS) {
    db.prepare('UPDATE swarm_tasks SET pool_family = ? WHERE pool_family = ?').run(
      upgradePoolFamilyId(legacy),
      legacy
    );
  }
};

// Cycle stamps are keyed by pool id, so a stale key silently re-arms the routine inside the same
// cycle and burns quota a second time.
const renameLegacyRoutineCycleKeys = (db: DatabaseSync): void => {
  if (!tableExists(db, 'routine_tasks')) return;
  if (!tableHasColumn(db, 'routine_tasks', 'last_triggered_cycles_json')) return;
  const rows = db
    .prepare('SELECT rowid AS row_id, last_triggered_cycles_json AS cycles FROM routine_tasks')
    .all() as Array<{ row_id?: number; cycles?: unknown }>;
  const update = db.prepare(
    'UPDATE routine_tasks SET last_triggered_cycles_json = ? WHERE rowid = ?'
  );
  for (const row of rows) {
    if (typeof row.cycles !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.cycles);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const cycles: Record<string, unknown> = {};
    let changed = false;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const upgraded = upgradePoolFamilyId(key);
      if (upgraded !== key) changed = true;
      cycles[upgraded] = value;
    }
    if (changed) update.run(JSON.stringify(cycles), Number(row.row_id));
  }
};

const renameLegacyNoticePoolIds = (db: DatabaseSync): void => {
  if (!tableExists(db, 'early_reset_notice')) return;
  const row = db.prepare('SELECT pools_json FROM early_reset_notice WHERE id = 1').get() as
    { pools_json?: string } | undefined;
  if (typeof row?.pools_json !== 'string') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.pools_json);
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  let changed = false;
  const pools = parsed.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const pool = entry as Record<string, unknown>;
    if (typeof pool.poolId !== 'string') return entry;
    const upgraded = upgradePoolFamilyId(pool.poolId);
    if (upgraded === pool.poolId) return entry;
    changed = true;
    return { ...pool, poolId: upgraded };
  });
  if (!changed) return;
  db.prepare('UPDATE early_reset_notice SET pools_json = ? WHERE id = 1').run(
    JSON.stringify(pools)
  );
};

// Config overrides live as one JSON row in `settings`, not in a table of their own.
const renameLegacyPoolPolicyKeys = (db: DatabaseSync): void => {
  if (!tableExists(db, 'settings')) return;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'poolPolicies'").get() as
    { value?: string } | undefined;
  if (typeof row?.value !== 'string') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const policies = { ...(parsed as Record<string, unknown>) };
  let changed = false;
  for (const legacy of LEGACY_POOL_FAMILY_IDS) {
    if (policies[legacy] === undefined) continue;
    const upgraded = upgradePoolFamilyId(legacy);
    if (policies[upgraded] === undefined) policies[upgraded] = policies[legacy];
    delete policies[legacy];
    changed = true;
  }
  if (!changed) return;
  db.prepare(
    "UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'poolPolicies'"
  ).run(JSON.stringify(policies));
};

const migrateLegacyPoolFamily = (db: DatabaseSync): void => {
  for (const table of ['pool_state', 'pool_milestones', 'pool_samples', 'alert_events']) {
    renameLegacyPoolIds(db, table);
  }
  renameLegacyNoticePoolIds(db);
  renameLegacyTaskPoolFamilies(db);
  renameLegacyRoutineCycleKeys(db);
  renameLegacyPoolPolicyKeys(db);
};

// Forward-only. A shipped migration is never edited; a schema change is a new version.
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'v1_baseline',
    up: (db) => {
      for (const table of SCHEMA_TABLES) {
        db.exec(
          `CREATE TABLE IF NOT EXISTS ${table.name} (\n${renderColumns(table.columns)}\n      )`
        );
      }
      db.exec(V1_INDEXES);
    },
  },
  {
    version: 2,
    name: 'v2_sentry_state',
    up: (db) => {
      ensureSentryStateSchema(db);
    },
  },
  {
    version: 3,
    name: 'v3_cascade_hops',
    up: (db) => {
      for (const target of [
        { table: 'swarm_tasks', column: 'candidate_models_json' },
        { table: 'backlog_tasks', column: 'models_json' },
        { table: 'routine_tasks', column: 'models_json' },
      ]) {
        if (!tableHasColumn(db, target.table, target.column)) continue;
        rewriteChainColumn(db, target.table, target.column);
      }

      for (const table of ['backlog_tasks', 'routine_tasks']) {
        if (!tableHasColumn(db, table, 'effort')) continue;
        try {
          db.exec(`ALTER TABLE ${table} DROP COLUMN effort`);
        } catch (dropErr: any) {
          logger.error(
            'Migration v3 could not drop %s.effort (%s); the column is left in place unread',
            table,
            dropErr?.message ?? dropErr
          );
        }
      }
    },
  },
  {
    version: 4,
    name: 'v4_pool_family_hydrogen',
    up: (db) => {
      migrateLegacyPoolFamily(db);
    },
  },
];

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
    this.rawDb.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (\n${renderColumns(SCHEMA_MIGRATIONS_COLUMNS)}\n      )`
    );
    this.applyMigrations();
  }

  private applyMigrations(): void {
    const applied = new Set(
      (
        this.rawDb.prepare('SELECT version FROM schema_migrations').all() as Array<{
          version?: number;
        }>
      ).map((row) => Number(row.version))
    );
    const record = this.rawDb.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.rawDb.exec('BEGIN IMMEDIATE');
      try {
        migration.up(this.rawDb);
        record.run(migration.version, migration.name, new Date().toISOString());
        this.rawDb.exec('COMMIT');
        logger.info('Applied schema migration %d (%s)', migration.version, migration.name);
      } catch (err) {
        try {
          this.rawDb.exec('ROLLBACK');
        } catch {}
        throw err;
      }
    }
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
    const poolFamily = resolvePoolFamilyForModel(model);
    const effort: ReasoningEffort = primaryHop.effort;
    const allowOverage = Boolean(input.allowOverage);
    const pushBranch = input.pushBranch !== false;
    const autoCreatePr = input.autoCreatePr !== false;

    const firstLinePrompt = (prompt.split('\n')[0] ?? '').trim().slice(0, 100);
    const title = (input.title || firstLinePrompt || 'Task').trim();
    const tier: TaskTier = input.tier ?? 'immediate';
    const originId = input.originId ?? null;
    const originNumber = input.originNumber ?? null;
    const originTitle = input.originTitle ?? null;

    // Two concurrent enqueues must never pick the same number, so the max read and the insert share
    // one write transaction.
    this.inTransaction(() => {
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
          required_labels_json, model, candidate_models_json, pool_family, effort, allow_overage,
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
          poolFamily,
          effort,
          allowOverage ? 1 : 0,
          pushBranch ? 1 : 0,
          autoCreatePr ? 1 : 0,
          input.expiresAt ?? null,
          input.verifyCommand ?? null
        );
    });

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

  public getLatestTaskForOrigin(originId: string, poolFamily?: string): SwarmTask | undefined {
    const row = poolFamily
      ? (this.rawDb
          .prepare(
            `SELECT * FROM swarm_tasks
             WHERE origin_id = ? AND pool_family = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT 1`
          )
          .get(originId, poolFamily) as Record<string, any> | undefined)
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
      // A registered runner's scope is its registration; the poll payload may only narrow it, never widen it.
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
          labels: effectiveLabels,
          repositories: effectiveRepos,
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

      const now = new Date().toISOString();
      const nowEpoch = Date.now();

      for (const row of candidates) {
        const task = this.mapRowToTask(row);

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
                 pool_family = ?,
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
            resolvePoolFamilyForModel(updatedModel),
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

    const branchName = patch.branchName ?? existing.branchName ?? null;
    const prUrl = patch.prUrl ?? existing.prUrl ?? null;
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
           ${ownershipClause}
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

    const firstLinePrompt = (
      String(row.prompt || '')
        .trim()
        .split('\n')[0] ?? ''
    )
      .trim()
      .slice(0, 100);
    const storedTitle = typeof row.title === 'string' ? row.title.trim() : '';
    const title = storedTitle !== '' ? storedTitle : firstLinePrompt || 'Task';

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
      poolFamily: (row.pool_family as QuotaFamily) || 'gemini-argon',
      effort: primaryEffort,
      allowOverage: row.allow_overage === 1,
      pushBranch: row.push_branch === 1,
      autoCreatePr: row.auto_create_pr !== 0,
      prUrl: row.pr_url ? String(row.pr_url) : undefined,
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
    const maxNumberRow = this.rawDb
      .prepare('SELECT MAX(task_number) as max_num FROM backlog_tasks')
      .get() as { max_num?: number } | undefined;
    const taskNumber = input.taskNumber ?? (maxNumberRow?.max_num ?? 0) + 1;
    const cascade = coerceCascade(input.cascade);
    const autoCreatePr = input.autoCreatePr !== false ? 1 : 0;
    const priorityOrder = coerceNumber(input.priorityOrder, 0);
    const maxAttempts = coerceNumber(input.maxAttempts, 2);

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
    const maxNumberRow = this.rawDb
      .prepare('SELECT MAX(task_number) as max_num FROM routine_tasks')
      .get() as { max_num?: number } | undefined;
    const taskNumber = input.taskNumber ?? (maxNumberRow?.max_num ?? 0) + 1;
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
