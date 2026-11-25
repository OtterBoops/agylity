import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { AppDatabase } from '../../src/storage/db.js';
import { ensureTableSchema } from '../../src/storage/schema.js';
import { ensureSentryStateSchema } from '../../src/sentry/store.js';
import { logger } from '../../src/logs/logger.js';
import { TaskQueue } from '../../src/coordinator/queue.js';
import { createMemorySink } from '../e2e/harness/index.js';

const makeTempDir = (prefix: string): { dir: string; cleanup: () => void } => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test('applies the migration set in order and keeps the pr_policy sentinel on all three tiers', () => {
  const { dir, cleanup } = makeTempDir('schema_v1_contract_');
  const db = new AppDatabase(path.join(dir, 'test.db'));
  try {
    new TaskQueue(db);
    const raw = db.getRawDb();

    const versions = (
      raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
        version: number;
      }>
    ).map((row) => row.version);
    assert.deepEqual(
      versions,
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      'every migration must be applied, in order'
    );

    // pr_policy is a NOT NULL sentinel column on all three tiers.
    for (const table of ['swarm_tasks', 'backlog_tasks', 'routine_tasks']) {
      const column = (
        raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
          notnull: number;
          dflt_value: string | null;
        }>
      ).find((row) => row.name === 'pr_policy');
      assert.ok(column, `${table}.pr_policy should exist`);
      assert.equal(column?.notnull, 1, `${table}.pr_policy should be NOT NULL`);
      assert.match(String(column?.dflt_value ?? ''), /inherit/);
    }
  } finally {
    db.close();
    cleanup();
  }
});

