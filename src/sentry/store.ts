import type { DatabaseSync } from 'node:sqlite';
import { renderColumns, type ColumnSpec } from '../storage/schema.js';
import type { DeliveryChannelResult } from '../notify/types.js';
import type { EarlyResetNotice, PoolState } from './state.js';

// Every write is durable when the mutation returns, so the in-memory state in `state.ts` is a read
// model, not the source of truth; the DDL is rendered from column specs so a migration cannot drift.

export const SAMPLE_HISTORY_LIMIT = 24;
export const ALERT_EVENT_RETENTION_ROWS = 2000;
export const ALERT_EVENT_RETENTION_DAYS = 90;
const MILESTONE_RETENTION_DAYS = ALERT_EVENT_RETENTION_DAYS;

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
    db.exec(`CREATE TABLE IF NOT EXISTS ${table.name} (\n${renderColumns(table.columns)}\n      )`);
  }
  db.exec(SENTRY_STATE_INDEXES);
};

export type AlertEventKind = 'milestone' | 'early_reset';

export interface AlertEventRecord {
  id: number;
  firedAt: string;
  poolId: string;
  kind: string;
  milestoneHours: number | null;
  headroomPercent: number | null;
  resetTime: string;
  channels: Record<string, DeliveryChannelResult>;
}

export interface RecordAlertEventInput {
  poolId: string;
  resetTime: string;
  kind: AlertEventKind;
  milestoneHours?: number | null;
  headroomPercent?: number | null;
  firedAt?: string;
  channels?: Record<string, DeliveryChannelResult>;
}

export interface ListAlertEventsOptions {
  limit?: number;
  before?: string | null;
  poolId?: string | null;
}

export interface AlertEventPage {
  events: AlertEventRecord[];
  nextBefore: string | null;
}

export interface StoredProbe {
  lastProbeAt?: string;
  lastProbeSource?: string;
  authRequired?: boolean;
  authErrorMessage?: string;
}

const MAX_ALERT_EVENT_LIMIT = 200;
const DEFAULT_ALERT_EVENT_LIMIT = 50;

const parseJsonObject = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
};

const toPercentFloor = (fraction: number): number =>
  Math.floor(Number((fraction * 100).toPrecision(12)));

