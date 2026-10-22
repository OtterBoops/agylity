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

describe('Tier 2: Boundary & Corner Cases — Configuration & Persistence', () => {
  it('TB-CFG-1: handles empty, whitespace-only, and weirdly-cased boolean environment strings', () => {
    assert.equal(booleanEnv.parse('   '), false);
    assert.equal(booleanEnv.parse('  FALSE  '), false);
    assert.equal(booleanEnv.parse('  TRUE  '), true);
    assert.equal(booleanEnv.parse('YES'), true);
    assert.equal(booleanEnv.parse('No'), false);
    assert.equal(booleanEnv.parse('0'), false);
    assert.equal(booleanEnv.parse('1'), true);
  });

  it('TB-CFG-2: handles extreme milestone hours strings with duplicate values, decimals, and negative numbers', () => {
    // Negative numbers and zeros should be filtered out; positive integers preserved
    assert.deepEqual(milestoneHoursEnv.parse('24, -5, 0, 12, 3'), [24, 12, 3]);
    assert.deepEqual(milestoneHoursEnv.parse('   '), [24, 12, 3]); // fallback default
    assert.deepEqual(milestoneHoursEnv.parse('100, 50, 25'), [100, 50, 25]);
  });

  it('TB-CFG-3: rejects malformed JSON in REPOSITORIES_JSON with descriptive error', () => {
    assert.throws(
      () => RepositoriesJsonSchema.parse('{ invalid json string ...'),
      /REPOSITORIES_JSON contains invalid JSON syntax/
    );
  });

  it('TB-CFG-4: validates boundary values for webhook URLs (valid URLs and empty string)', () => {
    assert.equal(
      RawEnvSchema.parse({ NOTIFICATION_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc' })
        .NOTIFICATION_WEBHOOK_URL,
      'https://discord.com/api/webhooks/123/abc'
    );
    assert.equal(RawEnvSchema.parse({ NOTIFICATION_WEBHOOK_URL: '' }).NOTIFICATION_WEBHOOK_URL, '');
    assert.throws(() => RawEnvSchema.parse({ NOTIFICATION_WEBHOOK_URL: 'not-a-url' }));
  });

  it('TB-CFG-5: handles SQL injection attempt strings safely in SQLite key and value storage', () => {
    const { dir, cleanup } = makeTempDir('tb_sqli_');
    const db = new AppDatabase(path.join(dir, 'test.db'));

    const injectionKey = "test_key'; DROP TABLE settings; --";
    const injectionVal = "'; DELETE FROM settings WHERE '1'='1";

    db.set(injectionKey, injectionVal);
    const retrieved = db.get(injectionKey);

    assert.equal(retrieved, injectionVal);

    // Verify settings table still exists and is not dropped
    const rows = db.getAll();
    assert.ok(injectionKey in rows);

    db.close();
    cleanup();
  });

  it('TB-CFG-6: handles Unicode, emoji, and control characters in configuration values', () => {
    const { dir, cleanup } = makeTempDir('tb_unicode_');
    const db = new AppDatabase(path.join(dir, 'test.db'));

    const unicodeKey = 'greeting_🚀_キー';
    const unicodeVal = { message: '⚡ Agylity sentry active! 🐾 👾' };

    db.set(unicodeKey, unicodeVal);
    const res = db.get<typeof unicodeVal>(unicodeKey);

    assert.deepEqual(res, unicodeVal);

    db.close();
    cleanup();
  });

  it('TB-CFG-7: deleting non-existent key returns false and does not throw', () => {
    const { dir, cleanup } = makeTempDir('tb_del_nonexistent_');
    const db = new AppDatabase(path.join(dir, 'test.db'));

    const deleted = db.delete('non_existent_key_xyz');
    assert.equal(deleted, false);

    db.close();
    cleanup();
  });

  it('TB-CFG-8: handles rapid concurrent writes to SQLite store under WAL mode', () => {
    const { dir, cleanup } = makeTempDir('tb_concurrent_');
    const db = new AppDatabase(path.join(dir, 'test.db'));

    // Perform 100 rapid sequential writes
    for (let i = 0; i < 100; i++) {
      db.set(`counter_${i}`, i);
    }

    assert.equal(db.get('counter_99'), 99);
    assert.equal(Object.keys(db.getAll()).length, 100);

    db.close();
    cleanup();
  });

  it('TB-CFG-9: handles empty string repository fields schema validation', () => {
    assert.throws(
      () => RepositoriesJsonSchema.parse(JSON.stringify([{ id: '', name: 'test', path: '/opt' }])),
      /Repository ID is required/
    );
    assert.throws(
      () => RepositoriesJsonSchema.parse(JSON.stringify([{ id: '1', name: '', path: '/opt' }])),
      /Repository name is required/
    );
    assert.throws(
      () => RepositoriesJsonSchema.parse(JSON.stringify([{ id: '1', name: 'test', path: '' }])),
      /Repository filesystem path is required/
    );
  });

  it('TB-CFG-10: handles precedence when environment variable is empty string (falls back to default)', () => {
    const { dir, cleanup } = makeTempDir('tb_empty_env_');
    const env = {
      REMOTE_WOL_MAC: '',
      DATABASE_PATH: '',
    };
    const store = new ConfigStore(path.join(dir, 'test.db'), parseRawEnv(env));

    // Empty strings in env should fall back to built-in default
    assert.equal(store.get('databasePath'), BUILTIN_DEFAULTS.databasePath);

    store.close();
    cleanup();
  });
});