test('migration v7 folds every legacy Gemini pool id onto the merged gemini group', () => {
  const { dir, cleanup } = makeTempDir('schema_v7_gemini_pool_group_');
  const db = new AppDatabase(path.join(dir, 'test.db'));
  try {
    const queue = new TaskQueue(db);
    const raw = db.getRawDb();
    const now = '2026-11-18T00:00:00.000Z';

    queue.enqueue({
      repositoryName: 'agylity',
      prompt: 'pre-merge pool group',
      cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
    });

    // A v6 database that still carries the pre-merge vocabulary: the group v4 already claimed, a
    // second legacy group that has to collapse into it, and a suffixed pool id.
    raw
      .prepare(
        `INSERT INTO pool_state (pool_id, reset_time, remaining_fraction, last_alert_sent_at, updated_at)
         VALUES ('gemini-hydrogen', '2026-11-25T00:00:00Z', 0.9, NULL, ?),
                ('gemini-flash', '2026-11-20T00:00:00Z', 0.4, NULL, ?),
                ('gemini-flash:gemini-pro', '2026-11-22T00:00:00Z', 0.55, NULL, ?)`
      )
      .run(now, now, now);

    raw
      .prepare(
        `INSERT INTO pool_samples (pool_id, at, remaining_fraction, reset_time)
         VALUES ('gemini-flash', '2026-11-01T00:00:00Z', 0.5, '2026-11-20T00:00:00Z'),
                ('gemini-flash', '2026-11-02T00:00:00Z', 0.45, '2026-11-20T00:00:00Z'),
                ('gemini-hydrogen', '2026-11-03T00:00:00Z', 0.95, '2026-11-25T00:00:00Z')`
      )
      .run();

    raw
      .prepare(
        `INSERT INTO pool_milestones (pool_id, reset_time, milestone_hours, fired_at)
         VALUES ('gemini-flash', '2026-11-20T00:00:00Z', 24, ?)`
      )
      .run(now);

    raw
      .prepare(
        `INSERT INTO alert_events
           (pool_id, reset_time, kind, milestone_hours, headroom_percent, fired_at, channels_json)
         VALUES ('gemini-argon', '2026-11-20T00:00:00Z', 'milestone', 24, 40, ?, '{}')`
      )
      .run(now);

    raw
      .prepare('INSERT INTO early_reset_notice (id, detected_at, pools_json) VALUES (1, ?, ?)')
      .run(
        now,
        JSON.stringify([
          {
            poolId: 'gemini-argon:weekly',
            previousRemainingFraction: 0.1,
            remainingFraction: 0.9,
            previousResetTime: '2026-11-10T00:00:00Z',
            resetTime: '2026-11-20T00:00:00Z',
          },
        ])
      );

    raw
      .prepare(
        `INSERT INTO routine_tasks (id, task_number, title, prompt, repository_id, last_triggered_cycles_json)
         VALUES ('routine-1', 1, 'Pre-reset burn', 'burn probe', 'agylity', ?)`
      )
      .run(JSON.stringify({ claude: 'cycle-a', 'gemini-argon': 'cycle-b' }));

    // A v6 row keeps the post-v5 column name while still holding a legacy group value.
    raw.prepare("UPDATE swarm_tasks SET pool_group = 'gemini-argon'").run();
    db.set('poolGroupPolicies', {
      claude: { alertsEnabled: false, dispatchEnabled: false },
      'gemini-flash': { alertsEnabled: false, dispatchEnabled: true },
      'gemini-argon': { alertsEnabled: true, dispatchEnabled: true },
    });

    // Only the v7 record is dropped, so this boot has to fold a database that already reached v6.
    raw.prepare('DELETE FROM schema_migrations WHERE version = 7').run();
    new TaskQueue(db);

    const poolIds = (
      raw.prepare('SELECT pool_id FROM pool_state ORDER BY pool_id').all() as Array<{
        pool_id: string;
      }>
    ).map((row) => row.pool_id);
    assert.deepEqual(poolIds, ['gemini', 'gemini:gemini-pro']);
    // The row already carrying the merged id survives; the legacy duplicate is dropped, not merged.
    assert.equal(
      (
        raw.prepare("SELECT remaining_fraction FROM pool_state WHERE pool_id = 'gemini'").get() as
          { remaining_fraction: number } | undefined
      )?.remaining_fraction,
      0.9
    );

    const samplePools = (
      raw.prepare('SELECT pool_id, at FROM pool_samples ORDER BY at').all() as Array<{
        pool_id: string;
        at: string;
      }>
    ).map((row) => `${row.pool_id}@${row.at}`);
    assert.deepEqual(samplePools, [
      'gemini@2026-11-01T00:00:00Z',
      'gemini@2026-11-02T00:00:00Z',
      'gemini@2026-11-03T00:00:00Z',
    ]);

    assert.deepEqual(
      (
        raw.prepare('SELECT DISTINCT pool_id FROM pool_milestones').all() as Array<{
          pool_id: string;
        }>
      ).map((row) => row.pool_id),
      ['gemini']
    );
    assert.deepEqual(
      (
        raw.prepare('SELECT DISTINCT pool_id FROM alert_events').all() as Array<{ pool_id: string }>
      ).map((row) => row.pool_id),
      ['gemini']
    );

    const notice = JSON.parse(
      (
        raw.prepare('SELECT pools_json FROM early_reset_notice WHERE id = 1').get() as {
          pools_json: string;
        }
      ).pools_json
    ) as Array<{ poolId: string }>;
    assert.equal(notice[0]?.poolId, 'gemini:weekly');

    const taskId = queue.listTasks({ limit: 1 })[0]!.id;
    assert.equal(queue.getTask(taskId)?.poolGroup, 'gemini');

    const cycles = JSON.parse(
      (
        raw.prepare('SELECT last_triggered_cycles_json AS cycles FROM routine_tasks').get() as {
          cycles: string;
        }
      ).cycles
    ) as Record<string, string>;
    assert.deepEqual(cycles, { claude: 'cycle-a', gemini: 'cycle-b' });

    const policies = db.get<Record<string, unknown>>('poolGroupPolicies') ?? {};
    assert.deepEqual(Object.keys(policies).sort(), ['claude', 'gemini']);
    // 'gemini-flash' is listed before 'gemini-argon', so it claims the merged key; the other legacy
    // entry folds into it rather than overwriting it.
    assert.deepEqual(policies['gemini'], { alertsEnabled: false, dispatchEnabled: true });

    // v7 is idempotent: a third boot over the merged rows leaves them alone.
    new TaskQueue(db);
    assert.equal((raw.prepare('SELECT COUNT(*) AS c FROM pool_state').get() as { c: number }).c, 2);
  } finally {
    db.close();
    cleanup();
  }
});

