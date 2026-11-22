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
    assert.deepEqual(versions, [1, 2, 3, 4, 5], 'every migration must be applied, in order');

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

test('migration v4 moves every legacy gemini-flash pool id onto gemini-hydrogen', () => {
  const { dir, cleanup } = makeTempDir('schema_v4_pool_group_');
  const db = new AppDatabase(path.join(dir, 'test.db'));
  try {
    const queue = new TaskQueue(db);
    const raw = db.getRawDb();
    const now = '2026-11-18T00:00:00.000Z';

    queue.enqueue({
      repositoryName: 'agylity',
      prompt: 'pre-rename pool group',
      cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
    });

    // Pre-rename database: a legacy row beside an already-renamed one, plus a suffixed pool id.
    raw
      .prepare(
        `INSERT INTO pool_state (pool_id, reset_time, remaining_fraction, last_alert_sent_at, updated_at)
         VALUES ('gemini-flash', '2026-11-20T00:00:00Z', 0.4, NULL, ?),
                ('gemini-hydrogen', '2026-11-25T00:00:00Z', 0.9, NULL, ?),
                ('gemini-flash:gemini-pro', '2026-11-22T00:00:00Z', 0.55, NULL, ?)`
      )
      .run(now, now, now);

    raw
      .prepare(
        `INSERT INTO pool_samples (pool_id, at, remaining_fraction, reset_time)
         VALUES ('gemini-flash', '2026-11-01T00:00:00Z', 0.5, '2026-11-20T00:00:00Z'),
                ('gemini-flash', '2026-11-02T00:00:00Z', 0.45, '2026-11-20T00:00:00Z'),
                ('gemini-hydrogen', '2026-11-02T00:00:00Z', 0.95, '2026-11-25T00:00:00Z')`
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
         VALUES ('gemini-flash', '2026-11-20T00:00:00Z', 'milestone', 24, 40, ?, '{}')`
      )
      .run(now);

    raw
      .prepare('INSERT INTO early_reset_notice (id, detected_at, pools_json) VALUES (1, ?, ?)')
      .run(
        now,
        JSON.stringify([
          {
            poolId: 'gemini-flash',
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
      .run(JSON.stringify({ claude: 'cycle-a', 'gemini-flash': 'cycle-b' }));

    // The queue column still carries its pre-v5 name here, which is what lets v4 rewrite the stored
    // value and v5 rename the column on the same boot.
    raw.exec('ALTER TABLE swarm_tasks RENAME COLUMN pool_group TO pool_family');
    raw.prepare("UPDATE swarm_tasks SET pool_family = 'gemini-flash'").run();
    // Seeded under the pre-v5 key, because v4 is what normalizes the value inside it.
    db.set('poolPolicies', {
      claude: { alertsEnabled: false, dispatchEnabled: false },
      'gemini-argon': { alertsEnabled: true, dispatchEnabled: true },
      'gemini-flash': { alertsEnabled: false, dispatchEnabled: true },
    });

    // Drop both records so the next boot replays v4 against the seeded rows and then v5's renames.
    raw.prepare('DELETE FROM schema_migrations WHERE version IN (4, 5)').run();
    new TaskQueue(db);

    const poolIds = (
      raw.prepare('SELECT pool_id FROM pool_state ORDER BY pool_id').all() as Array<{
        pool_id: string;
      }>
    ).map((row) => row.pool_id);
    assert.deepEqual(poolIds, ['gemini-hydrogen', 'gemini-hydrogen:gemini-pro']);
    // The row already carrying the new id survives; the legacy duplicate is dropped, not merged.
    assert.equal(
      (
        raw
          .prepare("SELECT remaining_fraction FROM pool_state WHERE pool_id = 'gemini-hydrogen'")
          .get() as { remaining_fraction: number } | undefined
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
      'gemini-hydrogen@2026-11-01T00:00:00Z',
      'gemini-hydrogen@2026-11-02T00:00:00Z',
    ]);

    assert.deepEqual(
      (
        raw.prepare('SELECT DISTINCT pool_id FROM pool_milestones').all() as Array<{
          pool_id: string;
        }>
      ).map((row) => row.pool_id),
      ['gemini-hydrogen']
    );
    assert.deepEqual(
      (
        raw.prepare('SELECT DISTINCT pool_id FROM alert_events').all() as Array<{ pool_id: string }>
      ).map((row) => row.pool_id),
      ['gemini-hydrogen']
    );

    const notice = JSON.parse(
      (
        raw.prepare('SELECT pools_json FROM early_reset_notice WHERE id = 1').get() as {
          pools_json: string;
        }
      ).pools_json
    ) as Array<{ poolId: string }>;
    assert.equal(notice[0]?.poolId, 'gemini-hydrogen');

    const taskId = queue.listTasks({ limit: 1 })[0]!.id;
    assert.equal(queue.getTask(taskId)?.poolGroup, 'gemini-hydrogen');

    const cycles = JSON.parse(
      (
        raw.prepare('SELECT last_triggered_cycles_json AS cycles FROM routine_tasks').get() as {
          cycles: string;
        }
      ).cycles
    ) as Record<string, string>;
    assert.deepEqual(cycles, { claude: 'cycle-a', 'gemini-hydrogen': 'cycle-b' });

    const policies = db.get<Record<string, unknown>>('poolGroupPolicies') ?? {};
    assert.deepEqual(Object.keys(policies).sort(), ['claude', 'gemini-argon', 'gemini-hydrogen']);
    assert.deepEqual(policies['gemini-hydrogen'], { alertsEnabled: false, dispatchEnabled: true });

    // v4 is idempotent: a third boot over renamed rows leaves them alone.
    new TaskQueue(db);
    assert.equal((raw.prepare('SELECT COUNT(*) AS c FROM pool_state').get() as { c: number }).c, 2);
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

test('re-running migrations on a v5 database is a no-op', () => {
  const { dir, cleanup } = makeTempDir('schema_v5_noop_');
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

test('opening AppDatabase alone applies v1..v5 and creates the coordinator and sentry tables', () => {
  const { dir, cleanup } = makeTempDir('schema_db_owner_');
  const db = new AppDatabase(path.join(dir, 'test.db'));
  try {
    const raw = db.getRawDb();

    const versions = (
      raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
        version: number;
      }>
    ).map((row) => Number(row.version));
    assert.deepEqual(versions, [1, 2, 3, 4, 5], 'AppDatabase must take the database to v5 on open');

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
