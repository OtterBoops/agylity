import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { AppDatabase } from '../../src/storage/db.js';
import { TaskQueue } from '../../src/coordinator/queue.js';

const makeTempDir = (prefix: string): { dir: string; cleanup: () => void } => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test('the v1 schema matches a fresh database exactly, and the list projection omits output', () => {
  const { dir, cleanup } = makeTempDir('schema_v1_contract_');
  const db = new AppDatabase(path.join(dir, 'test.db'));
  try {
    const queue = new TaskQueue(db);
    const raw = db.getRawDb();

    // Boot twice: a migration runs once and is recorded, never replayed.
    new TaskQueue(db);
    const migrations = raw
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all() as Array<{
      version: number;
      name: string;
    }>;
    assert.deepEqual(
      migrations.map((row) => row.version),
      [1, 2, 3, 4]
    );
    assert.equal(migrations[0]?.name, 'v1_baseline');
    // v2 moved sentry state out of data/state.json into the same database.
    assert.equal(migrations[1]?.name, 'v2_sentry_state');
    // v3 is the per-hop cascade migration: the hop chain replaced the scalar model list.
    assert.match(String(migrations[2]?.name), /cascade/);
    // v4 renamed the `gemini-flash` pool family to `gemini-hydrogen`.
    assert.equal(migrations[3]?.name, 'v4_pool_family_hydrogen');

    // The legacy surface must be absent, not merely ignored.
    const taskColumns = new Set(
      (raw.prepare('PRAGMA table_info(swarm_tasks)').all() as Array<{ name: string }>).map((row) =>
        String(row.name)
      )
    );
    for (const dead of ['standing_task_id', 'worker_id', 'actor', 'bot_pr_policy', 'dispatch_id']) {
      assert.equal(taskColumns.has(dead), false, `swarm_tasks must not carry ${dead}`);
    }
    assert.equal(
      (
        raw
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dispatches'")
          .get() as { name?: string } | undefined
      )?.name,
      undefined
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

    queue.enqueue({
      repositoryName: 'agylity',
      prompt: 'projection probe',
      cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
    });
    const listed = queue.listTasks({ limit: 5 });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.output, undefined, 'listTasks must not select the transcript');
    assert.equal(queue.getTask(listed[0]!.id)?.prompt, 'projection probe');
    assert.equal(queue.countTasks(), 1);
  } finally {
    db.close();
    cleanup();
  }
});

test('migration v4 moves every legacy gemini-flash pool id onto gemini-hydrogen', () => {
  const { dir, cleanup } = makeTempDir('schema_v4_pool_family_');
  const db = new AppDatabase(path.join(dir, 'test.db'));
  try {
    const queue = new TaskQueue(db);
    const raw = db.getRawDb();
    const now = '2026-11-18T00:00:00.000Z';

    queue.enqueue({
      repositoryName: 'agylity',
      prompt: 'pre-rename pool family',
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

    raw.prepare("UPDATE swarm_tasks SET pool_family = 'gemini-flash'").run();
    db.set('poolPolicies', {
      claude: { alertsEnabled: false, dispatchEnabled: false },
      'gemini-argon': { alertsEnabled: true, dispatchEnabled: true },
      'gemini-flash': { alertsEnabled: false, dispatchEnabled: true },
    });

    // Drop the record so the next boot replays only v4 against the seeded rows.
    raw.prepare('DELETE FROM schema_migrations WHERE version = 4').run();
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
    assert.equal(queue.getTask(taskId)?.poolFamily, 'gemini-hydrogen');

    const cycles = JSON.parse(
      (
        raw.prepare('SELECT last_triggered_cycles_json AS cycles FROM routine_tasks').get() as {
          cycles: string;
        }
      ).cycles
    ) as Record<string, string>;
    assert.deepEqual(cycles, { claude: 'cycle-a', 'gemini-hydrogen': 'cycle-b' });

    const policies = db.get<Record<string, unknown>>('poolPolicies') ?? {};
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
