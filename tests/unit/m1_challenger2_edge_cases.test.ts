import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {
  booleanEnv,
  integerEnv,
  milestoneHoursEnv,
  RepositoriesJsonSchema,
  RepositorySchema,
  MacAddressSchema,
  RawEnvSchema,
  parseRawEnv,
  BUILTIN_DEFAULTS,
} from '../../src/config/schema.js';
import { AppDatabase } from '../../src/storage/db.js';
import { ConfigStore } from '../../src/config/store.js';
import { makeTempDir } from '../e2e/harness/index.js';

describe('Empirical Challenger 2: Milestone 1 Boundary & Edge Case Stress Harness', () => {
  /* ==================================================================== */
  /* 1. Boolean Coercion Adversarial Exploration                           */
  /* ==================================================================== */
  describe('1. Boolean Coercion Edge Cases', () => {
    it('exhaustively validates falsy strings against the Boolean() coercion trap', () => {
      // Standard JavaScript Boolean('false') === true trap
      const falsyInputs = ['false', 'FALSE', 'False', 'FaLsE', '0', 'no', 'NO', 'No', '', '   '];
      for (const input of falsyInputs) {
        assert.equal(booleanEnv.parse(input), false, `Failed to parse '${input}' as false`);
      }
    });

    it('exhaustively validates truthy strings', () => {
      const truthyInputs = ['true', 'TRUE', 'True', 'TrUe', '1', 'yes', 'YES', 'Yes'];
      for (const input of truthyInputs) {
        assert.equal(booleanEnv.parse(input), true, `Failed to parse '${input}' as true`);
      }
    });

    it('rejects ambiguous or invalid boolean representations', () => {
      const invalidInputs = [
        'off',
        'on',
        'enabled',
        'disabled',
        '2',
        '-1',
        'null',
        'undefined',
        'truthy',
      ];
      for (const input of invalidInputs) {
        assert.throws(
          () => booleanEnv.parse(input),
          /Expected boolean, received string/,
          `Expected input '${input}' to be rejected`
        );
      }
    });

    it('handles direct boolean primitives and non-string types', () => {
      assert.equal(booleanEnv.parse(true), true);
      assert.equal(booleanEnv.parse(false), false);

      assert.throws(() => booleanEnv.parse(0));
      assert.throws(() => booleanEnv.parse(1));
      assert.throws(() => booleanEnv.parse(null));
      assert.throws(() => booleanEnv.parse(undefined));
      assert.throws(() => booleanEnv.parse({}));
    });

    it('verifies parseRawEnv behavior with WEB_UI_ENABLED variants', () => {
      // Test when WEB_UI_ENABLED is empty string or spaces
      const envEmpty = parseRawEnv({ WEB_UI_ENABLED: '' });
      assert.equal(
        envEmpty.webUiEnabled,
        undefined,
        'Empty WEB_UI_ENABLED should not be set (falls back to default false)'
      );

      const envSpaces = parseRawEnv({ WEB_UI_ENABLED: '   ' });
      assert.equal(
        envSpaces.webUiEnabled,
        undefined,
        'Spaces-only WEB_UI_ENABLED should not be set'
      );

      // Test when WEB_UI_ENABLED is '0', 'false', 'no'
      assert.equal(parseRawEnv({ WEB_UI_ENABLED: 'false' }).webUiEnabled, false);
      assert.equal(parseRawEnv({ WEB_UI_ENABLED: '0' }).webUiEnabled, false);
      assert.equal(parseRawEnv({ WEB_UI_ENABLED: 'no' }).webUiEnabled, false);

      // Test when WEB_UI_ENABLED is '1', 'true', 'yes'
      assert.equal(parseRawEnv({ WEB_UI_ENABLED: 'true' }).webUiEnabled, true);
      assert.equal(parseRawEnv({ WEB_UI_ENABLED: '1' }).webUiEnabled, true);
      assert.equal(parseRawEnv({ WEB_UI_ENABLED: 'yes' }).webUiEnabled, true);

      // Test invalid value in parseRawEnv
      assert.throws(() => parseRawEnv({ WEB_UI_ENABLED: 'invalid_boolean' }));
    });
  });

  /* ==================================================================== */
  /* 2. Milestone Hours Parsing Adversarial Exploration                    */
  /* ==================================================================== */
  describe('2. Milestone Hours Parsing Edge Cases', () => {
    it('parses valid comma-separated milestone strings with varying spacing', () => {
      assert.deepEqual(milestoneHoursEnv.parse('24,12,3'), [24, 12, 3]);
      assert.deepEqual(milestoneHoursEnv.parse('  24 ,  12  , 3  '), [24, 12, 3]);
      assert.deepEqual(milestoneHoursEnv.parse('72'), [72]);
    });

    it('handles negative, zero, and non-numeric entries by filtering them out', () => {
      // Zero and negative hours must be filtered out
      assert.deepEqual(milestoneHoursEnv.parse('24, 0, -5, 12, -100'), [24, 12]);
      // Non-numeric tokens must be filtered out
      assert.deepEqual(milestoneHoursEnv.parse('24, abc, 12, NaN, undefined, 3'), [24, 12, 3]);
      // Trailing / leading commas and empty elements
      assert.deepEqual(milestoneHoursEnv.parse(',,24,,12,,3,,'), [24, 12, 3]);
    });

    it('falls back to default [24, 12, 3] when input is empty string or undefined', () => {
      assert.deepEqual(milestoneHoursEnv.parse(''), [24, 12, 3]);
      assert.deepEqual(milestoneHoursEnv.parse('   '), [24, 12, 3]);
      assert.deepEqual(milestoneHoursEnv.parse(undefined), [24, 12, 3]);
    });

    it('preserves order and duplicates when provided', () => {
      // Unsorted order
      assert.deepEqual(milestoneHoursEnv.parse('3, 24, 12'), [3, 24, 12]);
      // Duplicates
      assert.deepEqual(milestoneHoursEnv.parse('24, 24, 12, 12'), [24, 24, 12, 12]);
      // Decimals / floats
      assert.deepEqual(milestoneHoursEnv.parse('0.5, 1.5, 24.25'), [0.5, 1.5, 24.25]);
    });

    it('evaluates behavior when ALL elements are non-numeric or non-positive', () => {
      // When all elements are invalid, filter produces []
      const result = milestoneHoursEnv.parse('abc, def, -1, 0');
      assert.deepEqual(result, [], 'Filtering all invalid elements produces empty array');
      // Verify that an empty array does not throw validation error because z.array(z.number().positive()) allows empty array
      assert.ok(Array.isArray(result));
    });
  });

  /* ==================================================================== */
  /* 3. JSON Repository Parsing Adversarial Exploration                    */
  /* ==================================================================== */
  describe('3. JSON Repository Parsing Edge Cases', () => {
    it('parses valid single and multi repository JSON arrays', () => {
      const valid = JSON.stringify([
        { id: 'repo-1', name: 'Repo 1', path: '/opt/repo1', defaultBranch: 'develop' },
        { id: 'repo-2', name: 'Repo 2', path: '/opt/repo2' }, // defaultBranch should default to 'main'
      ]);
      const parsed = RepositoriesJsonSchema.parse(valid);
      assert.equal(parsed.length, 2);
      assert.equal(parsed[0].id, 'repo-1');
      assert.equal(parsed[0].defaultBranch, 'develop');
      assert.equal(parsed[1].id, 'repo-2');
      assert.equal(parsed[1].defaultBranch, 'main');
    });

    it('rejects malformed JSON syntax with descriptive error', () => {
      assert.throws(
        () => RepositoriesJsonSchema.parse('{ not: "valid" json }'),
        /REPOSITORIES_JSON contains invalid JSON syntax/
      );
      assert.throws(
        () => RepositoriesJsonSchema.parse('["unterminated string'),
        /REPOSITORIES_JSON contains invalid JSON syntax/
      );
    });

    it('rejects non-array JSON roots (e.g. JSON object, number, boolean)', () => {
      assert.throws(
        () => RepositoriesJsonSchema.parse('{"id": "repo1", "name": "Repo 1", "path": "/opt"}'),
        /Expected array, received object/
      );
      assert.throws(() => RepositoriesJsonSchema.parse('12345'), /Expected array, received number/);
      assert.throws(
        () => RepositoriesJsonSchema.parse('"just a string"'),
        /Expected array, received string/
      );
    });

    it('rejects array elements missing required fields (id, name, path)', () => {
      // Missing id
      assert.throws(
        () => RepositoriesJsonSchema.parse(JSON.stringify([{ name: 'No ID', path: '/opt' }])),
        /Required/
      );
      // Missing name
      assert.throws(
        () => RepositoriesJsonSchema.parse(JSON.stringify([{ id: 'no-name', path: '/opt' }])),
        /Required/
      );
      // Missing path
      assert.throws(
        () => RepositoriesJsonSchema.parse(JSON.stringify([{ id: 'no-path', name: 'No Path' }])),
        /Required/
      );
      // Empty string in required field
      assert.throws(
        () =>
          RepositoriesJsonSchema.parse(
            JSON.stringify([{ id: '', name: 'Empty ID', path: '/opt' }])
          ),
        /Repository ID is required/
      );
    });

    it('handles path traversal strings and strange filesystem paths safely', () => {
      const weirdPaths = [
        '../../../../etc/passwd',
        'C:\\Program Files\\My Repo',
        '/var/git/repo.git',
        'relative/path/to/repo',
        '~/.antigravity/repos',
      ];

      for (const p of weirdPaths) {
        const repo = RepositorySchema.parse({
          id: 'test-id',
          name: 'Test Name',
          path: p,
        });
        assert.equal(repo.path, p);
      }
    });

    it('strips unknown extra fields automatically without error', () => {
      const payload = JSON.stringify([
        {
          id: 'repo-safe',
          name: 'Safe',
          path: '/opt/safe',
          maliciousField: 'DROP TABLE settings;',
          extraNested: { admin: true },
        },
      ]);
      const parsed = RepositoriesJsonSchema.parse(payload);
      assert.equal(parsed.length, 1);
      assert.equal(
        (parsed[0] as any).maliciousField,
        undefined,
        'Extra unmodeled field should be stripped by Zod'
      );
      assert.equal(
        (parsed[0] as any).extraNested,
        undefined,
        'Nested unmodeled field should be stripped by Zod'
      );
    });
  });

  /* ==================================================================== */
  /* 4. SQLite Disk Boundary Conditions & Persistence Integrity            */
  /* ==================================================================== */
  describe('4. SQLite Disk Boundary Conditions', () => {
    it('persists data across closing and reopening database connection', () => {
      const { dir, cleanup } = makeTempDir('adv_reopen_');
      const dbPath = path.join(dir, 'persist.db');

      // First session: write data
      const session1 = new AppDatabase(dbPath);
      session1.set('settingA', { active: true, count: 42 });
      session1.set('settingB', 'hello world');
      session1.close();

      // Second session: verify data is intact
      const session2 = new AppDatabase(dbPath);
      assert.deepEqual(session2.get('settingA'), { active: true, count: 42 });
      assert.equal(session2.get('settingB'), 'hello world');
      assert.equal(session2.getAllRecords().length, 2);

      session2.close();
      cleanup();
    });

    it('gracefully handles corrupt or raw non-JSON string values in settings table', () => {
      const { dir, cleanup } = makeTempDir('adv_corrupt_val_');
      const dbPath = path.join(dir, 'corrupt.db');
      const db = new AppDatabase(dbPath);

      // Directly insert non-JSON and malformed JSON into the underlying table
      const raw = db.getRawDb();
      raw.exec(
        "INSERT INTO settings (key, value) VALUES ('malformed_json', '{broken-json-without-quotes');"
      );
      raw.exec("INSERT INTO settings (key, value) VALUES ('plain_string', 'just a raw string');");
      raw.exec("INSERT INTO settings (key, value) VALUES ('empty_string', '');");

      // Verify db.get() catches the JSON.parse error and returns raw string instead of crashing
      assert.equal(db.get('malformed_json'), '{broken-json-without-quotes');
      assert.equal(db.get('plain_string'), 'just a raw string');
      assert.equal(db.get('empty_string'), '');

      // Verify getAll() also catches JSON.parse errors and includes raw string without crashing
      const all = db.getAll();
      assert.equal(all['malformed_json'], '{broken-json-without-quotes');
      assert.equal(all['plain_string'], 'just a raw string');
      assert.equal(all['empty_string'], '');

      db.close();
      cleanup();
    });

    it('properly throws ERR_SQLITE_ERROR when calling methods on closed database instance', () => {
      const db = new AppDatabase(':memory:');
      db.set('test', 123);
      db.close();

      assert.throws(() => db.get('test'));
      assert.throws(() => db.set('test', 456));
      assert.throws(() => db.delete('test'));
      assert.throws(() => db.getAll());
      assert.throws(() => db.clear());
    });

    it('verifies concurrent connection behavior on disk database', () => {
      const { dir, cleanup } = makeTempDir('adv_disk_concurrency_');
      const dbPath = path.join(dir, 'shared.db');

      const conn1 = new AppDatabase(dbPath);
      const conn2 = new AppDatabase(dbPath);

      // Concurrent independent writes succeed in WAL mode
      conn1.set('conn1_key', 'val1');
      conn2.set('conn2_key', 'val2');

      assert.equal(conn1.get('conn2_key'), 'val2');
      assert.equal(conn2.get('conn1_key'), 'val1');

      conn1.close();
      conn2.close();
      cleanup();
    });
  });

  /* ==================================================================== */
  /* 5. Fallback Hierarchy Precedence & Key Mapping Stress                */
  /* ==================================================================== */
  describe('5. Fallback Precedence Hierarchy Mutations', () => {
    it('strictly enforces Precedence: SQLite UI Overrides > Environment Variables > Built-in Defaults', () => {
      const { dir, cleanup } = makeTempDir('adv_precedence_');
      const dbPath = path.join(dir, 'config.db');

      const envConfig = {
        quotaCheckIntervalSeconds: 600, // Env overrides default (900)
        notificationChannel: 'console' as const, // Env overrides default ('discord')
      };

      const store = new ConfigStore(dbPath, envConfig);

      // Before SQLite overrides:
      let resolved = store.resolveConfig();
      assert.equal(
        resolved.quotaCheckIntervalSeconds,
        600,
        'Level 2 (Env) should take precedence over Level 3 (Default)'
      );
      assert.equal(
        resolved.notificationChannel,
        'console',
        'Level 2 (Env) should take precedence over Level 3 (Default)'
      );
      assert.equal(
        resolved.webUiEnabled,
        false,
        'Level 3 (Default) when neither SQLite nor Env is set'
      );

      // Now set SQLite UI override:
      store.setOverride('quotaCheckIntervalSeconds', 300);
      store.setOverride('webUiEnabled', true);

      resolved = store.resolveConfig();
      assert.equal(
        resolved.quotaCheckIntervalSeconds,
        300,
        'Level 1 (SQLite) takes precedence over Level 2 (Env)'
      );
      assert.equal(
        resolved.webUiEnabled,
        true,
        'Level 1 (SQLite) takes precedence over Level 3 (Default)'
      );
      assert.equal(
        resolved.notificationChannel,
        'console',
        'Level 2 (Env) remains active for untouched key'
      );

      // Delete SQLite UI override:
      store.removeOverride('quotaCheckIntervalSeconds');
      resolved = store.resolveConfig();
      assert.equal(
        resolved.quotaCheckIntervalSeconds,
        600,
        'Deleting SQLite override immediately falls back to Level 2 (Env)'
      );

      store.removeOverride('webUiEnabled');
      resolved = store.resolveConfig();
      assert.equal(
        resolved.webUiEnabled,
        false,
        'Deleting SQLite override falls back to Level 3 (Default)'
      );

      store.close();
      cleanup();
    });

    it('seamlessly maps between UPPER_SNAKE_CASE and camelCase keys in SQLite overrides', () => {
      const { dir, cleanup } = makeTempDir('adv_keymap_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      // Set via UPPER_SNAKE_CASE
      store.setOverride('QUOTA_ALERT_THRESHOLD_PERCENT', 45);
      assert.equal(store.get('quotaAlertThresholdPercent'), 45);
      assert.equal(store.get('QUOTA_ALERT_THRESHOLD_PERCENT'), 45);

      let resolved = store.resolveConfig();
      assert.equal(resolved.quotaAlertThresholdPercent, 45);

      // Set via camelCase
      store.setOverride('quotaAlertThresholdPercent', 50);
      assert.equal(store.get('quotaAlertThresholdPercent'), 50);
      assert.equal(store.get('QUOTA_ALERT_THRESHOLD_PERCENT'), 50);

      resolved = store.resolveConfig();
      assert.equal(resolved.quotaAlertThresholdPercent, 50);

      // Delete via UPPER_SNAKE_CASE
      store.removeOverride('QUOTA_ALERT_THRESHOLD_PERCENT');
      assert.equal(
        store.get('quotaAlertThresholdPercent'),
        BUILTIN_DEFAULTS.quotaAlertThresholdPercent
      );

      store.close();
      cleanup();
    });

    it('preserves falsy override values (false, 0, "") without accidental fallback', () => {
      const { dir, cleanup } = makeTempDir('adv_falsy_');
      const envConfig = {
        webUiEnabled: true,
        quotaAlertThresholdPercent: 30,
      };

      const store = new ConfigStore(path.join(dir, 'test.db'), envConfig);

      // SQLite overrides with falsy values
      store.setOverride('webUiEnabled', false);
      store.setOverride('quotaAlertThresholdPercent', 0);

      const resolved = store.resolveConfig();
      assert.equal(
        resolved.webUiEnabled,
        false,
        'Explicit SQLite false must NOT fall back to env true'
      );
      assert.equal(
        resolved.quotaAlertThresholdPercent,
        0,
        'Explicit SQLite 0 must NOT fall back to env 30'
      );

      assert.equal(store.get('webUiEnabled'), false);
      assert.equal(store.get('quotaAlertThresholdPercent'), 0);

      store.close();
      cleanup();
    });
  });
});
