import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, SWARM_TASK_COLUMNS } from '../../src/storage/migrations.js';
import { TaskQueue } from '../../src/coordinator/index.js';
import {
  AppDatabase,
  encryptSecret,
  decryptSecret,
  SecretDecryptionError,
  isSecretKey,
} from '../../src/storage/db.js';

describe('AppDatabase (node:sqlite Native Storage)', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = new AppDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates required tables and sets synchronous NORMAL pragma', () => {
    const raw = db.getRawDb();
    const syncPragma = raw.prepare('PRAGMA synchronous;').get() as { synchronous: number };
    assert.equal(syncPragma.synchronous, 1); // 1 = NORMAL

    // Verify settings table exists
    const tableCheck = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings';")
      .get() as { name: string } | undefined;
    assert.ok(tableCheck);
  });

  it('round-trips an object-valued secret and never stores it in plaintext', () => {
    const headers = { Authorization: 'Bearer abc123', 'X-Api-Key': 'k-42' };
    db.set('webhookCustomHeaders', headers);

    // The stored row is ciphertext, not the header map.
    const raw = db.getRaw('webhookCustomHeaders');
    assert.ok(raw);
    assert.equal(raw.includes('Bearer abc123'), false);

    const read = db.get<typeof headers>('webhookCustomHeaders');
    assert.deepEqual(read, headers);
    assert.deepEqual(db.getAll().webhookCustomHeaders, headers);

    // A string secret keeps its plain form through the same path.
    db.set('webhookSecret', 'plain-token');
    assert.equal(db.get('webhookSecret'), 'plain-token');
  });

  it('auto-creates parent directories and enables WAL mode on disk files', () => {
    const testDir = join(
      tmpdir(),
      'test_sandbox_db_' + Date.now() + '_' + Math.random().toString(36).slice(2)
    );
    const dbPath = join(testDir, 'nested', 'test.db');

    try {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });

      const fileDb = new AppDatabase({ path: dbPath });
      assert.equal(existsSync(dbPath), true);

      // Verify WAL mode on persistent disk file
      const pragma = fileDb.getRawDb().prepare('PRAGMA journal_mode;').get() as {
        journal_mode: string;
      };
      assert.equal(pragma.journal_mode, 'wal');

      fileDb.set('probeKey', 'probeValue');
      assert.equal(fileDb.get('probeKey'), 'probeValue');

      fileDb.close();
    } finally {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('performs full CRUD lifecycle on diverse data types', () => {
    // 1. String
    db.set('channel', 'discord');
    assert.equal(db.get<string>('channel'), 'discord');

    // 2. Number
    db.set('interval', 600);
    assert.equal(db.get<number>('interval'), 600);

    // 3. Boolean
    db.set('enabled', true);
    assert.equal(db.get<boolean>('enabled'), true);
    db.set('disabled', false);
    assert.equal(db.get<boolean>('disabled'), false);

    // 4. Array
    db.set('milestones', [24, 12, 3]);
    assert.deepEqual(db.get<number[]>('milestones'), [24, 12, 3]);

    // 5. Object
    db.set('repo', { id: 'agylity', name: 'Agylity' });
    assert.deepEqual(db.get<{ id: string; name: string }>('repo'), {
      id: 'agylity',
      name: 'Agylity',
    });

    // 6. getRaw and getRecord
    const rawVal = db.getRaw('channel');
    assert.equal(rawVal, '"discord"');

    const record = db.getRecord('channel');
    assert.ok(record);
    assert.equal(record.key, 'channel');
    assert.equal(record.value, '"discord"');
    assert.ok(record.updated_at);

    // 7. Non-existent key
    assert.equal(db.get('non_existent_key'), undefined);
    assert.equal(db.getRaw('non_existent_key'), undefined);
    assert.equal(db.getRecord('non_existent_key'), undefined);

    // 8. Update (upsert)
    db.set('channel', 'console');
    assert.equal(db.get<string>('channel'), 'console');

    // 9. getAll
    const all = db.getAll();
    assert.equal(all['channel'], 'console');
    assert.equal(all['interval'], 600);
    assert.equal(all['enabled'], true);
    assert.deepEqual(all['milestones'], [24, 12, 3]);

    // 10. getAllRecords
    const allRecords = db.getAllRecords();
    // Six distinct keys were written above; the later channel write was an upsert.
    assert.equal(allRecords.length, 6);

    // 11. Delete
    assert.equal(db.delete('channel'), true);
    assert.equal(db.get('channel'), undefined);
    assert.equal(db.delete('channel'), false); // Second delete returns false

    // 12. Clear
    db.clear();
    assert.deepEqual(db.getAll(), {});
  });

  it('handles raw unquoted strings inserted via direct SQL gracefully', () => {
    const raw = db.getRawDb();
    raw.exec("INSERT INTO settings (key, value) VALUES ('raw_str', 'unquoted_plain_text');");
    assert.equal(db.get('raw_str'), 'unquoted_plain_text');
  });

  it('sets busyTimeoutMs pragma correctly', () => {
    const busyDb = new AppDatabase({ path: ':memory:', busyTimeoutMs: 2500 });
    const pragma = busyDb.getRawDb().prepare('PRAGMA busy_timeout;').get() as { timeout: number };
    assert.equal(pragma.timeout, 2500);
    busyDb.close();
  });
});

