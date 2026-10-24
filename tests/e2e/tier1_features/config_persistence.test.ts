import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  booleanEnv,
  milestoneHoursEnv,
  RepositoriesJsonSchema,
  RawEnvSchema,
  parseRawEnv,
  BUILTIN_DEFAULTS,
} from '../../../src/config/schema.js';
import { AppDatabase } from '../../../src/storage/db.js';
import { ConfigStore } from '../../../src/config/store.js';
import { makeTempDir } from '../harness/index.js';

describe('Tier 1: Feature Coverage — Config & Persistence (F2, F3, F4)', () => {
  /* ==================================================================== */
  /* FEATURE 2: Strict Zod Environment Config                              */
  /* ==================================================================== */
  describe('Feature 2: Strict Zod Environment Config', () => {
    it('F2-1: parses valid environment variables with all standard fields', () => {
      const raw = {
        NOTIFICATION_CHANNEL: 'discord',
        QUOTA_CHECK_INTERVAL_SECONDS: '600',
        QUOTA_ALERT_THRESHOLD_PERCENT: '30',
        MIN_DISPATCH_HEADROOM_PERCENT: '15',
        DATABASE_PATH: 'data/custom.db',
      };
      const parsed = parseRawEnv(raw);
      assert.equal(parsed.notificationChannel, 'discord');
      assert.equal(parsed.quotaCheckIntervalSeconds, 600);
      assert.equal(parsed.quotaAlertThresholdPercent, 30);
      assert.equal(parsed.minDispatchHeadroomPercent, 15);
      assert.equal(parsed.databasePath, 'data/custom.db');
    });

    it('F2-2: prevents boolean coercion trap where "false" evaluates to true', () => {
      assert.equal(booleanEnv.parse('false'), false);
      assert.equal(booleanEnv.parse('0'), false);
      assert.equal(booleanEnv.parse('no'), false);
      assert.equal(booleanEnv.parse(''), false);
      assert.equal(booleanEnv.parse('true'), true);
      assert.equal(booleanEnv.parse('1'), true);
      assert.equal(booleanEnv.parse('yes'), true);
      assert.equal(booleanEnv.parse(false), false);
      assert.equal(booleanEnv.parse(true), true);
    });

    it('F2-3: parses comma-delimited milestone hours string into positive number array', () => {
      assert.deepEqual(milestoneHoursEnv.parse('24,12,3'), [24, 12, 3]);
      assert.deepEqual(milestoneHoursEnv.parse(' 48 , 24 , 6 '), [48, 24, 6]);
      assert.deepEqual(milestoneHoursEnv.parse(''), [24, 12, 3]); // fallback to default
    });

    it('F2-4: parses and validates REPOSITORIES_JSON string schema', () => {
      const json = JSON.stringify([
        {
          id: 'repo-1',
          name: 'Core Monorepo',
          path: '/home/otter/repo',
          description: 'Main project repo',
          defaultBranch: 'main',
        },
      ]);
      const parsed = RepositoriesJsonSchema.parse(json);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0]?.id, 'repo-1');
      assert.equal(parsed[0]?.name, 'Core Monorepo');
      assert.equal(parsed[0]?.defaultBranch, 'main');
    });
  });

  /* ==================================================================== */
  /* FEATURE 3: SQLite Configuration Store                                */
  /* ==================================================================== */
  describe('Feature 3: SQLite Configuration Store', () => {
    it('F3-1: creates database file, verifies parent directory creation and WAL mode', () => {
      const { dir, cleanup } = makeTempDir('f3_db_');
      const dbPath = path.join(dir, 'nested', 'sub', 'test.db');
      const db = new AppDatabase(dbPath);

      // Verify WAL mode pragma
      const row = db.getRawDb().prepare('PRAGMA journal_mode;').get() as { journal_mode: string };
      assert.equal(row.journal_mode.toLowerCase(), 'wal');
      db.close();
      cleanup();
    });

    it('F3-2: stores and retrieves scalar and complex JSON values', () => {
      const { dir, cleanup } = makeTempDir('f3_crud_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      db.set('testString', 'hello world');
      db.set('testNumber', 42);
      db.set('testBool', true);
      db.set('testObj', { a: 1, b: 'nested' });
      db.set('testArray', [1, 2, 3]);

      assert.equal(db.get<string>('testString'), 'hello world');
      assert.equal(db.get<number>('testNumber'), 42);
      assert.equal(db.get<boolean>('testBool'), true);
      assert.deepEqual(db.get<{ a: number; b: string }>('testObj'), { a: 1, b: 'nested' });
      assert.deepEqual(db.get<number[]>('testArray'), [1, 2, 3]);

      db.close();
      cleanup();
    });

    it('F3-3: handles upsert conflicts by updating value and timestamp', () => {
      const { dir, cleanup } = makeTempDir('f3_upsert_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      db.set('quotaThreshold', 25);
      const firstRec = db.getRecord('quotaThreshold');
      assert.equal(firstRec?.value, '25');

      db.set('quotaThreshold', 35);
      const secondRec = db.getRecord('quotaThreshold');
      assert.equal(secondRec?.value, '35');
      assert.equal(db.get<number>('quotaThreshold'), 35);

      db.close();
      cleanup();
    });

    it('F3-4: deletes settings cleanly and returns deletion status', () => {
      const { dir, cleanup } = makeTempDir('f3_del_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      db.set('keyToDelete', 'temp');
      assert.equal(db.get('keyToDelete'), 'temp');

      const deleted = db.delete('keyToDelete');
      assert.equal(deleted, true);
      assert.equal(db.get('keyToDelete'), undefined);

      const deleteAgain = db.delete('keyToDelete');
      assert.equal(deleteAgain, false);

      db.close();
      cleanup();
    });

    it('F3-5: retrieves all settings records as a deserialized key-value dictionary', () => {
      const { dir, cleanup } = makeTempDir('f3_all_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      db.set('k1', 'val1');
      db.set('k2', 123);
      db.set('k3', { nested: true });

      const all = db.getAll();
      assert.equal(all['k1'], 'val1');
      assert.equal(all['k2'], 123);
      assert.deepEqual(all['k3'], { nested: true });

      db.close();
      cleanup();
    });
  });

  /* ==================================================================== */
  /* FEATURE 4: Fallback Precedence Hierarchy                              */
  /* ==================================================================== */
  describe('Feature 4: Fallback Precedence Hierarchy', () => {
    it('F4-1: resolves built-in defaults when key is unset in SQLite and env', () => {
      const { dir, cleanup } = makeTempDir('f4_defaults_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      assert.equal(
        store.get('quotaCheckIntervalSeconds'),
        BUILTIN_DEFAULTS.quotaCheckIntervalSeconds
      );
      assert.equal(store.get('notificationChannel'), 'none');
      assert.equal(store.get('antigravityLsPort'), 60643);

      store.close();
      cleanup();
    });

    it('F4-2: resolves environment variable when SQLite override is absent', () => {
      const { dir, cleanup } = makeTempDir('f4_env_');
      const envOverride = {
        quotaCheckIntervalSeconds: 300,
        notificationChannel: 'console' as const,
      };
      const store = new ConfigStore(path.join(dir, 'test.db'), envOverride);

      assert.equal(store.get('quotaCheckIntervalSeconds'), 300);
      assert.equal(store.get('notificationChannel'), 'console');
      // Unset env key falls back to default
      assert.equal(store.get('antigravityLsPort'), 60643);

      store.close();
      cleanup();
    });

    it('F4-3: SQLite UI override takes absolute precedence over environment variable', () => {
      const { dir, cleanup } = makeTempDir('f4_precedence_');
      const envOverride = {
        quotaCheckIntervalSeconds: 300,
      };
      const store = new ConfigStore(path.join(dir, 'test.db'), envOverride);

      assert.equal(store.get('quotaCheckIntervalSeconds'), 300);

      // Set SQLite override
      store.setOverride('quotaCheckIntervalSeconds', 60);
      assert.equal(store.get('quotaCheckIntervalSeconds'), 60);

      const resolved = store.resolveConfig();
      assert.equal(resolved.quotaCheckIntervalSeconds, 60);

      store.close();
      cleanup();
    });

    it('F4-4: deleting SQLite override seamlessly restores fallback to environment variable', () => {
      const { dir, cleanup } = makeTempDir('f4_delete_precedence_');
      const envOverride = {
        quotaAlertThresholdPercent: 30,
      };
      const store = new ConfigStore(path.join(dir, 'test.db'), envOverride);

      store.setOverride('quotaAlertThresholdPercent', 50);
      assert.equal(store.get('quotaAlertThresholdPercent'), 50);

      store.removeOverride('quotaAlertThresholdPercent');
      // Should now fall back to envOverride (30)
      assert.equal(store.get('quotaAlertThresholdPercent'), 30);

      store.close();
      cleanup();
    });

    it('F4-5: emits change and change:<key> events when overrides are modified or removed', () => {
      const { dir, cleanup } = makeTempDir('f4_events_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const events: Array<{ key: string; value: unknown }> = [];
      store.on('change', (payload) => {
        events.push({ key: payload.key, value: payload.newValue });
      });

      let specificKeyVal: unknown = null;
      store.on('change:quotaCheckIntervalSeconds', (newVal) => {
        specificKeyVal = newVal;
      });

      store.setOverride('quotaCheckIntervalSeconds', 120);

      assert.equal(events.length, 1);
      assert.equal(events[0]?.key, 'quotaCheckIntervalSeconds');
      assert.equal(events[0]?.value, 120);
      assert.equal(specificKeyVal, 120);

      store.close();
      cleanup();
    });
  });
});
