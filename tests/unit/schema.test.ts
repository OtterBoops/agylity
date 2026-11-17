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
      [1, 2, 3]
    );
    assert.equal(migrations[0]?.name, 'v1_baseline');
    // v2 moved sentry state out of data/state.json into the same database.
    assert.equal(migrations[1]?.name, 'v2_sentry_state');
    // v3 is the per-hop cascade migration: the hop chain replaced the scalar model list.
    assert.match(String(migrations[2]?.name), /cascade/);

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