describe('Schema migration v6: swarm_tasks issue deliverables', () => {
  const issueColumn = (raw: DatabaseSync) =>
    (
      raw.prepare('PRAGMA table_info(swarm_tasks)').all() as Array<{
        name?: string;
        notnull?: number;
        dflt_value?: string | null;
      }>
    ).find((column) => column.name === 'issue_urls_json');

  const appliedVersions = (raw: DatabaseSync): number[] =>
    (
      raw.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{
        version?: number;
      }>
    ).map((row) => Number(row.version));

  it('reaches version 7 with issue_urls_json defaulting to an empty array on an enqueued task', () => {
    const db = new AppDatabase(':memory:');

    try {
      const raw = db.getRawDb();
      assert.deepEqual(appliedVersions(raw), [1, 2, 3, 4, 5, 6, 7]);

      const column = issueColumn(raw);
      assert.ok(column, 'swarm_tasks.issue_urls_json must exist at head');
      assert.equal(column.notnull, 1);
      assert.equal(column.dflt_value, "'[]'");

      // A run that filed no issues must read back as absent, not as the literal '[]'.
      const queue = new TaskQueue(db);
      const task = queue.enqueue({
        repositoryName: 'agylity',
        prompt: 'Enqueue without issue deliverables',
        cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
      });
      assert.equal(task.issueUrls, undefined);

      const row = raw
        .prepare('SELECT issue_urls_json FROM swarm_tasks WHERE id = ?')
        .get(task.id) as { issue_urls_json?: string } | undefined;
      assert.equal(row?.issue_urls_json, '[]');
    } finally {
      db.close();
    }
  });

  it('treats a second applyMigrations run on a head database as a no-op', () => {
    const db = new AppDatabase(':memory:');

    try {
      const raw = db.getRawDb();
      const before = appliedVersions(raw);

      assert.doesNotThrow(() => applyMigrations(raw));

      assert.deepEqual(appliedVersions(raw), before);
      assert.equal(Math.max(...appliedVersions(raw)), 7);
      assert.ok(issueColumn(raw), 'the re-run must leave the column in place');
    } finally {
      db.close();
    }
  });

  it('upgrades a v5 database by adding issue_urls_json and backfilling existing tasks', () => {
    const db = new AppDatabase(':memory:');

    try {
      const raw = db.getRawDb();
      const queue = new TaskQueue(db);
      const task = queue.enqueue({
        repositoryName: 'agylity',
        prompt: 'Task written before the issue column existed',
        cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
      });

      // Rewind to the v5 shape rather than inventing a fixture: drop the v6 column and its record,
      // and rewind v7 with it so the next apply runs the whole v6..v7 tail.
      raw.exec('ALTER TABLE swarm_tasks DROP COLUMN issue_urls_json');
      raw.prepare('DELETE FROM schema_migrations WHERE version IN (6, 7)').run();
      assert.equal(issueColumn(raw), undefined);
      assert.deepEqual(appliedVersions(raw), [1, 2, 3, 4, 5]);

      applyMigrations(raw);

      const column = issueColumn(raw);
      assert.ok(column, 'the v6 migration must restore the column');
      assert.equal(column.dflt_value, "'[]'");
      assert.deepEqual(appliedVersions(raw), [1, 2, 3, 4, 5, 6, 7]);

      const row = raw
        .prepare('SELECT issue_urls_json FROM swarm_tasks WHERE id = ?')
        .get(task.id) as { issue_urls_json?: string } | undefined;
      assert.equal(row?.issue_urls_json, '[]');
      assert.equal(queue.getTask(task.id)?.issueUrls, undefined);
    } finally {
      db.close();
    }
  });
});

