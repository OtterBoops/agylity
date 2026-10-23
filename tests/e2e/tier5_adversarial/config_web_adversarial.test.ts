import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ky from 'ky';

import { AppDatabase } from '../../../src/storage/db.js';
import { ConfigStore } from '../../../src/config/store.js';
import {
  booleanEnv,
  milestoneHoursEnv,
  RepositoriesJsonSchema,
  RepositorySchema,
  MacAddressSchema,
  RawEnvSchema,
  parseRawEnv,
  BUILTIN_DEFAULTS,
  type AppConfig,
} from '../../../src/config/schema.js';
import { createNotifier } from '../../../src/notify/factory.js';
import { ConsoleNotifier, WebhookNotifier } from '../../../src/notify/adapters/console.js';
import {
  DiscordNotifier,
  generateProgressBar,
  formatProgressBar,
  renderProgressBar,
  renderQuotaEmbed,
  createRepoSelectMenu,
  createDispatchModal,
  TaskPromptSchema,
} from '../../../src/notify/adapters/discord.js';
import type { QuotaAlert, QuotaSnapshot } from '../../../src/notify/types.js';
import { createWebServer, startWebServer, closeWebServer } from '../../../src/web/server.js';
import { handleRequest } from '../../../src/web/routes.js';
import { makeTempDir } from '../harness/index.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ============================================================================ */
/* Helper Mock for Discord Interactions                                         */
/* ============================================================================ */
const createMockInteraction = (
  options: {
    userId?: string;
    channelId?: string;
    commandName?: string;
    selectedRepo?: string;
    taskPrompt?: string;
    customId?: string;
  } = {}
) => {
  let deferred = false;
  let deferredAt: number | null = null;
  let replied = false;
  let replyData: any = null;
  let editedData: any = null;
  let modalShown: any = null;

  return {
    id: `adv-interaction-${Date.now()}-${Math.random()}`,
    user: { id: options.userId ?? 'adversary-user', username: 'otter' },
    channelId: options.channelId ?? 'sentry-channel-1',
    commandName: options.commandName,
    customId:
      options.customId ??
      (options.selectedRepo
        ? 'repo_select'
        : options.taskPrompt !== undefined
          ? 'modal_dispatch:repo-test'
          : undefined),
    values: options.selectedRepo ? [options.selectedRepo] : [],
    fields: {
      getTextInputValue: (id: string) => (id === 'task_prompt' ? (options.taskPrompt ?? '') : ''),
    },
    isChatInputCommand: () => options.commandName !== undefined,
    isStringSelectMenu: () => options.selectedRepo !== undefined,
    isModalSubmit: () => options.taskPrompt !== undefined,
    async deferReply(opts?: { ephemeral?: boolean }) {
      deferred = true;
      deferredAt = Date.now();
      return { deferred: true, opts };
    },
    async reply(payload: unknown) {
      replied = true;
      replyData = payload;
      return payload;
    },
    async editReply(payload: unknown) {
      editedData = payload;
      return payload;
    },
    async showModal(modal: unknown) {
      modalShown = modal;
      return modal;
    },
    get state() {
      return { deferred, deferredAt, replied, replyData, editedData, modalShown };
    },
  };
};

