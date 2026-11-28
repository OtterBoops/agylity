import type { DatabaseSync } from 'node:sqlite';
import { ensureTableSchema, type ColumnSpec } from './schema.js';

// The sentry tables' DDL lives with the other schema definitions so storage owns every CREATE, and a
// migration cannot drift from the column specs it renders.
const POOL_STATE_COLUMNS: readonly ColumnSpec[] = [
  { name: 'pool_id', ddl: 'pool_id TEXT PRIMARY KEY' },
  { name: 'reset_time', ddl: 'reset_time TEXT NOT NULL' },
  { name: 'remaining_fraction', ddl: 'remaining_fraction REAL NOT NULL' },
  { name: 'last_alert_sent_at', ddl: 'last_alert_sent_at TEXT' },
  { name: 'updated_at', ddl: 'updated_at TEXT NOT NULL' },
];

const POOL_MILESTONE_COLUMNS: readonly ColumnSpec[] = [
  { name: 'pool_id', ddl: 'pool_id TEXT NOT NULL' },
  { name: 'reset_time', ddl: 'reset_time TEXT NOT NULL' },
  { name: 'milestone_hours', ddl: 'milestone_hours INTEGER NOT NULL' },
  { name: 'fired_at', ddl: 'fired_at TEXT NOT NULL' },
  {
    name: 'pk_pool_milestone_cycle',
    ddl: 'PRIMARY KEY (pool_id, reset_time, milestone_hours)',
  },
];

const POOL_SAMPLE_COLUMNS: readonly ColumnSpec[] = [
  { name: 'pool_id', ddl: 'pool_id TEXT NOT NULL' },
  { name: 'at', ddl: 'at TEXT NOT NULL' },
  { name: 'remaining_fraction', ddl: 'remaining_fraction REAL NOT NULL' },
  { name: 'reset_time', ddl: 'reset_time TEXT NOT NULL' },
  { name: 'pk_pool_samples_at', ddl: 'PRIMARY KEY (pool_id, at)' },
];

const PROBE_STATE_COLUMNS: readonly ColumnSpec[] = [
  { name: 'k', ddl: 'k TEXT PRIMARY KEY' },
  { name: 'v', ddl: 'v TEXT' },
];

const EARLY_RESET_NOTICE_COLUMNS: readonly ColumnSpec[] = [
  { name: 'id', ddl: 'id INTEGER PRIMARY KEY CHECK (id = 1)' },
  { name: 'detected_at', ddl: 'detected_at TEXT NOT NULL' },
  { name: 'pools_json', ddl: 'pools_json TEXT NOT NULL' },
];

const ALERT_EVENT_COLUMNS: readonly ColumnSpec[] = [
  { name: 'id', ddl: 'id INTEGER PRIMARY KEY AUTOINCREMENT' },
  { name: 'pool_id', ddl: 'pool_id TEXT NOT NULL' },
  { name: 'reset_time', ddl: 'reset_time TEXT NOT NULL' },
  { name: 'kind', ddl: 'kind TEXT NOT NULL' },
  { name: 'milestone_hours', ddl: 'milestone_hours INTEGER' },
  { name: 'headroom_percent', ddl: 'headroom_percent REAL' },
  { name: 'fired_at', ddl: 'fired_at TEXT NOT NULL' },
  { name: 'channels_json', ddl: "channels_json TEXT NOT NULL DEFAULT '{}'" },
  {
    name: 'uq_alert_event',
    ddl: 'UNIQUE (pool_id, reset_time, kind, milestone_hours)',
  },
];

const SENTRY_STATE_TABLES: ReadonlyArray<{ name: string; columns: readonly ColumnSpec[] }> = [
  { name: 'pool_state', columns: POOL_STATE_COLUMNS },
  { name: 'pool_milestones', columns: POOL_MILESTONE_COLUMNS },
  { name: 'pool_samples', columns: POOL_SAMPLE_COLUMNS },
  { name: 'probe_state', columns: PROBE_STATE_COLUMNS },
  { name: 'early_reset_notice', columns: EARLY_RESET_NOTICE_COLUMNS },
  { name: 'alert_events', columns: ALERT_EVENT_COLUMNS },
];

// SQLite treats NULLs as distinct in a UNIQUE constraint, so the milestone key cannot dedupe an
// early-reset row on its own; the partial index makes one event per (pool, cycle) authoritative.
const SENTRY_STATE_INDEXES = `
      CREATE INDEX IF NOT EXISTS idx_alert_events_fired_at ON alert_events (fired_at DESC, id DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_events_cycle
        ON alert_events (pool_id, reset_time, kind) WHERE milestone_hours IS NULL;
    `;

export const ensureSentryStateSchema = (db: DatabaseSync): void => {
  for (const table of SENTRY_STATE_TABLES) {
    ensureTableSchema(db, table.name, table.columns);
  }
  db.exec(SENTRY_STATE_INDEXES);
};