describe('swarm_tasks title settlement and branch clearing', () => {
  it('settles a non-empty title and writes a real NULL when a branch is discarded', () => {
    const db = new AppDatabase(':memory:');

    try {
      const queue = new TaskQueue(db);
      const enqueued = queue.enqueue({
        repositoryName: 'OtterBoops/agylity',
        repositoryPath: 'clones/agylity-settlement',
        prompt: 'Report findings as issues',
      });
      queue.claimNext({ runnerId: 'runner-settlement' });

      const executing = queue.updateTaskStatus(enqueued.id, {
        status: 'executing',
        runnerId: 'runner-settlement',
        branchName: 'agy/abc12345-report-findings',
      });
      assert.ok(executing?.applied);
      assert.equal(executing?.task.branchName, 'agy/abc12345-report-findings');

      const settled = queue.updateTaskStatus(enqueued.id, {
        status: 'no_changes',
        runnerId: 'runner-settlement',
        branchName: null,
        title: 'Parser drops the trailing token',
      });
      assert.ok(settled?.applied);
      assert.equal(settled?.task.title, 'Parser drops the trailing token');
      // The mapper reports a NULL branch as absent, so the discarded branch is gone from the row.
      assert.equal(settled?.task.branchName, undefined);

      const row = db
        .getRawDb()
        .prepare('SELECT title, branch_name FROM swarm_tasks WHERE id = ?')
        .get(enqueued.id) as { title?: string; branch_name?: string | null } | undefined;
      assert.equal(row?.title, 'Parser drops the trailing token');
      assert.equal(row?.branch_name, null);
    } finally {
      db.close();
    }
  });

  it('never erases a stored title with a blank one', () => {
    const db = new AppDatabase(':memory:');

    try {
      const queue = new TaskQueue(db);
      const enqueued = queue.enqueue({
        title: 'Human picked this',
        repositoryName: 'OtterBoops/agylity',
        repositoryPath: 'clones/agylity-blank-title',
        prompt: 'Do the human-typed thing',
      });
      queue.claimNext({ runnerId: 'runner-blank-title' });

      const reported = queue.updateTaskStatus(enqueued.id, {
        status: 'completed',
        runnerId: 'runner-blank-title',
        title: '   ',
      });
      assert.ok(reported?.applied);
      assert.equal(reported?.task.title, 'Human picked this');
    } finally {
      db.close();
    }
  });
});

describe('Secret encryption failure surfacing (AES-256-GCM)', () => {
  it('throws SecretDecryptionError for corrupted ciphertext and a mismatched key', () => {
    const key = Buffer.alloc(32, 1);
    const ciphertext = encryptSecret('super-secret-token', key);
    assert.equal(decryptSecret(ciphertext, key), 'super-secret-token');

    // A wrong key fails GCM auth-tag verification
    assert.throws(() => decryptSecret(ciphertext, Buffer.alloc(32, 2)), SecretDecryptionError);

    // A corrupted auth tag
    const parts = ciphertext.split(':');
    const tag = parts[2]!;
    parts[2] = (tag[0] === '0' ? '1' : '0') + tag.slice(1);
    assert.throws(() => decryptSecret(parts.join(':'), key), SecretDecryptionError);

    // A payload carrying the enc:v1: prefix but no valid structure
    assert.throws(() => decryptSecret('enc:v1:not-valid', key), SecretDecryptionError);

    // Plaintext values pass through untouched
    assert.equal(decryptSecret('plain-value', key), 'plain-value');
  });

  it('propagates SecretDecryptionError out of AppDatabase.get for undecryptable values', () => {
    const db = new AppDatabase(':memory:');
    try {
      // Ciphertext produced with a foreign key the database cannot resolve
      const foreign = encryptSecret('web-ui-token', Buffer.alloc(32, 9));
      db.getRawDb().exec(
        `INSERT INTO settings (key, value) VALUES ('webUiAuthToken', '"${foreign}"');`
      );
      assert.throws(() => db.get('webUiAuthToken'), SecretDecryptionError);

      db.getRawDb().exec(
        `INSERT INTO settings (key, value) VALUES ('badSecret', '"enc:v1:aa:bb:cc"');`
      );
      assert.throws(() => db.get('badSecret'), SecretDecryptionError);
    } finally {
      db.close();
    }
  });
});

