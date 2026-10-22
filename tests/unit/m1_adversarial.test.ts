import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {
  booleanEnv,
  integerEnv,
  milestoneHoursEnv,
  RepositoriesJsonSchema,
  MacAddressSchema,
  RawEnvSchema,
  parseRawEnv,
  BUILTIN_DEFAULTS,
} from '../../src/config/schema.js';
import { AppDatabase } from '../../src/storage/db.js';
import { ConfigStore } from '../../src/config/store.js';
import { makeTempDir } from '../e2e/harness/index.js';

describe('Adversarial Stress Test: Milestone 1 (Storage & Config)', () => {
  /* ==================================================================== */
  /* 1. SQLite Storage Concurrency & WAL Behavior                          */
  /* ==================================================================== */
  describe('1. SQLite Storage Concurrency & WAL Behavior', () => {
    it('handles concurrent reads while a write transaction is uncommitted (WAL Snapshot Isolation)', () => {
      const { dir, cleanup } = makeTempDir('adv_wal_snap_');
      const dbPath = path.join(dir, 'test.db');
      const writer = new AppDatabase(dbPath);
      const reader = new AppDatabase(dbPath);

      writer.set('shared_key', 'initial_value');
      assert.equal(reader.get('shared_key'), 'initial_value');

      // Writer starts immediate transaction and updates the value
      writer.getRawDb().exec('BEGIN IMMEDIATE;');
      writer.set('shared_key', 'uncommitted_mutation');

      // In WAL mode, reader must NOT see uncommitted mutation (Snapshot Isolation)
      assert.equal(
        reader.get('shared_key'),
        'initial_value',
        'Reader should see snapshot before uncommitted write'
      );

      // Writer commits
      writer.getRawDb().exec('COMMIT;');

      // Now reader sees committed value
      assert.equal(reader.get('shared_key'), 'uncommitted_mutation');

      writer.close();
      reader.close();
      cleanup();
    });

    it('documents lock contention behavior when two connections attempt simultaneous writes without busy_timeout', () => {
      const { dir, cleanup } = makeTempDir('adv_lock_');
      const dbPath = path.join(dir, 'test.db');
      const conn1 = new AppDatabase(dbPath);
      const conn2 = new AppDatabase(dbPath);

      conn1.getRawDb().exec('BEGIN IMMEDIATE;');
      conn1.set('key1', 'val1');

      // Because PRAGMA busy_timeout is 0 by default in SQLite, conn2 write attempts fail immediately with ERR_SQLITE_ERROR
      let caughtError: Error | null = null;
      try {
        conn2.set('key2', 'val2');
      } catch (err) {
        caughtError = err as Error;
      }

      assert.ok(caughtError !== null, 'conn2 write should fail when conn1 holds write lock');
      assert.match(caughtError!.message, /database is locked/);

      conn1.getRawDb().exec('ROLLBACK;');
      conn1.close();
      conn2.close();
      cleanup();
    });

    it('handles rapid interleaved reads and writes across multiple AppDatabase instances', () => {
      const { dir, cleanup } = makeTempDir('adv_interleaved_');
      const dbPath = path.join(dir, 'test.db');
      const dbA = new AppDatabase(dbPath);
      const dbB = new AppDatabase(dbPath);

      const iterations = 50;
      for (let i = 0; i < iterations; i++) {
        dbA.set(`key_a_${i}`, i);
        assert.equal(dbB.get(`key_a_${i}`), i);
        dbB.set(`key_b_${i}`, i * 2);
        assert.equal(dbA.get(`key_b_${i}`), i * 2);
      }

      assert.equal(Object.keys(dbA.getAll()).length, iterations * 2);
      assert.equal(Object.keys(dbB.getAll()).length, iterations * 2);

      dbA.close();
      dbB.close();
      cleanup();
    });
  });

  /* ==================================================================== */
  /* 2. SQL Injection & Invalid SQL Resilience                            */
  /* ==================================================================== */
  describe('2. SQL Injection & Invalid SQL Resilience', () => {
    it('resists hostile SQL injection payloads in keys and serialized values', () => {
      const { dir, cleanup } = makeTempDir('adv_sqli_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      const injectionPayloads = [
        "admin'--",
        "1' OR '1'='1",
        "'; DROP TABLE settings; --",
        "'; UPDATE settings SET value = 'hacked'; --",
        "' UNION SELECT 1, 'hacked', datetime('now') --",
        "Robert'); DROP TABLE Students;--",
      ];

      for (const payload of injectionPayloads) {
        db.set(payload, { test: payload });
        const retrieved = db.get<{ test: string }>(payload);
        assert.deepEqual(retrieved, { test: payload });
      }

      // Verify settings table is intact and all keys were safely inserted
      const all = db.getAll();
      for (const payload of injectionPayloads) {
        assert.ok(payload in all, `Payload key ${payload} should be safely stored`);
      }

      db.close();
      cleanup();
    });

    it('statement cache survives raw syntax errors and invalid queries on getRawDb()', () => {
      const { dir, cleanup } = makeTempDir('adv_invalid_sql_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      db.set('pre_error_key', 'pre_error_val');

      // Execute deliberately malformed SQL queries
      assert.throws(() => db.getRawDb().exec('SELECT MALFORMED SYNTAX;;;'));
      assert.throws(() => db.getRawDb().exec('INSERT INTO nonexistent_table VALUES (1, 2);'));

      // Verify cached prepared statements on AppDatabase remain fully functional
      assert.equal(db.get('pre_error_key'), 'pre_error_val');
      db.set('post_error_key', 'post_error_val');
      assert.equal(db.get('post_error_key'), 'post_error_val');
      assert.equal(db.delete('pre_error_key'), true);

      db.close();
      cleanup();
    });
  });

  /* ==================================================================== */
  /* 3. Directory Creation Edge Cases                                     */
  /* ==================================================================== */
  describe('3. Directory Creation Edge Cases', () => {
    it('creates deeply nested directory structures and paths with spaces and Unicode', () => {
      const { dir, cleanup } = makeTempDir('adv_dir_');
      const deepPath = path.join(dir, 'level1', 'level2', '🚀 spaces and unicode 🐾', 'data.db');
      const db = new AppDatabase(deepPath);

      db.set('deep_key', 'deep_val');
      assert.equal(db.get('deep_key'), 'deep_val');
      assert.ok(fs.existsSync(deepPath));

      db.close();
      cleanup();
    });

    it('supports anonymous temporary databases via empty string path', () => {
      const db = new AppDatabase('');
      db.set('temp_key', 'temp_val');
      assert.equal(db.get('temp_key'), 'temp_val');
      db.close();
    });

    it('supports pure in-memory database (:memory:) without creating directories', () => {
      const db = new AppDatabase(':memory:');
      db.set('mem_key', 42);
      assert.equal(db.get('mem_key'), 42);
      db.close();
    });
  });

  /* ==================================================================== */
  /* 4. Transactions & Rollback Integrity                                 */
  /* ==================================================================== */
  describe('4. Transactions & Rollback Integrity', () => {
    it('correctly reverts uncommitted writes on ROLLBACK and maintains statement consistency', () => {
      const { dir, cleanup } = makeTempDir('adv_tx_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      db.set('persistent_key', 'original_value');

      db.getRawDb().exec('BEGIN;');
      db.set('persistent_key', 'mutated_in_tx');
      db.set('temporary_key', 'will_be_undone');

      assert.equal(db.get('persistent_key'), 'mutated_in_tx');
      assert.equal(db.get('temporary_key'), 'will_be_undone');

      db.getRawDb().exec('ROLLBACK;');

      assert.equal(db.get('persistent_key'), 'original_value');
      assert.equal(db.get('temporary_key'), undefined);

      // Verify statements continue functioning normally after rollback
      db.set('post_rollback', 999);
      assert.equal(db.get('post_rollback'), 999);

      db.close();
      cleanup();
    });

    it('supports savepoints and partial rollback', () => {
      const { dir, cleanup } = makeTempDir('adv_savepoint_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      db.getRawDb().exec('SAVEPOINT sp1;');
      db.set('sp_key_1', 'val1');

      db.getRawDb().exec('SAVEPOINT sp2;');
      db.set('sp_key_2', 'val2');

      db.getRawDb().exec('ROLLBACK TO sp2;');
      assert.equal(db.get('sp_key_1'), 'val1');
      assert.equal(db.get('sp_key_2'), undefined);

      db.getRawDb().exec('RELEASE sp1;');
      assert.equal(db.get('sp_key_1'), 'val1');

      db.close();
      cleanup();
    });
  });

  /* ==================================================================== */
  /* 5. Statement Caching & Lifecycle Post-Close                          */
  /* ==================================================================== */
  describe('5. Statement Caching & Lifecycle Post-Close', () => {
    it('throws informative errors when invoking methods on closed database', () => {
      const db = new AppDatabase(':memory:');
      db.set('key', 'val');
      db.close();

      assert.throws(() => db.get('key'), /statement has been finalized/);
      assert.throws(() => db.set('key', 'val2'), /statement has been finalized/);
      assert.throws(() => db.delete('key'), /statement has been finalized/);
      assert.throws(() => db.getAll(), /statement has been finalized/);
      assert.throws(() => db.clear(), /statement has been finalized/);
      assert.throws(() => db.close(), /database is not open/);
    });

    it('handles high repetition statement reuse without memory leaks or degradation', () => {
      const db = new AppDatabase(':memory:');
      const count = 1000;
      for (let i = 0; i < count; i++) {
        db.set(`k_${i}`, i);
        assert.equal(db.get(`k_${i}`), i);
      }
      assert.equal(Object.keys(db.getAll()).length, count);
      db.close();
    });
  });

  /* ==================================================================== */
  /* 6. Prototype Pollution & Malicious Keys                              */
  /* ==================================================================== */
  describe('6. Prototype Pollution & Malicious Keys', () => {
    it('does not corrupt global Object.prototype when storing __proto__ or constructor keys', () => {
      const { dir, cleanup } = makeTempDir('adv_proto_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      const store = new ConfigStore(db, {});

      // Attempt prototype pollution via database set
      db.set('__proto__', { polluted: 'db_polluted' });
      db.set('constructor', { polluted: 'constructor_polluted' });
      db.set('toString', 'polluted_string');

      // Verify global Object.prototype is unaffected
      const cleanObj: Record<string, unknown> = {};
      assert.equal(cleanObj['polluted'], undefined);
      assert.equal(({} as any).polluted, undefined);

      // Verify ConfigStore resolveConfig remains unaffected
      const resolved = store.resolveConfig();
      assert.equal(resolved.notificationChannel, 'discord');
      assert.equal((resolved as any).polluted, undefined);

      store.close();
      cleanup();
    });
  });

  /* ==================================================================== */
  /* 7. Extreme Environment Variables & Schema Boundaries                 */
  /* ==================================================================== */
  describe('7. Extreme Environment Variables & Schema Boundaries', () => {
    it('handles 1MB payload in environment variables', () => {
      const largePath = '/opt/repo/' + 'a'.repeat(1024 * 1024);
      const raw = {
        DATABASE_PATH: largePath,
      };
      const parsed = parseRawEnv(raw);
      assert.equal(parsed.databasePath?.length, largePath.length);
    });

    it('rejects invalid NOTIFICATION_CHANNEL strings', () => {
      assert.throws(() => parseRawEnv({ NOTIFICATION_CHANNEL: 'slack' as any }));
      assert.throws(() => parseRawEnv({ NOTIFICATION_CHANNEL: 'TELEGRAM' as any }));
    });

    it('rejects out of bounds numeric values in env', () => {
      // QUOTA_CHECK_INTERVAL_SECONDS min is 10
      assert.throws(() => parseRawEnv({ QUOTA_CHECK_INTERVAL_SECONDS: '5' }));
      assert.throws(() => parseRawEnv({ QUOTA_CHECK_INTERVAL_SECONDS: '-10' }));

      // QUOTA_ALERT_THRESHOLD_PERCENT must be 0-100
      assert.throws(() => parseRawEnv({ QUOTA_ALERT_THRESHOLD_PERCENT: '105' }));
      assert.throws(() => parseRawEnv({ QUOTA_ALERT_THRESHOLD_PERCENT: '-5' }));
    });

    it('handles milestoneHoursEnv with chaotic inputs (floats, negatives, duplicates, extra whitespace)', () => {
      assert.deepEqual(
        milestoneHoursEnv.parse('  24 , 12.5 , -3 , 0 , 3 , 24  '),
        [24, 12.5, 3, 24]
      );
      assert.deepEqual(milestoneHoursEnv.parse(''), [24, 12, 3]);
      assert.deepEqual(milestoneHoursEnv.parse('   '), [24, 12, 3]);
    });

    it('handles booleanEnv with exhaustive casing and representations', () => {
      assert.equal(booleanEnv.parse('true'), true);
      assert.equal(booleanEnv.parse('TRUE'), true);
      assert.equal(booleanEnv.parse('True'), true);
      assert.equal(booleanEnv.parse('yes'), true);
      assert.equal(booleanEnv.parse('YES'), true);
      assert.equal(booleanEnv.parse('1'), true);
      assert.equal(booleanEnv.parse('false'), false);
      assert.equal(booleanEnv.parse('FALSE'), false);
      assert.equal(booleanEnv.parse('no'), false);
      assert.equal(booleanEnv.parse('NO'), false);
      assert.equal(booleanEnv.parse('0'), false);
      assert.equal(booleanEnv.parse(''), false);
      assert.equal(booleanEnv.parse('   '), false);
      assert.throws(() => booleanEnv.parse('random_string'));
      assert.throws(() => booleanEnv.parse('2'));
    });
  });

  /* ==================================================================== */
  /* 8. Fallback Precedence Hierarchy Stress & Edge Cases                 */
  /* ==================================================================== */
  describe('8. Fallback Precedence Hierarchy Stress & Edge Cases', () => {
    it('preserves falsy override values (false, 0, "") in SQLite without premature fallback', () => {
      const { dir, cleanup } = makeTempDir('adv_falsy_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        webUiEnabled: true,
        quotaAlertThresholdPercent: 50,
      });

      // Override with boolean false
      store.setOverride('webUiEnabled', false);
      assert.equal(
        store.get('webUiEnabled'),
        false,
        'Override false should NOT fall back to env true'
      );
      assert.equal(store.resolveConfig().webUiEnabled, false);

      // Override with number 0
      store.setOverride('quotaAlertThresholdPercent', 0);
      assert.equal(
        store.get('quotaAlertThresholdPercent'),
        0,
        'Override 0 should NOT fall back to env 50'
      );
      assert.equal(store.resolveConfig().quotaAlertThresholdPercent, 0);

      store.close();
      cleanup();
    });

    it('rapidly mutates overrides and verifies state consistency across all levels', () => {
      const { dir, cleanup } = makeTempDir('adv_rapid_');
      const env = {
        quotaCheckIntervalSeconds: 600,
      };
      const store = new ConfigStore(path.join(dir, 'test.db'), env);

      // Initial: env value
      assert.equal(store.resolveConfig().quotaCheckIntervalSeconds, 600);

      for (let i = 1; i <= 50; i++) {
        store.setOverride('quotaCheckIntervalSeconds', i * 10);
        assert.equal(store.resolveConfig().quotaCheckIntervalSeconds, i * 10);
        assert.equal(store.get('quotaCheckIntervalSeconds'), i * 10);
      }

      // Remove override: falls back to env
      store.removeOverride('quotaCheckIntervalSeconds');
      assert.equal(store.resolveConfig().quotaCheckIntervalSeconds, 600);
      assert.equal(store.get('quotaCheckIntervalSeconds'), 600);

      store.close();
      cleanup();
    });

    it('verifies case insensitivity / mapping between UPPER_SNAKE_CASE and camelCase', () => {
      const { dir, cleanup } = makeTempDir('adv_mapping_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      store.set('QUOTA_CHECK_INTERVAL_SECONDS', 300);
      assert.equal(store.get('quotaCheckIntervalSeconds'), 300);
      assert.equal(store.get('QUOTA_CHECK_INTERVAL_SECONDS'), 300);

      store.delete('QUOTA_CHECK_INTERVAL_SECONDS');
      assert.equal(
        store.get('quotaCheckIntervalSeconds'),
        BUILTIN_DEFAULTS.quotaCheckIntervalSeconds
      );

      store.close();
      cleanup();
    });
  });
});
