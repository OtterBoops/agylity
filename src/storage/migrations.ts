import type { DatabaseSync } from 'node:sqlite';
import { ensureTableSchema, type ColumnSpec } from './schema.js';
import { logger } from '../logs/logger.js';
import {
  CATALOG_BY_ID,
  resolveReasoningEffortForModel,
  type CascadeHop,
  type ReasoningEffort,
} from '../coordinator/models.js';
import { DEFAULT_QUOTA_BURN_MAX_HOURS } from '../config/schema.js';
import { LEGACY_POOL_GROUP_IDS, upgradePoolGroupId } from '../shared/models.js';
import { ensureSentryStateSchema } from '../sentry/store.js';

// The single schema registry: `AppDatabase` and `TaskQueue` both call `applyMigrations`, so a
// database reaches its head version through one path instead of three drifting ones.

export const SWARM_TASK_COLUMNS: readonly ColumnSpec[] = [
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
  { name: 'pool_group', ddl: 'pool_group TEXT NOT NULL' },
  { name: 'effort', ddl: "effort TEXT NOT NULL DEFAULT 'high'" },
  { name: 'allow_overage', ddl: 'allow_overage INTEGER NOT NULL DEFAULT 0' },
  { name: 'push_branch', ddl: 'push_branch INTEGER NOT NULL DEFAULT 1' },
  { name: 'auto_create_pr', ddl: 'auto_create_pr INTEGER NOT NULL DEFAULT 1' },
  { name: 'pr_url', ddl: 'pr_url TEXT' },
  { name: 'issue_urls_json', ddl: "issue_urls_json TEXT NOT NULL DEFAULT '[]'" },
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

export interface Migration {
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

// A pool id is the pool group or `<group>:<slug>`, so only the prefix carries the group name. The id is a
// primary or unique key in every table it appears, so a row already carrying the new id wins and the
// legacy duplicate is dropped instead of failing the boot.
const renameLegacyPoolIds = (db: DatabaseSync, table: string, column = 'pool_id'): void => {
  if (!tableExists(db, table) || !tableHasColumn(db, table, column)) return;
  let renamed = 0;
  for (const legacy of LEGACY_POOL_GROUP_IDS) {
    const upgraded = upgradePoolGroupId(legacy);
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

const renameLegacyTaskPoolGroups = (db: DatabaseSync): void => {
  if (!tableExists(db, 'swarm_tasks') || !tableHasColumn(db, 'swarm_tasks', 'pool_family')) return;
  for (const legacy of LEGACY_POOL_GROUP_IDS) {
    db.prepare('UPDATE swarm_tasks SET pool_family = ? WHERE pool_family = ?').run(
      upgradePoolGroupId(legacy),
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
      const upgraded = upgradePoolGroupId(key);
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
    const upgraded = upgradePoolGroupId(pool.poolId);
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
  for (const legacy of LEGACY_POOL_GROUP_IDS) {
    if (policies[legacy] === undefined) continue;
    const upgraded = upgradePoolGroupId(legacy);
    if (policies[upgraded] === undefined) policies[upgraded] = policies[legacy];
    delete policies[legacy];
    changed = true;
  }
  if (!changed) return;
  db.prepare(
    "UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'poolPolicies'"
  ).run(JSON.stringify(policies));
};

const migrateLegacyPoolGroups = (db: DatabaseSync): void => {
  for (const table of ['pool_state', 'pool_milestones', 'pool_samples', 'alert_events']) {
    renameLegacyPoolIds(db, table);
  }
  renameLegacyNoticePoolIds(db);
  renameLegacyTaskPoolGroups(db);
  renameLegacyRoutineCycleKeys(db);
  renameLegacyPoolPolicyKeys(db);
};

// v5 retires the `pool_family` spelling. The rename is forward-only: a database written before v5
// still carries the old column and SQLite has no `RENAME COLUMN IF EXISTS`.
const renameLegacyPoolColumn = (db: DatabaseSync): void => {
  if (!tableExists(db, 'swarm_tasks')) return;
  if (!tableHasColumn(db, 'swarm_tasks', 'pool_family')) return;
  if (tableHasColumn(db, 'swarm_tasks', 'pool_group')) return;
  db.exec('ALTER TABLE swarm_tasks RENAME COLUMN pool_family TO pool_group');
};

// The policies value moves byte-identical and only the settings key changes. When both keys are
// present the v5 spelling already wins, so the stale row is dropped rather than overwriting config.
const movePoolGroupPoliciesKey = (db: DatabaseSync): void => {
  if (!tableExists(db, 'settings')) return;
  const legacy = db.prepare("SELECT value FROM settings WHERE key = 'poolPolicies'").get();
  if (legacy === undefined) return;
  const current = db.prepare("SELECT 1 AS hit FROM settings WHERE key = 'poolGroupPolicies'").get();
  if (current === undefined) {
    db.prepare("UPDATE settings SET key = 'poolGroupPolicies' WHERE key = 'poolPolicies'").run();
    return;
  }
  db.prepare("DELETE FROM settings WHERE key = 'poolPolicies'").run();
};

const migratePoolGroupVocabulary = (db: DatabaseSync): void => {
  renameLegacyPoolColumn(db);
  movePoolGroupPoliciesKey(db);
};

// A database created before v6 has no issue column; SQLite has no `ADD COLUMN IF NOT EXISTS`.
const addIssueUrlsColumn = (db: DatabaseSync): void => {
  if (!tableExists(db, 'swarm_tasks')) return;
  if (tableHasColumn(db, 'swarm_tasks', 'issue_urls_json')) return;
  db.exec("ALTER TABLE swarm_tasks ADD COLUMN issue_urls_json TEXT NOT NULL DEFAULT '[]'");
};

// Forward-only. A shipped migration is never edited; a schema change is a new version.
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'v1_baseline',
    up: (db) => {
      for (const table of SCHEMA_TABLES) {
        ensureTableSchema(db, table.name, table.columns);
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
      migrateLegacyPoolGroups(db);
    },
  },
  {
    version: 5,
    name: 'v5_pool_group',
    up: (db) => {
      migratePoolGroupVocabulary(db);
    },
  },
  {
    version: 6,
    name: 'v6_issue_urls',
    up: (db) => {
      addIssueUrlsColumn(db);
    },
  },
];

/** Applies every recorded-but-unapplied version in order; re-running replays only the gaps. */
export const applyMigrations = (db: DatabaseSync): void => {
  ensureTableSchema(db, 'schema_migrations', SCHEMA_MIGRATIONS_COLUMNS);
  const applied = new Set(
    (
      db.prepare('SELECT version FROM schema_migrations').all() as Array<{
        version?: number;
      }>
    ).map((row) => Number(row.version))
  );
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      record.run(migration.version, migration.name, new Date().toISOString());
      db.exec('COMMIT');
      logger.info('Applied schema migration %d (%s)', migration.version, migration.name);
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }
};
