import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AppDatabase,
  encryptSecret,
  decryptSecret,
  SecretDecryptionError,
  isSecretKey,
  SECRET_KEYS,
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
    assert.equal(tableCheck.name, 'settings');
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
    assert.ok(allRecords.length >= 5);

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

  it('supports constructor with string path directly', () => {
    const memDb = new AppDatabase(':memory:');
    memDb.set('k', 'v');
    assert.equal(memDb.get('k'), 'v');
    memDb.close();
  });

  it('sets busyTimeoutMs pragma correctly', () => {
    const busyDb = new AppDatabase({ path: ':memory:', busyTimeoutMs: 2500 });
    const pragma = busyDb.getRawDb().prepare('PRAGMA busy_timeout;').get() as { timeout: number };
    assert.equal(pragma.timeout, 2500);
    busyDb.close();
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
    // Both spellings of a canonical secret come from the single map in schema.ts
    assert.ok(SECRET_KEYS.has('webhookSecret'));
    assert.ok(SECRET_KEYS.has('WEBHOOK_SECRET'));
    assert.ok(SECRET_KEYS.has('webUiAuthToken'));
    assert.ok(SECRET_KEYS.has('WEB_UI_AUTH_TOKEN'));

    assert.equal(isSecretKey('webhookSecret'), true);
    assert.equal(isSecretKey('WEBHOOK_SECRET'), true);
    assert.equal(isSecretKey('discordToken'), true);
    assert.equal(isSecretKey('DISCORD_TOKEN'), true);

    // Non-secret keys must not be classified as secret
    assert.equal(SECRET_KEYS.has('webUiPort'), false);
    assert.equal(isSecretKey('webUiPort'), false);
    assert.equal(isSecretKey('notificationChannel'), false);
    assert.equal(isSecretKey('logLevel'), false);
  });
});