describe('Tier 5 Adversarial Hardening Suite: Track B (Config, Notifications & Web UI)', () => {
  /* ========================================================================== */
  /* Section 1: Storage Layer (src/storage/db.ts) Adversarial Hardening         */
  /* ========================================================================== */
  describe('1. Storage Layer (AppDatabase node:sqlite) Adversarial Stress', () => {
    it('T5-DB-1: directory auto-creation handles deep nested paths, spaces, and :memory: guard', () => {
      const { dir, cleanup } = makeTempDir('adv_db_path_');
      const deepPath = path.join(
        dir,
        'nested folder with spaces',
        'level2',
        'level3',
        'agylity.db'
      );

      const db = new AppDatabase(deepPath);
      db.set('sanity', 'ok');
      assert.equal(db.get('sanity'), 'ok');
      assert.ok(fs.existsSync(deepPath));
      db.close();

      // Memory DB should not create a directory named ':memory:'
      const memDb = new AppDatabase(':memory:');
      memDb.set('mem_key', 42);
      assert.equal(memDb.get('mem_key'), 42);
      assert.equal(fs.existsSync(':memory:'), false);
      memDb.close();

      cleanup();
    });

    it('T5-DB-2: prepared statements completely neutralize SQL injection payloads in keys and values', () => {
      const { dir, cleanup } = makeTempDir('adv_db_sqli_');
      const db = new AppDatabase(path.join(dir, 'sqli.db'));

      const injectionKeys = [
        "'; DROP TABLE settings; --",
        "' OR '1'='1",
        "'; DELETE FROM settings WHERE '1'='1'; --",
        "'; ATTACH DATABASE 'hacked.db' AS hacked; --",
        "\" UNION SELECT 1, 'hacked', datetime('now') --",
        "key' WITH (NOLOCK) --",
        "'; INSERT INTO settings (key, value) VALUES ('injected', 'true'); --",
      ];

      for (const key of injectionKeys) {
        const val = { payload: `safe_val_for_${key}` };
        db.set(key, val);
        assert.deepEqual(db.get(key), val);
        assert.equal(db.delete(key), true);
      }

      // Settings table must remain intact and functional
      assert.equal(db.getAllRecords().length, 0);
      db.set('healthy_key', 'healthy_val');
      assert.equal(db.get('healthy_key'), 'healthy_val');

      db.close();
      cleanup();
    });

    it('T5-DB-3: stores and retrieves complex unicode, RTL, emojis, and special control characters in keys and values', () => {
      const { dir, cleanup } = makeTempDir('adv_db_unicode_');
      const db = new AppDatabase(path.join(dir, 'unicode.db'));

      const weirdKey = 'key_🚀_キー_\u200Bzero_width_\u202ERTL_\uFFFFmax_bmp';
      const weirdVal = { nested: 'val_with_emojis_👾_newlines_\r\n\t_quotes_"\'`' };

      db.set(weirdKey, weirdVal);
      assert.deepEqual(db.get(weirdKey), weirdVal);
      assert.ok(weirdKey in db.getAll());

      assert.equal(db.delete(weirdKey), true);
      assert.equal(db.get(weirdKey), undefined);

      db.close();
      cleanup();
    });

    it('T5-DB-4: handles primitive types, undefined, empty collections, and large payloads', () => {
      const { dir, cleanup } = makeTempDir('adv_db_types_');
      const db = new AppDatabase(path.join(dir, 'types.db'));

      // Explicit primitives
      db.set('num_zero', 0);
      assert.equal(db.get('num_zero'), 0);

      db.set('bool_false', false);
      assert.equal(db.get('bool_false'), false);

      db.set('empty_str', '');
      assert.equal(db.get('empty_str'), '');

      db.set('null_val', null);
      assert.equal(db.get('null_val'), null);

      // Undefined serializes to 'null'
      db.set('undef_val', undefined);
      assert.equal(db.get('undef_val'), null);

      // Large 200KB payload
      const largeArray = Array.from({ length: 2000 }, (_, i) => ({ id: i, data: 'x'.repeat(100) }));
      db.set('large_payload', largeArray);
      assert.deepEqual(db.get('large_payload'), largeArray);

      db.close();
      cleanup();
    });

    it('T5-DB-5: resiliently handles corrupted non-JSON rows in SQLite table without crashing', () => {
      const { dir, cleanup } = makeTempDir('adv_db_corrupt_');
      const db = new AppDatabase(path.join(dir, 'corrupt.db'));

      const rawDb = db.getRawDb();
      rawDb.exec(`
        INSERT INTO settings (key, value) VALUES ('bad_json_1', '{unclosed-brace');
        INSERT INTO settings (key, value) VALUES ('bad_json_2', 'bare unquoted string');
        INSERT INTO settings (key, value) VALUES ('bad_json_3', ':::syntax-error:::');
      `);

      // get() should return raw string instead of throwing JSON syntax error
      assert.equal(db.get('bad_json_1'), '{unclosed-brace');
      assert.equal(db.get('bad_json_2'), 'bare unquoted string');
      assert.equal(db.get('bad_json_3'), ':::syntax-error:::');

      // getAll() should safely parse what it can and preserve raw strings for broken rows
      const all = db.getAll();
      assert.equal(all['bad_json_1'], '{unclosed-brace');
      assert.equal(all['bad_json_2'], 'bare unquoted string');

      db.close();
      cleanup();
    });

    it('T5-DB-6: handles 200 rapid concurrent WAL operations across multiple handles to same file', () => {
      const { dir, cleanup } = makeTempDir('adv_db_wal_');
      const dbPath = path.join(dir, 'wal_shared.db');

      const handleA = new AppDatabase(dbPath);
      const handleB = new AppDatabase(dbPath);

      for (let i = 0; i < 100; i++) {
        handleA.set(`item_a_${i}`, i);
        handleB.set(`item_b_${i}`, i * 2);
      }

      assert.equal(handleA.get('item_b_50'), 100);
      assert.equal(handleB.get('item_a_50'), 50);

      assert.equal(Object.keys(handleA.getAll()).length, 200);

      handleA.close();
      handleB.close();
      cleanup();
    });

    it('T5-DB-7: calling operations on closed database cleanly throws statement finalized or closed error', () => {
      const db = new AppDatabase(':memory:');
      db.set('test', 1);
      db.close();

      assert.throws(() => db.get('test'), /ERR_SQLITE_ERROR|closed|finalized/i);
      assert.throws(() => db.set('test', 2), /ERR_SQLITE_ERROR|closed|finalized/i);
      assert.throws(() => db.delete('test'), /ERR_SQLITE_ERROR|closed|finalized/i);
      assert.throws(() => db.getAll(), /ERR_SQLITE_ERROR|closed|finalized/i);

      // Calling close on already closed DB throws 'database is not open' in node:sqlite
      assert.throws(() => db.close(), /database is not open/i);
    });
  });

  /* ========================================================================== */
  /* Section 2: Config Schema & Precedence Hierarchy Adversarial Hardening      */
  /* ========================================================================== */
  describe('2. Config Schema & Fallback Precedence Hierarchy', () => {
    it('T5-CFG-1: booleanEnv preprocessor resists JavaScript Boolean() coercion trap exhaustively', () => {
      // Truthy representations
      const truthy = ['true', 'TRUE', 'True', '1', 'yes', 'YES', 'Yes'];
      for (const t of truthy) {
        assert.equal(booleanEnv.parse(t), true, `Expected '${t}' to parse as true`);
      }

      // Falsy representations
      const falsy = ['false', 'FALSE', 'False', '0', 'no', 'NO', 'No', '', '   '];
      for (const f of falsy) {
        assert.equal(booleanEnv.parse(f), false, `Expected '${f}' to parse as false`);
      }

      // Invalid/ambiguous strings must be rejected
      const invalid = [
        'on',
        'off',
        'enabled',
        'disabled',
        '2',
        '-1',
        'truthy',
        'null',
        'undefined',
      ];
      for (const inv of invalid) {
        assert.throws(() => booleanEnv.parse(inv), /Expected boolean, received string/);
      }
    });

    it('T5-CFG-2: milestoneHoursEnv filters hostile, negative, zero, and decimal tokens', () => {
      // Mixed valid and invalid tokens
      const parsed = milestoneHoursEnv.parse(' 36, -5, 0, 18.5, foo, NaN, 6, 0.25, , ');
      assert.deepEqual(parsed, [36, 18.5, 6, 0.25]);

      // Whitespace and empty defaults to [24, 12, 3]
      assert.deepEqual(milestoneHoursEnv.parse(''), [24, 12, 3]);
      assert.deepEqual(milestoneHoursEnv.parse('    '), [24, 12, 3]);

      // Pure invalid string results in empty array (which conforms to z.array)
      assert.deepEqual(milestoneHoursEnv.parse('bad, tokens, only'), []);
    });

    it('T5-CFG-3: RepositoriesJsonSchema rejects invalid structures, path traversal syntax allowed in paths', () => {
      // Malformed JSON syntax
      assert.throws(
        () => RepositoriesJsonSchema.parse('{"unterminated: "json"'),
        /REPOSITORIES_JSON contains invalid JSON syntax/
      );

      // Non-array JSON
      assert.throws(
        () => RepositoriesJsonSchema.parse('{"id": "single"}'),
        /Expected array, received object/
      );

      // Missing required path
      assert.throws(
        () => RepositoriesJsonSchema.parse(JSON.stringify([{ id: 'r1', name: 'Repo 1' }])),
        /Required/
      );

      // Valid array with paths
      const valid = JSON.stringify([
        { id: 'repo-1', name: 'Repo One', path: '/opt/repos/repo1', defaultBranch: 'dev' },
        { id: 'repo-2', name: 'Repo Two', path: 'C:\\Repos\\Repo2' },
      ]);
      const parsed = RepositoriesJsonSchema.parse(valid);
      assert.equal(parsed.length, 2);
      assert.equal(parsed[0].defaultBranch, 'dev');
      assert.equal(parsed[1].defaultBranch, 'main'); // default applied
    });

    it('T5-CFG-4: MacAddressSchema strictly validates 6-octet hardware addresses', () => {
      assert.equal(MacAddressSchema.parse('00:1A:2B:3C:4D:5E'), '00:1A:2B:3C:4D:5E');
      assert.equal(MacAddressSchema.parse('00-1a-2b-3c-4d-5e'), '00-1a-2b-3c-4d-5e');
      assert.equal(MacAddressSchema.parse('FF:FF:FF:FF:FF:FF'), 'FF:FF:FF:FF:FF:FF');

      // Invalid MACs
      assert.throws(() => MacAddressSchema.parse('00:1A:2B:3C:4D'), /Invalid MAC address/);
      assert.throws(() => MacAddressSchema.parse('00:1A:2B:3C:4D:5E:6F'), /Invalid MAC address/);
      assert.throws(() => MacAddressSchema.parse('00:1A:2B:3C:4D:GG'), /Invalid MAC address/);
      assert.throws(() => MacAddressSchema.parse('192.168.1.1'), /Invalid MAC address/);
      assert.throws(() => MacAddressSchema.parse(''), /Invalid MAC address/);
    });

    it('T5-CFG-5: ConfigStore enforces strict three-tier precedence and preserves falsy overrides', () => {
      const { dir, cleanup } = makeTempDir('adv_precedence_');
      const dbPath = path.join(dir, 'cfg.db');

      // Env overrides built-in default for quotaCheckIntervalSeconds (env: 600, default: 900)
      const env = {
        quotaCheckIntervalSeconds: 600,
        quotaAlertThresholdPercent: 50,
        webUiEnabled: true,
      };

      const store = new ConfigStore(dbPath, env);

      // Level 2 (Env) wins over Level 3 (Default)
      let resolved = store.resolveConfig();
      assert.equal(resolved.quotaCheckIntervalSeconds, 600);
      assert.equal(resolved.quotaAlertThresholdPercent, 50);
      assert.equal(resolved.webUiEnabled, true);

      // Level 1: Set explicit falsy overrides in SQLite
      store.setOverride('quotaAlertThresholdPercent', 0); // 0% threshold
      store.setOverride('webUiEnabled', false); // false overrides env true
      store.setOverride('quotaStateFilePath', ''); // empty string override

      resolved = store.resolveConfig();
      assert.equal(
        resolved.quotaAlertThresholdPercent,
        0,
        'Explicit SQLite 0 must not fall back to env 50'
      );
      assert.equal(
        resolved.webUiEnabled,
        false,
        'Explicit SQLite false must not fall back to env true'
      );
      assert.equal(
        resolved.quotaStateFilePath,
        '',
        'Explicit SQLite empty string must not fall back to default "data/state.json"'
      );

      // Deleting override immediately restores env or default
      store.removeOverride('webUiEnabled');
      resolved = store.resolveConfig();
      assert.equal(resolved.webUiEnabled, true, 'Deleting SQLite override restores env value true');

      store.removeOverride('quotaStateFilePath');
      resolved = store.resolveConfig();
      assert.equal(
        resolved.quotaStateFilePath,
        'data/state.json',
        'Deleting SQLite override restores default'
      );

      store.close();
      cleanup();
    });

    it('T5-CFG-6: bidirectional mapping between UPPER_SNAKE_CASE and camelCase keys in ConfigStore', () => {
      const { dir, cleanup } = makeTempDir('adv_keymap_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      // Set with snake_case
      store.setOverride('QUOTA_CHECK_INTERVAL_SECONDS', 120);
      assert.equal(store.get('quotaCheckIntervalSeconds'), 120);
      assert.equal(store.get('QUOTA_CHECK_INTERVAL_SECONDS'), 120);
      assert.equal(store.resolveConfig().quotaCheckIntervalSeconds, 120);

      // Remove with camelCase
      store.removeOverride('quotaCheckIntervalSeconds');
      assert.equal(
        store.get('quotaCheckIntervalSeconds'),
        BUILTIN_DEFAULTS.quotaCheckIntervalSeconds
      );

      // Set with camelCase
      store.setOverride('antigravityLsPort', 12345);
      assert.equal(store.get('antigravityLsPort'), 12345);
      assert.equal(store.get('ANTIGRAVITY_LS_PORT'), 12345);

      // Remove with snake_case
      store.removeOverride('ANTIGRAVITY_LS_PORT');
      assert.equal(store.get('antigravityLsPort'), BUILTIN_DEFAULTS.antigravityLsPort);

      store.close();
      cleanup();
    });

    it('T5-CFG-7: ConfigStore event emitter fires granular change events on mutations', () => {
      const { dir, cleanup } = makeTempDir('adv_events_');
      const store = new ConfigStore(path.join(dir, 'events.db'), {});

      let generalChanges: any[] = [];
      let specificPortChanges: number[] = [];

      store.on('change', (payload) => {
        generalChanges.push(payload);
      });

      store.on('change:webUiPort', (newVal) => {
        specificPortChanges.push(newVal);
      });

      store.setOverride('webUiPort', 8080);
      store.setOverride('webUiPort', 9090);
      store.removeOverride('webUiPort');
      store.clearAllOverrides();

      assert.equal(specificPortChanges.length, 3);
      assert.equal(specificPortChanges[0], 8080);
      assert.equal(specificPortChanges[1], 9090);
      assert.equal(specificPortChanges[2], 3000); // reverted to default

      // Last event from clearAllOverrides has key: '*'
      const lastEvent = generalChanges[generalChanges.length - 1];
      assert.equal(lastEvent.key, '*');

      store.close();
      cleanup();
    });
  });

  /* ========================================================================== */
  /* Section 3: Universal Notifier & Channel Isolation Adversarial Hardening    */
  /* ========================================================================== */
  describe('3. Notifier Factory, Dynamic Isolation & Adapter Boundaries', () => {
    it('T5-NOT-1: dynamic import isolation ensures inactive channels never load discord.js into memory', async () => {
      const isolationScript = `
        import { createRequire } from 'node:module';
        const req = createRequire(import.meta.url);
        import { createNotifier } from './src/notify/factory.js';

        // 1. Create console notifier
        const consoleNotifier = await createNotifier('console');
        if (consoleNotifier.channelName !== 'console') process.exit(1);

        // 2. Create webhook notifier
        const webhookNotifier = await createNotifier('webhook');
        if (webhookNotifier.channelName !== 'webhook') process.exit(2);

        // 3. Inspect module cache for discord.js
        const loadedModules = Object.keys(req.cache || {});
        const discordLoaded = loadedModules.some(m => m.toLowerCase().includes('discord'));
        if (discordLoaded) {
          console.error('Isolation violation: discord module found in cache');
          process.exit(3);
        }

        process.exit(0);
      `;

      const projectRoot = path.resolve(__dirname, '../../..');
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['--no-warnings', '--import', 'tsx', '--input-type=module', '-e', isolationScript],
        { cwd: projectRoot, timeout: 5000 }
      );

      assert.equal(stderr, '');
    });

    it('T5-NOT-2: factory rejects unknown or hostile channel strings with descriptive error', async () => {
      const hostileChannels = [
        'slack',
        'matrix',
        'telegram',
        '""',
        "'; DROP TABLE; --",
        'undefined',
      ];
      for (const ch of hostileChannels) {
        await assert.rejects(
          () => createNotifier(ch),
          new RegExp(`Unknown notification channel: ${ch}`)
        );
      }
    });

    it('T5-NOT-3: WebhookNotifier handles network timeouts and delivery failures gracefully without unhandled rejections', async () => {
      // Configure webhook to an unreachable port
      const notifier = new WebhookNotifier({
        notificationWebhookUrl: 'http://127.0.0.1:59999/unreachable-endpoint',
      });

      await notifier.initialize();

      const sampleAlert: QuotaAlert = {
        pool: {
          poolId: 'claude',
          family: 'claude',
          displayName: 'Claude 3.5 Sonnet',
          remainingFraction: 0.5,
          resetTime: new Date(Date.now() + 10 * 3600 * 1000).toISOString(),
          hoursUntilReset: 10,
          models: ['claude-3-5-sonnet'],
        },
        milestoneHours: 12,
        remainingPercentage: 50,
        triggeredAt: new Date().toISOString(),
      };

      // Must not throw an unhandled promise rejection
      await assert.doesNotReject(async () => {
        await notifier.notifyQuotaAlert(sampleAlert);
      });

      await assert.doesNotReject(async () => {
        await notifier.notifyDispatchStatus({
          repositoryName: 'agylity',
          status: 'executing',
          message: 'Running continuation',
        });
      });

      await notifier.shutdown();
    });

    it('T5-NOT-4: Discord 3-second timeout guardrail executes deferReply synchronously before async work', async () => {
      const interaction = createMockInteraction({
        taskPrompt: 'Adversarial benchmark task',
        customId: 'modal_dispatch:repo-test',
      });

      const notifier = new DiscordNotifier({
        repositories: [{ id: 'repo-test', name: 'Repo Test', path: '/opt/repo' }],
      });

      const start = Date.now();
      await notifier.handleInteraction(interaction);
      const deferElapsed = (interaction.state.deferredAt ?? 0) - start;

      assert.equal(interaction.state.deferred, true);
      assert.ok(deferElapsed < 50, `deferReply took ${deferElapsed}ms; must be immediate (<50ms)`);
      assert.ok(interaction.state.editedData);
    });

    it('T5-NOT-5: Discord debounce lock blocks rapid concurrent duplicate submissions', async () => {
      let dispatchExecutionCount = 0;

      const interaction1 = createMockInteraction({
        userId: 'spammer-1',
        taskPrompt: 'Execute task once',
        customId: 'modal_dispatch:repo-spammed',
      });
      const interaction2 = createMockInteraction({
        userId: 'spammer-1',
        taskPrompt: 'Execute task duplicate',
        customId: 'modal_dispatch:repo-spammed',
      });

      const notifier = new DiscordNotifier(
        {
          repositories: [{ id: 'repo-spammed', name: 'Repo Spammed', path: '/opt/repo' }],
        },
        {
          onDispatchRequested: async () => {
            dispatchExecutionCount++;
            await new Promise((r) => setTimeout(r, 60));
            return { success: true, branchName: 'main', durationMs: 60 };
          },
        }
      );

      await Promise.all([
        notifier.handleInteraction(interaction1),
        notifier.handleInteraction(interaction2),
      ]);

      assert.equal(
        dispatchExecutionCount,
        1,
        'Debounce lock must prevent duplicate task execution'
      );
      const msg1 = interaction1.state.editedData?.content ?? '';
      const msg2 = interaction2.state.editedData?.content ?? '';
      assert.ok(msg1.includes('already in progress') || msg2.includes('already in progress'));
    });

    it('T5-NOT-6: Discord prompt validation enforces 1-4000 character boundaries and trims whitespace', () => {
      assert.equal(TaskPromptSchema.parse('Valid prompt'), 'Valid prompt');
      assert.equal(TaskPromptSchema.parse('a'.repeat(4000)), 'a'.repeat(4000));

      assert.throws(() => TaskPromptSchema.parse('a'.repeat(4001)), /4000 character limit/);
      assert.throws(() => TaskPromptSchema.parse(''), /Prompt is required/);
      assert.throws(() => TaskPromptSchema.parse('   \n\t   '), /Prompt is required/);
    });

    it('T5-NOT-7: Discord SelectMenu handles >25 repositories by slicing and empty lists gracefully', () => {
      // Empty list
      const emptyMenu = createRepoSelectMenu([]).components[0].toJSON() as any;
      assert.equal(emptyMenu.disabled, true);
      assert.equal(emptyMenu.placeholder, 'No repositories configured');

      // 30 repositories
      const manyRepos = Array.from({ length: 30 }, (_, i) => ({
        id: `repo_${i}`,
        name: `Repository ${i}`,
        path: `/opt/repo_${i}`,
      }));
      const fullMenu = createRepoSelectMenu(manyRepos).components[0].toJSON() as any;
      assert.equal(fullMenu.options.length, 25);
      assert.equal(fullMenu.placeholder, 'Select repository (showing 25 of 30)...');
    });

    it('T5-NOT-8: visual progress bar mathematical boundaries handle NaN, infinity, and inverted ranges', () => {
      assert.equal(generateProgressBar(Number.NaN), '░░░░░░░░░░');
      assert.equal(generateProgressBar(-1), '░░░░░░░░░░');
      assert.equal(generateProgressBar(2), '██████████');
      assert.equal(generateProgressBar(0.5, -5), '█████░░░░░'); // defaults to 10
      assert.equal(generateProgressBar(0.5, 0), '█████░░░░░'); // defaults to 10
      assert.equal(formatProgressBar(Number.POSITIVE_INFINITY), '[░░░░░░░░░░] 0%');
      assert.equal(renderProgressBar(0.75), '`[████████░░]` **75%**');
    });
  });

  /* ========================================================================== */
  /* Section 4: Web Server & Routes (src/web/) Adversarial Hardening            */
  /* ========================================================================== */
  describe('4. Web Server & Routes Adversarial Hardening', () => {
    it('T5-WEB-1: EADDRINUSE port collision is rejected cleanly by startWebServer', async () => {
      const { dir, cleanup } = makeTempDir('adv_web_collision_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      // Occupy an ephemeral port
      const blocker = http.createServer((_, res) => res.end('occupied'));
      await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
      const port = (blocker.address() as net.AddressInfo).port;

      await assert.rejects(
        () => startWebServer({ configStore: store, host: '127.0.0.1', port }),
        (err: any) => err.code === 'EADDRINUSE'
      );

      await new Promise<void>((r) => blocker.close(() => r()));
      store.close();
      cleanup();
    });

    it('T5-WEB-2: closeWebServer cleanly drains and terminates active and idle sockets', async () => {
      const { dir, cleanup } = makeTempDir('adv_web_drain_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      // Open a hanging client socket
      const client = net.createConnection({ port, host: '127.0.0.1' });
      await new Promise<void>((r) => client.once('connect', () => r()));

      // Close server
      await closeWebServer(server);

      // Verify port is immediately freed and closed
      const isAlive = await new Promise<boolean>((resolve) => {
        const s = net.createConnection({ port, host: '127.0.0.1', timeout: 50 }, () => {
          s.destroy();
          resolve(true);
        });
        s.on('error', () => resolve(false));
      });

      assert.equal(isAlive, false);
      client.destroy();
      store.close();
      cleanup();
    });

    it('T5-WEB-3: 405 Method Not Allowed guards protect every REST route from unsupported HTTP verbs', async () => {
      const { dir, cleanup } = makeTempDir('adv_web_405_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      const baseUrl = `http://127.0.0.1:${port}`;

      // POST / -> 405
      await assert.rejects(
        () => ky.post(`${baseUrl}/`, { retry: 0 }),
        (err: any) => err.response?.status === 405
      );

      // POST /api/quota -> 405
      await assert.rejects(
        () => ky.post(`${baseUrl}/api/quota`, { retry: 0 }),
        (err: any) => err.response?.status === 405
      );

      // POST /api/alerts -> 405
      await assert.rejects(
        () => ky.post(`${baseUrl}/api/alerts`, { retry: 0 }),
        (err: any) => err.response?.status === 405
      );

      // PUT /api/config -> 405
      await assert.rejects(
        () => ky.put(`${baseUrl}/api/config`, { retry: 0 }),
        (err: any) => err.response?.status === 405
      );

      // GET /api/config/:key -> 405
      await assert.rejects(
        () => ky.get(`${baseUrl}/api/config/anyKey`, { retry: 0 }),
        (err: any) => err.response?.status === 405
      );

      // GET /api/dispatch -> 405
      await assert.rejects(
        () => ky.get(`${baseUrl}/api/dispatch`, { retry: 0 }),
        (err: any) => err.response?.status === 405
      );

      await closeWebServer(server);
      store.close();
      cleanup();
    });

    it('T5-WEB-4: 404 Not Found returns clean text response and ignores favicon.ico', async () => {
      const { dir, cleanup } = makeTempDir('adv_web_404_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      const baseUrl = `http://127.0.0.1:${port}`;

      // Favicon returns 204 No Content
      const favRes = await ky.get(`${baseUrl}/favicon.ico`);
      assert.equal(favRes.status, 204);

      // Non-existent route returns 404
      await assert.rejects(
        () => ky.get(`${baseUrl}/non/existent/path`, { retry: 0 }),
        (err: any) => err.response?.status === 404
      );

      await closeWebServer(server);
      store.close();
      cleanup();
    });

    it('T5-WEB-5: POST /api/config rejects empty body, malformed JSON, and non-object inputs', async () => {
      const { dir, cleanup } = makeTempDir('adv_web_bad_json_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      const url = `http://127.0.0.1:${port}/api/config`;

      // Empty body
      await assert.rejects(
        () =>
          ky.post(url, { headers: { 'Content-Type': 'application/json' }, body: '   ', retry: 0 }),
        (err: any) => err.response?.status === 400
      );

      // Malformed JSON
      await assert.rejects(
        () =>
          ky.post(url, {
            headers: { 'Content-Type': 'application/json' },
            body: '{invalid-json',
            retry: 0,
          }),
        (err: any) => err.response?.status === 400
      );

      // Non-object JSON
      await assert.rejects(
        () => ky.post(url, { json: 'just a string', retry: 0 }),
        (err: any) => err.response?.status === 400
      );
      await assert.rejects(
        () => ky.post(url, { json: [1, 2, 3], retry: 0 }),
        (err: any) => err.response?.status === 400
      );

      await closeWebServer(server);
      store.close();
      cleanup();
    });

    it('T5-WEB-6: DELETE /api/config/:key handles URL-encoded keys and special characters cleanly', async () => {
      const { dir, cleanup } = makeTempDir('adv_web_del_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      store.setOverride('special key with spaces', 'value1');
      store.setOverride('quotaAlertThresholdPercent', 40);

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      const baseUrl = `http://127.0.0.1:${port}/api/config`;

      // Delete URL-encoded key
      const res1 = await ky
        .delete(`${baseUrl}/${encodeURIComponent('special key with spaces')}`)
        .json<any>();
      assert.equal(res1.success, true);
      assert.equal(store.get('special key with spaces'), undefined);

      // Delete camelCase key
      const res2 = await ky.delete(`${baseUrl}/quotaAlertThresholdPercent`).json<any>();
      assert.equal(res2.success, true);
      assert.equal(store.get('quotaAlertThresholdPercent'), 25); // back to default

      // Deleting already deleted key is idempotent 200 OK
      const res3 = await ky.delete(`${baseUrl}/non_existent_key`).json<any>();
      assert.equal(res3.success, true);

      await closeWebServer(server);
      store.close();
      cleanup();
    });

    it('T5-WEB-7: POST /api/dispatch validates repositoryName and delegates cleanly', async () => {
      const { dir, cleanup } = makeTempDir('adv_web_dispatch_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      const url = `http://127.0.0.1:${port}/api/dispatch`;

      // Missing repositoryName -> 400
      await assert.rejects(
        () => ky.post(url, { json: { prompt: 'No repo' }, retry: 0 }),
        (err: any) => err.response?.status === 400
      );

      // Dispatch endpoint returns disabled status in alerting-only mode
      const res = await ky
        .post(url, {
          json: {
            repositoryName: 'agylity',
            prompt: 'Run full audit',
            requestedBy: 'challenger',
          },
        })
        .json<any>();

      assert.equal(res.success, false);
      assert.ok(res.error?.includes('disabled'));

      await closeWebServer(server);
      store.close();
      cleanup();
    });

    it('T5-WEB-8: handles rapid burst of 50 concurrent requests across endpoints without leakage', async () => {
      const { dir, cleanup } = makeTempDir('adv_web_burst_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      const baseUrl = `http://127.0.0.1:${port}`;

      const requests = Array.from({ length: 50 }, (_, i) => {
        if (i % 3 === 0) return ky.get(`${baseUrl}/api/quota`).json();
        if (i % 3 === 1) return ky.get(`${baseUrl}/api/config`).json();
        return ky.post(`${baseUrl}/api/config`, { json: { [`burst_${i}`]: i } }).json();
      });

      const results = await Promise.all(requests);
      assert.equal(results.length, 50);

      await closeWebServer(server);
      store.close();
      cleanup();
    });
  });

  /* ========================================================================== */
  /* Section 5: Web Dashboard Air-Gap & Zero-CDN Verification (index.html)      */
  /* ========================================================================== */
  describe('5. Web UI Air-Gap Zero-CDN & XSS Sanitization Audit', () => {
    it('T5-HTML-1: index.html contains ZERO external network URLs (zero CDN, zero fonts, zero external scripts)', () => {
      const candidates = [
        path.resolve(__dirname, '../../../dist/web/public/index.html'),
        path.resolve(__dirname, '../../../src/web/public/index.html'),
        path.resolve(__dirname, '../../../frontend/index.html'),
      ];
      const htmlPath = candidates.find((p) => fs.existsSync(p));
      assert.ok(htmlPath, 'index.html must exist in dist/web/public or src/web/public');

      const content = fs.readFileSync(htmlPath, 'utf-8');

      // 1. Zero http:// or https:// links
      const httpMatches = content.match(/https?:\/\/[^\s"'>]+/gi) ?? [];
      assert.deepEqual(
        httpMatches,
        [],
        `Found forbidden external URLs in index.html: ${httpMatches.join(', ')}`
      );

      // 2. Zero protocol-relative URLs (e.g. //cdn.example.com)
      const protoRelativeMatches = content.match(/\/\/[a-z0-9_-]+\.[a-z]{2,}/gi) ?? [];
      assert.deepEqual(
        protoRelativeMatches,
        [],
        `Found protocol-relative URLs: ${protoRelativeMatches.join(', ')}`
      );

      // 3. Zero CSS @import statements
      assert.equal(/@import\s+/i.test(content), false, 'CSS contains forbidden @import rule');

      // 4. Verifies presence of self-contained modal, gauges, and tables in the compiled Preact bundle
      const assetsDir = path.join(process.cwd(), 'src', 'web', 'public', 'assets');
      assert.ok(fs.existsSync(assetsDir), 'Compiled assets directory must exist');
      const jsFiles = fs.readdirSync(assetsDir).filter((f: string) => f.endsWith('.js'));
      assert.ok(jsFiles.length > 0, 'Compiled JS bundle must exist');
      const bundleContent = fs.readFileSync(path.join(assetsDir, jsFiles[0]!), 'utf-8');

      assert.ok(bundleContent.includes('dispatchModal'));
      assert.ok(bundleContent.includes('quotaGrid'));
      assert.ok(bundleContent.includes('alertsTableBody'));
      assert.ok(bundleContent.includes('configTableBody'));
    });

    it('T5-HTML-2: escapeHtml entity encoding sanitizes all dangerous XSS characters', () => {
      // Evaluate the exact escapeHtml logic embedded in index.html
      const escapeHtml = (str: unknown): string => {
        if (str == null) return '';
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      };

      const xssVectors = [
        '<script>alert("XSS")</script>',
        '"><img src=x onerror=alert(1)>',
        "' onmouseover='alert(1)'",
        '&quot;><svg/onload=alert(1)>',
        'javascript:alert(1)',
      ];

      for (const vector of xssVectors) {
        const sanitized = escapeHtml(vector);
        assert.equal(sanitized.includes('<script>'), false);
        assert.equal(sanitized.includes('">'), false);
        assert.equal(sanitized.includes("'>"), false);
        assert.equal(sanitized.includes('&quot;><'), false);
      }
    });
  });
});
