import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import ky from 'ky';
import { BUILTIN_DEFAULTS, parseRawEnv } from '../../src/config/schema.js';
import { ConfigStore } from '../../src/config/store.js';
import { AppDatabase } from '../../src/storage/db.js';
import {
  encryptSecret,
  decryptSecret,
  isSecretKey,
  maskSecret,
  ENCRYPTION_PREFIX,
} from '../../src/storage/crypto.js';
import { startWebServer, closeWebServer } from '../../src/web/server.js';
import { makeTempDir } from '../e2e/harness/index.js';

describe('Unit Tests: Optional Orchestrator, UI Precedence & Secret Encryption', () => {
  /* ==================================================================== */
  /* 1. Optional Orchestrator & Precedence                                */
  /* ==================================================================== */
  describe('1. Optional Orchestrator & Precedence', () => {
    it('defaults orchestratorEnabled to false in BUILTIN_DEFAULTS', () => {
      assert.equal(BUILTIN_DEFAULTS.orchestratorEnabled, false);
    });

    it('parses ORCHESTRATOR_ENABLED from raw environment variables', () => {
      assert.equal(parseRawEnv({ ORCHESTRATOR_ENABLED: 'true' }).orchestratorEnabled, true);
      assert.equal(parseRawEnv({ ORCHESTRATOR_ENABLED: '1' }).orchestratorEnabled, true);
      assert.equal(parseRawEnv({ ORCHESTRATOR_ENABLED: 'false' }).orchestratorEnabled, false);
      assert.equal(parseRawEnv({ ORCHESTRATOR_ENABLED: '0' }).orchestratorEnabled, false);
      assert.equal(parseRawEnv({}).orchestratorEnabled, undefined);
    });

    it('enforces SQLite UI override precedence over environment variables for orchestratorEnabled', () => {
      const { dir, cleanup } = makeTempDir('orch_precedence_');
      const dbPath = path.join(dir, 'test.db');

      // Env variable sets it to true
      const store = new ConfigStore(dbPath, { orchestratorEnabled: true });
      assert.equal(store.resolveConfig().orchestratorEnabled, true);

      // UI override in SQLite takes absolute precedence and turns it false
      store.setOverride('orchestratorEnabled', false);
      assert.equal(store.resolveConfig().orchestratorEnabled, false);

      // Deleting SQLite override restores the environment variable
      store.deleteOverride('orchestratorEnabled');
      assert.equal(store.resolveConfig().orchestratorEnabled, true);

      store.close();
      cleanup();
    });

    it('POST /api/dispatch blocks dispatch when orchestrator is disabled', async () => {
      const { dir, cleanup } = makeTempDir('orch_dispatch_disabled_');
      const store = new ConfigStore(path.join(dir, 'test.db'), { orchestratorEnabled: false });

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const res = await ky
          .post(`http://127.0.0.1:${port}/api/dispatch`, {
            json: { repositoryName: 'agylity', prompt: 'Continue test task' },
            retry: 0,
          })
          .json<any>();

        assert.equal(res.success, false);
        assert.equal(res.code, 'ORCHESTRATOR_DISABLED');
        assert.ok(res.error?.includes('disabled'));
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 2. AES-256-GCM Secret Encryption & Masking                           */
  /* ==================================================================== */
  describe('2. AES-256-GCM Secret Encryption & Masking', () => {
    it('accurately identifies secret keys', () => {
      assert.equal(isSecretKey('discordToken'), true);
      assert.equal(isSecretKey('DISCORD_TOKEN'), true);
      assert.equal(isSecretKey('antigravityCsrfToken'), true);
      assert.equal(isSecretKey('notificationWebhookUrl'), true);
      assert.equal(isSecretKey('customSecretKey'), true);
      assert.equal(isSecretKey('masterPassword'), true);

      // Non-secrets
      assert.equal(isSecretKey('quotaCheckIntervalSeconds'), false);
      assert.equal(isSecretKey('quotaAlertThresholdPercent'), false);
      assert.equal(isSecretKey('webUiPort'), false);
      assert.equal(isSecretKey('databasePath'), false);
    });

    it('encrypts plaintext with AES-256-GCM and decrypts cleanly', () => {
      const secret = 'discord_bot_token_secret_12345';
      const encrypted = encryptSecret(secret);

      assert.ok(encrypted.startsWith(ENCRYPTION_PREFIX));
      assert.notEqual(encrypted, secret);
      assert.ok(!encrypted.includes('12345'));

      const decrypted = decryptSecret(encrypted);
      assert.equal(decrypted, secret);
    });

    it('encrypts secret keys at rest in SQLite while transparently decrypting on read', () => {
      const { dir, cleanup } = makeTempDir('crypto_db_');
      const dbPath = path.join(dir, 'test.db');
      const db = new AppDatabase(dbPath);

      const tokenValue = 'my-super-secret-discord-token';
      db.set('discordToken', tokenValue);

      // 1. Raw stored value on disk is encrypted with enc:v1: prefix
      const rawStored = db.getRaw('discordToken');
      assert.ok(rawStored);
      assert.ok(rawStored.includes(ENCRYPTION_PREFIX));
      assert.ok(!rawStored.includes(tokenValue)); // Plaintext MUST NOT be in raw database

      // 2. High-level get transparently decrypts
      const fetched = db.get<string>('discordToken');
      assert.equal(fetched, tokenValue);

      // 3. getAll transparently decrypts
      const all = db.getAll();
      assert.equal(all['discordToken'], tokenValue);

      // 4. Non-secret keys are stored unencrypted
      db.set('quotaCheckIntervalSeconds', 600);
      assert.equal(db.getRaw('quotaCheckIntervalSeconds'), '600');
      assert.equal(db.get<number>('quotaCheckIntervalSeconds'), 600);

      db.close();
      cleanup();
    });

    it('masks secret keys in GET /api/config response to prevent credential leakage', async () => {
      const { dir, cleanup } = makeTempDir('crypto_web_mask_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        discordToken: 'super-secret-discord-key',
        antigravityCsrfToken: 'csrf-secret-999',
      });

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const res = await ky.get(`http://127.0.0.1:${port}/api/config`).json<any>();

        // Secrets must be masked
        assert.equal(res.resolved.discordToken, '••••••••');
        assert.equal(res.resolved.antigravityCsrfToken, '••••••••');
        assert.equal(res.secretsMeta.discordToken.isSet, true);
        assert.equal(res.secretsMeta.antigravityCsrfToken.isSet, true);

        // Non-secrets remain visible
        assert.equal(res.resolved.quotaCheckIntervalSeconds, 900);
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('preserves existing secret in SQLite when client posts masked value', async () => {
      const { dir, cleanup } = makeTempDir('crypto_web_preserve_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      store.setOverride('discordToken', 'original-secret-token');

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        // Post masked value (e.g. from saving another setting in UI)
        await ky
          .post(`http://127.0.0.1:${port}/api/config`, {
            json: {
              discordToken: '••••••••',
              quotaAlertThresholdPercent: 40,
            },
          })
          .json<any>();

        // Secret was NOT overwritten with '••••••••'
        assert.equal(store.get('discordToken'), 'original-secret-token');
        assert.equal(store.get('quotaAlertThresholdPercent'), 40);

        // Posting a new real secret DOES update it
        await ky
          .post(`http://127.0.0.1:${port}/api/config`, {
            json: {
              discordToken: 'newly-updated-secret-token',
            },
          })
          .json<any>();

        assert.equal(store.get('discordToken'), 'newly-updated-secret-token');
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });
  });
});