export class SentryStore {
  private readonly db: DatabaseSync;
  private depth = 0;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private inTransaction<T>(fn: () => T): T {
    // A savepoint, not BEGIN: the daemon shares this connection with the task queue, so a sentry
    // write may land inside a queue transaction. Release of the outermost savepoint commits it.
    const savepoint = `sentry_sp_${this.depth}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    this.depth++;
    try {
      const result = fn();
      this.db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      try {
        this.db.exec(`ROLLBACK TO ${savepoint}`);
        this.db.exec(`RELEASE ${savepoint}`);
      } catch {}
      throw err;
    } finally {
      this.depth--;
    }
  }

  public readProbe(): StoredProbe {
    const rows = this.db.prepare('SELECT k, v FROM probe_state').all() as Array<{
      k?: string;
      v?: string | null;
    }>;
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.k !== undefined && row.v !== null && row.v !== undefined) map.set(row.k, row.v);
    }
    const probe: StoredProbe = {};
    if (map.has('lastProbeAt')) probe.lastProbeAt = map.get('lastProbeAt');
    if (map.has('lastProbeSource')) probe.lastProbeSource = map.get('lastProbeSource');
    if (map.has('authRequired')) probe.authRequired = map.get('authRequired') === '1';
    if (map.has('authErrorMessage')) probe.authErrorMessage = map.get('authErrorMessage');
    return probe;
  }

  public readPools(): Record<string, PoolState> {
    const poolRows = this.db.prepare('SELECT * FROM pool_state').all() as Array<
      Record<string, any>
    >;
    if (poolRows.length === 0) return {};

    const milestoneRows = this.db
      .prepare('SELECT * FROM pool_milestones ORDER BY fired_at ASC')
      .all() as Array<Record<string, any>>;
    const sampleRows = this.db.prepare('SELECT * FROM pool_samples ORDER BY at ASC').all() as Array<
      Record<string, any>
    >;

    const milestonesByPool = new Map<string, string[]>();
    for (const row of milestoneRows) {
      const poolId = String(row.pool_id);
      const pool = poolRows.find((p) => String(p.pool_id) === poolId);
      if (!pool || String(pool.reset_time) !== String(row.reset_time)) continue;
      const key = normalizeMilestoneKey(row.milestone_hours);
      const list = milestonesByPool.get(poolId) ?? [];
      if (!list.includes(key)) list.push(key);
      milestonesByPool.set(poolId, list);
    }

    const samplesByPool = new Map<string, PoolState['samples']>();
    for (const row of sampleRows) {
      const poolId = String(row.pool_id);
      const list = samplesByPool.get(poolId) ?? [];
      list.push({
        at: String(row.at),
        remainingFraction: Number(row.remaining_fraction),
        resetTime: String(row.reset_time),
      });
      samplesByPool.set(poolId, list);
    }

    const pools: Record<string, PoolState> = {};
    for (const row of poolRows) {
      const poolId = String(row.pool_id);
      const samples = samplesByPool.get(poolId) ?? [];
      pools[poolId] = {
        resetTime: String(row.reset_time),
        remainingFraction: Number(row.remaining_fraction),
        firedMilestones: milestonesByPool.get(poolId) ?? [],
        lastAlertSentAt: row.last_alert_sent_at ? String(row.last_alert_sent_at) : null,
        ...(samples.length > 0 ? { samples } : {}),
      };
    }
    return pools;
  }

  public readEarlyResetNotice(): EarlyResetNotice | null {
    const row = this.db.prepare('SELECT * FROM early_reset_notice WHERE id = 1').get() as
      Record<string, any> | undefined;
    if (!row) return null;
    let pools: EarlyResetNotice['pools'] = [];
    try {
      const parsed = JSON.parse(String(row.pools_json));
      if (Array.isArray(parsed)) pools = parsed as EarlyResetNotice['pools'];
    } catch {}
    return { detectedAt: String(row.detected_at), pools };
  }

  public isEmpty(): boolean {
    const pool = this.db.prepare('SELECT COUNT(*) AS c FROM pool_state').get() as
      { c?: number } | undefined;
    if (Number(pool?.c ?? 0) > 0) return false;
    const probe = this.db.prepare('SELECT COUNT(*) AS c FROM probe_state').get() as
      { c?: number } | undefined;
    return Number(probe?.c ?? 0) === 0;
  }

  public writeProbe(probe: StoredProbe): void {
    const upsert = this.db.prepare(
      `INSERT INTO probe_state (k, v) VALUES (?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`
    );
    this.inTransaction(() => {
      if (probe.lastProbeAt !== undefined) upsert.run('lastProbeAt', probe.lastProbeAt);
      if (probe.lastProbeSource !== undefined) {
        upsert.run('lastProbeSource', probe.lastProbeSource);
      }
      if (probe.authRequired !== undefined) {
        upsert.run('authRequired', probe.authRequired ? '1' : '0');
      }
      upsert.run('authErrorMessage', probe.authErrorMessage ?? null);
    });
  }

  public writePool(poolId: string, pool: PoolState): void {
    const now = new Date().toISOString();
    this.inTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO pool_state (pool_id, reset_time, remaining_fraction, last_alert_sent_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(pool_id) DO UPDATE SET
             reset_time = excluded.reset_time,
             remaining_fraction = excluded.remaining_fraction,
             last_alert_sent_at = excluded.last_alert_sent_at,
             updated_at = excluded.updated_at`
        )
        .run(poolId, pool.resetTime, pool.remainingFraction, pool.lastAlertSentAt ?? null, now);

      this.db.prepare('DELETE FROM pool_samples WHERE pool_id = ?').run(poolId);
      const insertSample = this.db.prepare(
        'INSERT OR REPLACE INTO pool_samples (pool_id, at, remaining_fraction, reset_time) VALUES (?, ?, ?, ?)'
      );
      for (const sample of pool.samples ?? []) {
        insertSample.run(poolId, sample.at, sample.remainingFraction, sample.resetTime);
      }
      this.trimSamples(poolId);

      const insertMilestone = this.db.prepare(
        `INSERT OR IGNORE INTO pool_milestones (pool_id, reset_time, milestone_hours, fired_at)
         VALUES (?, ?, ?, ?)`
      );
      for (const milestone of pool.firedMilestones) {
        insertMilestone.run(poolId, pool.resetTime, milestoneToColumn(milestone), now);
      }
      this.pruneRetiredMilestones(poolId, pool.resetTime);
    });
  }

  public insertMilestone(
    poolId: string,
    resetTime: string,
    milestone: number | string,
    firedAt: string = new Date().toISOString()
  ): void {
    this.inTransaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO pool_milestones (pool_id, reset_time, milestone_hours, fired_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(poolId, resetTime, milestoneToColumn(milestone), firedAt);
    });
  }

  public setLastAlertSentAt(poolId: string, at: string | null): void {
    this.db
      .prepare('UPDATE pool_state SET last_alert_sent_at = ?, updated_at = ? WHERE pool_id = ?')
      .run(at, new Date().toISOString(), poolId);
  }

  public ensurePoolRow(poolId: string, resetTime: string, remainingFraction: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO pool_state (pool_id, reset_time, remaining_fraction, last_alert_sent_at, updated_at)
         VALUES (?, ?, ?, NULL, ?)`
      )
      .run(poolId, resetTime, remainingFraction, new Date().toISOString());
  }

  public writeEarlyResetNotice(notice: EarlyResetNotice | null): void {
    if (!notice) {
      this.db.prepare('DELETE FROM early_reset_notice WHERE id = 1').run();
      return;
    }
    this.db
      .prepare(
        `INSERT INTO early_reset_notice (id, detected_at, pools_json) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           detected_at = excluded.detected_at,
           pools_json = excluded.pools_json`
      )
      .run(notice.detectedAt, JSON.stringify(notice.pools));
  }

  public recordDeliveredAlert(input: RecordAlertEventInput): void {
    const firedAt = input.firedAt ?? new Date().toISOString();
    this.inTransaction(() => {
      this.insertAlertEventRow({ ...input, firedAt });
      this.ensurePoolRow(input.poolId, input.resetTime, 1);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO pool_milestones (pool_id, reset_time, milestone_hours, fired_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(input.poolId, input.resetTime, milestoneToColumn(input.milestoneHours ?? 0), firedAt);
      this.setLastAlertSentAt(input.poolId, firedAt);
      this.pruneAlertEvents();
    });
  }

  public recordAlertEvent(input: RecordAlertEventInput): boolean {
    const firedAt = input.firedAt ?? new Date().toISOString();
    return this.inTransaction(() => {
      const inserted = this.insertAlertEventRow({ ...input, firedAt });
      this.pruneAlertEvents();
      return inserted;
    });
  }

  public hasCycleAlert(poolId: string, resetTime: string, kind: AlertEventKind): boolean {
    // Mirrors the idx_alert_events_cycle predicate: a cycle event is the row whose milestone is NULL.
    const row = this.db
      .prepare(
        `SELECT 1 AS hit FROM alert_events
         WHERE pool_id = ? AND reset_time = ? AND kind = ? AND milestone_hours IS NULL
         LIMIT 1`
      )
      .get(poolId, resetTime, kind) as { hit?: number } | undefined;
    return row !== undefined;
  }

  private insertAlertEventRow(input: RecordAlertEventInput): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO alert_events
           (pool_id, reset_time, kind, milestone_hours, headroom_percent, fired_at, channels_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.poolId,
        input.resetTime,
        input.kind,
        input.milestoneHours === null || input.milestoneHours === undefined
          ? null
          : milestoneToColumn(input.milestoneHours),
        input.headroomPercent === null || input.headroomPercent === undefined
          ? null
          : input.headroomPercent,
        input.firedAt ?? new Date().toISOString(),
        JSON.stringify(input.channels ?? {})
      );
    return Number(result.changes) > 0;
  }

  public replaceAll(
    probe: StoredProbe,
    pools: Record<string, PoolState>,
    notice: EarlyResetNotice | null
  ): void {
    this.inTransaction(() => {
      this.db.exec('DELETE FROM pool_state');
      this.db.exec('DELETE FROM pool_milestones');
      this.db.exec('DELETE FROM pool_samples');
      this.db.exec('DELETE FROM probe_state');
      this.db.exec('DELETE FROM early_reset_notice');
      this.writeProbe(probe);
      for (const [poolId, pool] of Object.entries(pools)) {
        this.writePool(poolId, pool);
      }
      this.writeEarlyResetNotice(notice);
    });
  }

  private trimSamples(poolId: string): void {
    this.db
      .prepare(
        `DELETE FROM pool_samples
         WHERE pool_id = ?
           AND at NOT IN (
             SELECT at FROM pool_samples WHERE pool_id = ? ORDER BY at DESC LIMIT ?
           )`
      )
      .run(poolId, poolId, SAMPLE_HISTORY_LIMIT);
  }

  private pruneRetiredMilestones(poolId: string, currentResetTime: string): void {
    const cutoff = new Date(Date.now() - MILESTONE_RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
    this.db
      .prepare('DELETE FROM pool_milestones WHERE pool_id = ? AND reset_time <> ? AND fired_at < ?')
      .run(poolId, currentResetTime, cutoff);
  }

  private pruneAlertEvents(): void {
    const cutoff = new Date(
      Date.now() - ALERT_EVENT_RETENTION_DAYS * 24 * 3600 * 1000
    ).toISOString();
    this.db
      .prepare(
        `DELETE FROM alert_events
         WHERE fired_at < ?
           AND id NOT IN (
             SELECT id FROM alert_events ORDER BY fired_at DESC, id DESC LIMIT ?
           )`
      )
      .run(cutoff, ALERT_EVENT_RETENTION_ROWS);
  }

  public listAlertEvents(options: ListAlertEventsOptions = {}): AlertEventPage {
    const requested = options.limit ?? DEFAULT_ALERT_EVENT_LIMIT;
    const limit = Math.min(
      Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_ALERT_EVENT_LIMIT),
      MAX_ALERT_EVENT_LIMIT
    );

    const conditions: string[] = [];
    const params: any[] = [];
    if (options.poolId) {
      conditions.push('pool_id = ?');
      params.push(options.poolId);
    }

    const cursor = parseCursor(options.before ?? null);
    if (cursor !== null && cursor.id !== null) {
      conditions.push('(fired_at < ? OR (fired_at = ? AND id < ?))');
      params.push(cursor.firedAt, cursor.firedAt, cursor.id);
    } else if (cursor !== null) {
      conditions.push('fired_at < ?');
      params.push(cursor.firedAt);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const rows = this.db
      .prepare(`SELECT * FROM alert_events ${where} ORDER BY fired_at DESC, id DESC LIMIT ?`)
      .all(...params) as Array<Record<string, any>>;

    const events = rows.map((row) => this.mapAlertEvent(row));
    const last = events[events.length - 1];
    return {
      events,
      nextBefore: events.length === limit && last ? `${last.firedAt}|${last.id}` : null,
    };
  }

  private mapAlertEvent(row: Record<string, any>): AlertEventRecord {
    return {
      id: Number(row.id),
      firedAt: String(row.fired_at),
      poolId: String(row.pool_id),
      kind: String(row.kind),
      milestoneHours:
        row.milestone_hours === null || row.milestone_hours === undefined
          ? null
          : Number(row.milestone_hours),
      headroomPercent:
        row.headroom_percent === null || row.headroom_percent === undefined
          ? null
          : Number(row.headroom_percent),
      resetTime: String(row.reset_time),
      channels: parseJsonObject<Record<string, DeliveryChannelResult>>(row.channels_json, {}),
    };
  }
}

export const headroomPercentOf = (fraction: number): number => toPercentFloor(fraction);

interface AlertEventCursor {
  firedAt: string;
  id: number | null;
}

const parseCursor = (raw: string | null): AlertEventCursor | null => {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const separator = trimmed.lastIndexOf('|');
  if (separator === -1) return { firedAt: trimmed, id: null };
  const firedAt = trimmed.slice(0, separator).trim();
  const id = Number(trimmed.slice(separator + 1));
  if (firedAt === '' || !Number.isFinite(id)) return { firedAt: trimmed, id: null };
  return { firedAt, id };
};

export const milestoneToColumn = (milestone: number | string): number | string => {
  const normalized = String(milestone).trim().toLowerCase();
  const withoutSuffix = normalized.endsWith('h') ? normalized.slice(0, -1) : normalized;
  const numeric = Number(withoutSuffix);
  return Number.isFinite(numeric) ? numeric : normalized;
};

export const normalizeMilestoneKey = (milestone: number | string): string => {
  const s = String(milestone).trim().toLowerCase();
  return s.endsWith('h') ? s : `${s}h`;
};