test('migration v7 folds a pre-v5 queue column and keeps an existing gemini policy', () => {
  const { dir, cleanup } = makeTempDir('schema_v7_pool_column_');
  const db = new AppDatabase(path.join(dir, 'test.db'));
  try {
    const queue = new TaskQueue(db);
    const raw = db.getRawDb();

    queue.enqueue({
      repositoryName: 'agylity',
      prompt: 'row written before v5',
      cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
    });

    // Reshape back to a pre-v5 install: the retired column spelling, the merged policy seeded next
    // to a legacy key, and v4, v5 and v7 unrecorded so one boot replays the whole chain.
    raw.exec('ALTER TABLE swarm_tasks RENAME COLUMN pool_group TO pool_family');
    raw.prepare("UPDATE swarm_tasks SET pool_family = 'gemini-hydrogen'").run();
    db.set('poolGroupPolicies', {
      gemini: { alertsEnabled: true, dispatchEnabled: false },
      claude: { alertsEnabled: false, dispatchEnabled: false },
      'gemini-hydrogen': { alertsEnabled: true, dispatchEnabled: true },
    });
    raw.prepare('DELETE FROM schema_migrations WHERE version IN (4, 5, 7)').run();

    new TaskQueue(db);

    const columns = (
      raw.prepare('PRAGMA table_info(swarm_tasks)').all() as Array<{ name: string }>
    ).map((row) => String(row.name));
    assert.ok(columns.includes('pool_group'), 'v5 must still rename the retired column');
    assert.ok(!columns.includes('pool_family'), 'v5 must retire the old column spelling');

    const taskId = queue.listTasks({ limit: 1 })[0]!.id;
    assert.equal(queue.getTask(taskId)?.poolGroup, 'gemini');

    const policies = db.get<Record<string, unknown>>('poolGroupPolicies') ?? {};
    assert.deepEqual(Object.keys(policies).sort(), ['claude', 'gemini']);
    // An existing merged entry outranks the legacy key it would otherwise have absorbed.
    assert.deepEqual(policies['gemini'], { alertsEnabled: true, dispatchEnabled: false });
  } finally {
    db.close();
    cleanup();
  }
});

test('migration v5 renames the queue column and moves the policies key on a v4 database', () => {
  const { dir, cleanup } = makeTempDir('schema_v5_pool_group_');
  const db = new AppDatabase(path.join(dir, 'test.db'));
  try {
    const queue = new TaskQueue(db);
    const raw = db.getRawDb();

    queue.enqueue({
      repositoryName: 'agylity',
      prompt: 'first row written before v5',
      cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
    });
    queue.enqueue({
      repositoryName: 'agylity',
      prompt: 'second row written before v5',
      cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
    });

    const readRows = (): Array<{ id: string; poolGroup: string }> =>
      (
        raw
          .prepare('SELECT id, pool_group AS poolGroup FROM swarm_tasks ORDER BY task_number')
          .all() as Array<{
          id: string;
          poolGroup: string;
        }>
      ).map((row) => ({ id: String(row.id), poolGroup: String(row.poolGroup) }));

    const before = readRows();
    assert.equal(before.length, 2, 'both rows must exist before the upgrade');

    // Reshape the database back to what a v4 install has on disk: the old column name and the old
    // settings key, with v5 unrecorded so the next boot has to apply it.
    raw.exec('ALTER TABLE swarm_tasks RENAME COLUMN pool_group TO pool_family');
    raw.prepare('DELETE FROM schema_migrations WHERE version = 5').run();
    const policyValue =
      '{"claude":{"alertsEnabled":false,"dispatchEnabled":true},"gemini-argon":{"alertsEnabled":true,"dispatchEnabled":true}}';
    raw
      .prepare('DELETE FROM settings WHERE key IN (?, ?)')
      .run('poolPolicies', 'poolGroupPolicies');
    raw
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('poolPolicies', ?, datetime('now'))"
      )
      .run(policyValue);

    new TaskQueue(db);

    const columns = (
      raw.prepare('PRAGMA table_info(swarm_tasks)').all() as Array<{ name: string }>
    ).map((row) => String(row.name));
    assert.ok(columns.includes('pool_group'), 'v5 must leave the new column in place');
    assert.ok(!columns.includes('pool_family'), 'v5 must retire the old column');

    assert.deepEqual(readRows(), before, 'the column rename must keep every task row');

    assert.equal(db.getRaw('poolPolicies'), undefined, 'the old settings key must be gone');
    assert.equal(
      db.getRaw('poolGroupPolicies'),
      policyValue,
      'the policies value must move byte-identical'
    );
  } finally {
    db.close();
    cleanup();
  }
});