describe('Secret key classification (canonical map and env spellings)', () => {
  it('reports a secret key and its env spelling as secret, and a non-secret key as not', () => {
    // Both spellings must resolve through isSecretKey: these are the keys the vault encrypts.
    for (const key of ['webhookSecret', 'WEBHOOK_SECRET', 'webUiAuthToken', 'WEB_UI_AUTH_TOKEN']) {
      assert.equal(isSecretKey(key), true, `${key} must be encrypted`);
    }

    for (const key of ['webUiPort', 'notificationChannel', 'logLevel']) {
      assert.equal(isSecretKey(key), false, `${key} must not be encrypted`);
    }
  });
});

describe('swarm_tasks schema coverage (TaskQueue round-trip)', () => {
  it('asserts every SWARM_TASK_COLUMNS column through enqueue, claim, status report and read', () => {
    const db = new AppDatabase(':memory:');

    try {
      const queue = new TaskQueue(db);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const cascade = [
        { model: 'gemini-4-argon', effort: 'high' },
        { model: 'gemini-4-neon', effort: 'low' },
      ] as const;
      const issueUrls = [
        'https://github.com/OtterBoops/agylity/issues/41',
        'https://github.com/OtterBoops/agylity/issues/42',
      ];

      const enqueued = queue.enqueue({
        title: 'Column coverage round-trip',
        tier: 'backlog',
        originId: 'backlog-coverage-1',
        originNumber: 77,
        originTitle: 'Backlog origin for column coverage',
        repositoryId: 'agylity-coverage',
        repositoryName: 'OtterBoops/agylity',
        repositoryPath: 'clones/agylity-coverage',
        cloneUrl: 'https://github.com/OtterBoops/agylity.git',
        defaultBranch: 'develop',
        prompt: 'Write a task that names every swarm_tasks column',
        requestedBy: 'coverage-runner',
        prPolicy: 'all',
        scheduleMode: 'pre_reset',
        requiredLabels: ['Linux', 'gpu'],
        cascade,
        allowOverage: true,
        pushBranch: false,
        autoCreatePr: false,
        expiresAt,
        verifyCommand: 'npm test',
      });

      // claimed_at and heartbeat_at move only on the claim path, so the round-trip has to include it.
      const claimed = queue.claimNext({ runnerId: 'runner-coverage', labels: ['linux', 'gpu'] });
      assert.ok(claimed, 'the queued task must be claimable by a runner holding its labels');
      const claimedAt = claimed.claimedAt;
      assert.ok(claimedAt, 'claimNext must stamp claimed_at');

      const reported = queue.updateTaskStatus(enqueued.id, {
        status: 'completed',
        runnerId: 'runner-coverage',
        branchName: 'agylity/column-coverage',
        prUrl: 'https://github.com/OtterBoops/agylity/pull/12',
        issueUrls,
        output: 'coverage output',
        error: 'coverage error note',
        durationMs: 1234,
        numTurns: 7,
        totalTokens: 45_678,
        thinkingTokens: 1_234,
      });
      assert.ok(reported?.applied, 'the terminal status report must land');

      const task = queue.getTask(enqueued.id);
      assert.ok(task, 'the enqueued task must read back after the round-trip');

      const roundTrips = (column: string, actual: unknown, expected: unknown): void =>
        assert.deepEqual(
          actual,
          expected,
          `swarm_tasks.${column} must round-trip through TaskQueue`
        );

      const isStamped = (column: string, value: string | undefined): void => {
        assert.ok(value, `swarm_tasks.${column} must be populated`);
        assert.equal(
          Number.isNaN(Date.parse(value)),
          false,
          `swarm_tasks.${column} must hold a parseable timestamp`
        );
      };

      // One entry per column spec: the keys are checked against SWARM_TASK_COLUMNS below, so a new
      // migration column cannot ship without an assertion wired to it.
      const coverage: Record<string, () => void> = {
        id: () => roundTrips('id', task.id, enqueued.id),
        task_number: () => roundTrips('task_number', task.taskNumber, 1),
        title: () => roundTrips('title', task.title, 'Column coverage round-trip'),
        tier: () => roundTrips('tier', task.tier, 'backlog'),
        origin_id: () => roundTrips('origin_id', task.originId, 'backlog-coverage-1'),
        origin_number: () => roundTrips('origin_number', task.originNumber, 77),
        origin_title: () =>
          roundTrips('origin_title', task.originTitle, 'Backlog origin for column coverage'),
        created_at: () => isStamped('created_at', task.createdAt),
        updated_at: () => isStamped('updated_at', task.updatedAt),
        repository_id: () => roundTrips('repository_id', task.repositoryId, 'agylity-coverage'),
        repository_name: () =>
          roundTrips('repository_name', task.repositoryName, 'OtterBoops/agylity'),
        repository_path: () =>
          roundTrips('repository_path', task.repositoryPath, 'clones/agylity-coverage'),
        clone_url: () =>
          roundTrips('clone_url', task.cloneUrl, 'https://github.com/OtterBoops/agylity.git'),
        default_branch: () => roundTrips('default_branch', task.defaultBranch, 'develop'),
        prompt: () =>
          roundTrips('prompt', task.prompt, 'Write a task that names every swarm_tasks column'),
        requested_by: () => roundTrips('requested_by', task.requestedBy, 'coverage-runner'),
        pr_policy: () => roundTrips('pr_policy', task.prPolicy, 'all'),
        schedule_mode: () => roundTrips('schedule_mode', task.scheduleMode, 'pre_reset'),
        required_labels_json: () =>
          roundTrips('required_labels_json', task.requiredLabels, ['linux', 'gpu']),
        model: () => roundTrips('model', task.model, 'gemini-4-argon'),
        candidate_models_json: () => roundTrips('candidate_models_json', task.cascade, cascade),
        pool_group: () => roundTrips('pool_group', task.poolGroup, 'gemini'),
        effort: () => roundTrips('effort', task.effort, 'high'),
        allow_overage: () => roundTrips('allow_overage', task.allowOverage, true),
        push_branch: () => roundTrips('push_branch', task.pushBranch, false),
        auto_create_pr: () => roundTrips('auto_create_pr', task.autoCreatePr, false),
        pr_url: () =>
          roundTrips('pr_url', task.prUrl, 'https://github.com/OtterBoops/agylity/pull/12'),
        issue_urls_json: () => roundTrips('issue_urls_json', task.issueUrls, issueUrls),
        expires_at: () => roundTrips('expires_at', task.expiresAt, expiresAt),
        verify_command: () => roundTrips('verify_command', task.verifyCommand, 'npm test'),
        status: () => roundTrips('status', task.status, 'completed'),
        runner_id: () => roundTrips('runner_id', task.runnerId, 'runner-coverage'),
        claimed_at: () => roundTrips('claimed_at', task.claimedAt, claimedAt),
        heartbeat_at: () => isStamped('heartbeat_at', task.heartbeatAt),
        completed_at: () => isStamped('completed_at', task.completedAt),
        branch_name: () => roundTrips('branch_name', task.branchName, 'agylity/column-coverage'),
        output: () => roundTrips('output', task.output, 'coverage output'),
        error: () => roundTrips('error', task.error, 'coverage error note'),
        duration_ms: () => roundTrips('duration_ms', task.durationMs, 1234),
        num_turns: () => roundTrips('num_turns', task.numTurns, 7),
        total_tokens: () => roundTrips('total_tokens', task.totalTokens, 45_678),
        thinking_tokens: () => roundTrips('thinking_tokens', task.thinkingTokens, 1_234),
      };

      const declared = SWARM_TASK_COLUMNS.map((column) => column.name);
      const uncovered = declared.filter((name) => coverage[name] === undefined);
      const unknown = Object.keys(coverage).filter((name) => !declared.includes(name));

      assert.deepEqual(
        Object.keys(coverage).sort(),
        [...declared].sort(),
        `swarm_tasks columns without a round-trip assertion: ${uncovered.join(', ') || 'none'}; assertions for unknown columns: ${unknown.join(', ') || 'none'}`
      );

      // Each entry runs its own assertion, so a column the mapper dropped fails on its own name.
      for (const assertColumn of Object.values(coverage)) assertColumn();
    } finally {
      db.close();
    }
  });
});