test('re-running migrations on a head database is a no-op', () => {
  const { dir, cleanup } = makeTempDir('schema_v7_noop_');
  const db = new AppDatabase(path.join(dir, 'test.db'));
  try {
    const queue = new TaskQueue(db);
    const raw = db.getRawDb();

    queue.enqueue({
      repositoryName: 'agylity',
      prompt: 'row survives every boot',
      cascade: [{ model: 'gemini-4-hydrogen', effort: 'high' }],
    });
    db.set('poolGroupPolicies', { claude: { alertsEnabled: true, dispatchEnabled: false } });

    const snapshot = (): Record<string, unknown> => ({
      versions: (
        raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
          version: number;
        }>
      ).map((row) => Number(row.version)),
      columns: (raw.prepare('PRAGMA table_info(swarm_tasks)').all() as Array<{ name: string }>).map(
        (row) => String(row.name)
      ),
      rows: raw.prepare('SELECT id, pool_group FROM swarm_tasks ORDER BY id').all(),
      policies: db.getRaw('poolGroupPolicies'),
    });

    const before = snapshot();
    new TaskQueue(db);
    new TaskQueue(db);

    assert.deepEqual(snapshot(), before, 'a second and third boot must change nothing');
  } finally {
    db.close();
    cleanup();
  }
});

test('opening AppDatabase alone applies every migration and creates the coordinator and sentry tables', () => {
  const { dir, cleanup } = makeTempDir('schema_db_owner_');
  const db = new AppDatabase(path.join(dir, 'test.db'));
  try {
    const raw = db.getRawDb();

    const versions = (
      raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
        version: number;
      }>
    ).map((row) => Number(row.version));
    assert.deepEqual(
      versions,
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      'AppDatabase must take the database to v9 on open'
    );

    const tables = new Set(
      (
        raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => String(row.name))
    );
    for (const table of [
      'settings',
      'swarm_tasks',
      'backlog_tasks',
      'routine_tasks',
      'swarm_runners',
      'swarm_runner_registrations',
      'runtime_state',
      'pool_state',
      'pool_milestones',
      'pool_samples',
      'probe_state',
      'early_reset_notice',
      'alert_events',
    ]) {
      assert.ok(tables.has(table), `${table} must exist without a TaskQueue or SentryStateManager`);
    }
  } finally {
    db.close();
    cleanup();
  }
});

test('additive schema repairs add the missing column and stay silent on table-level constraints', () => {
  const raw = new DatabaseSync(':memory:');
  const memory = createMemorySink();
  const previousLevel = logger.getLevel();
  logger.setLevel('debug');
  const detach = logger.addSink(memory.sink);
  try {
    // A sentry table written before `channels_json` existed, constraints and all.
    raw.exec(`
      CREATE TABLE alert_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_id TEXT NOT NULL,
        reset_time TEXT NOT NULL,
        kind TEXT NOT NULL,
        milestone_hours INTEGER,
        headroom_percent REAL,
        fired_at TEXT NOT NULL,
        UNIQUE (pool_id, reset_time, kind, milestone_hours)
      )
    `);
    ensureSentryStateSchema(raw);

    raw.exec('CREATE TABLE legacy_widgets (id TEXT PRIMARY KEY)');
    ensureTableSchema(raw, 'legacy_widgets', [
      { name: 'id', ddl: 'id TEXT PRIMARY KEY' },
      { name: 'label', ddl: 'label TEXT' },
      { name: 'pk_legacy_widgets', ddl: 'PRIMARY KEY (id)' },
      { name: 'uq_legacy_widgets', ddl: 'UNIQUE (label)' },
      { name: 'fk_legacy_widgets', ddl: 'FOREIGN KEY (id) REFERENCES legacy_widgets (id)' },
      { name: 'ck_legacy_widgets', ddl: 'CHECK (length(label) > 0)' },
    ]);

    const columnsOf = (table: string): string[] =>
      (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) =>
        String(row.name)
      );
    assert.ok(
      columnsOf('alert_events').includes('channels_json'),
      'the addable column must be added'
    );
    assert.ok(columnsOf('legacy_widgets').includes('label'), 'the addable column must be added');

    const warnings = memory.records
      .filter((record) => record.level === 'warn')
      .map((record) => record.formatted);
    assert.deepEqual(warnings, [], 'a table-level constraint is not a missing column');
  } finally {
    detach();
    logger.setLevel(previousLevel);
    raw.close();
  }
});
