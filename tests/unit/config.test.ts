import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RawEnvSchema,
  booleanEnv,
  milestoneHoursEnv,
  RepositoriesJsonSchema,
  parseRawEnv,
  validateConfigOverridePatch,
  BUILTIN_DEFAULTS,
} from '../../src/config/schema.js';
import { ConfigStore } from '../../src/config/store.js';
import { logger, createMemorySink } from '../../src/logs/logger.js';

describe('Zod Configuration Schema & Preprocessors', () => {
  it('parses valid environment variables with correct coerced types', () => {
    const raw = {
      NOTIFICATION_CHANNEL: 'discord',
      QUOTA_CHECK_INTERVAL_SECONDS: '600',
      QUOTA_ALERT_THRESHOLD_PERCENT: '30',
      WEB_UI_PORT: '8080',
      MIN_DISPATCH_HEADROOM_PERCENT: '15',
      WEB_UI_AUTH_TOKEN: 'secret-token-123',
    };
    const parsed = RawEnvSchema.parse(raw);
    assert.equal(parsed.NOTIFICATION_CHANNEL, 'discord');
    assert.equal(parsed.QUOTA_CHECK_INTERVAL_SECONDS, 600);
    assert.equal(parsed.QUOTA_ALERT_THRESHOLD_PERCENT, 30);
    assert.equal(parsed.WEB_UI_PORT, 8080);
    assert.equal(parsed.MIN_DISPATCH_HEADROOM_PERCENT, 15);
    assert.equal(parsed.WEB_UI_AUTH_TOKEN, 'secret-token-123');
  });

  it('filters out your_*_here template placeholder credentials in parseRawEnv', () => {
    const env = {
      DISCORD_TOKEN: 'your_discord_bot_token_here',
      DISCORD_OWNER_USER_ID: 'your_discord_user_id_here',
      WEBHOOK_SECRET: 'your_webhook_secret_here',
      WEB_UI_AUTH_TOKEN: 'your_web_ui_auth_token_here',
      ANTIGRAVITY_CSRF_TOKEN: 'your_csrf_token_here',
      WORKER_SHARED_SECRET: 'your_worker_shared_secret_here',
    };
    const parsed = parseRawEnv(env);
    assert.equal(parsed.discordToken, undefined);
    assert.equal(parsed.discordOwnerUserId, undefined);
    assert.equal(parsed.webhookSecret, undefined);
    assert.equal(parsed.webUiAuthToken, undefined);
    assert.equal(parsed.antigravityCsrfToken, undefined);
    assert.equal(parsed.workerSharedSecret, undefined);
  });

  it('validates config patches and rejects unknown, invalid or prototype keys', () => {
    const valid = validateConfigOverridePatch({
      quotaCheckIntervalSeconds: 45,
      logLevel: 'debug',
      defaultDispatchModel: 'gemini-3.8-flash',
    });
    assert.equal(valid.quotaCheckIntervalSeconds, 45);
    assert.equal(valid.logLevel, 'debug');
    assert.equal(valid.defaultDispatchModel, 'gemini-3.8-flash');

    assert.throws(
      () => validateConfigOverridePatch({ unknownKey: 123 }),
      /Unknown configuration key/
    );
    assert.throws(
      () => validateConfigOverridePatch(JSON.parse('{"__proto__": {"admin": true}}')),
      /Forbidden configuration key/
    );
    assert.throws(
      () => validateConfigOverridePatch({ constructor: 'dangerous' }),
      /Forbidden configuration key/
    );
    assert.throws(
      () => validateConfigOverridePatch({ defaultDispatchEffort: 'invalid-effort' as any }),
      /Invalid option: expected one of/
    );
  });

  it('fails on invalid NOTIFICATION_CHANNEL enum value', () => {
    assert.throws(() => RawEnvSchema.parse({ NOTIFICATION_CHANNEL: 'telegram' }));
  });

  it('prevents string boolean coercion trap: false coerced to true', () => {
    // Standard JS Boolean('false') === true is a dangerous pitfall
    assert.equal(booleanEnv.parse('false'), false);
    assert.equal(booleanEnv.parse('0'), false);
    assert.equal(booleanEnv.parse('no'), false);
    assert.equal(booleanEnv.parse(''), false);
    assert.equal(booleanEnv.parse(false), false);

    assert.equal(booleanEnv.parse('true'), true);
    assert.equal(booleanEnv.parse('1'), true);
    assert.equal(booleanEnv.parse('yes'), true);
    assert.equal(booleanEnv.parse(true), true);

    assert.throws(() => booleanEnv.parse('not_a_bool'));
  });

  it('parses comma-separated milestone strings into number arrays', () => {
    assert.deepEqual(milestoneHoursEnv.parse('24,12,3'), [24, 12, 3]);
    assert.deepEqual(milestoneHoursEnv.parse(' 48 , 24 , 6 '), [48, 24, 6]);
    assert.deepEqual(milestoneHoursEnv.parse(''), [24, 12, 3]);
    assert.deepEqual(milestoneHoursEnv.parse(undefined), [24, 12, 3]);
    assert.deepEqual(milestoneHoursEnv.parse([10, 5]), [10, 5]);
  });

  it('parses and validates REPOSITORIES_JSON correctly', () => {
    const validJson = JSON.stringify([
      {
        id: 'agylity',
        name: 'Agylity Core',
        path: '/opt/agylity',
        defaultBranch: 'main',
      },
    ]);
    const parsed = RepositoriesJsonSchema.parse(validJson);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.id, 'agylity');
    assert.equal(parsed[0]?.name, 'Agylity Core');
    assert.equal(parsed[0]?.path, '/opt/agylity');
    assert.equal(parsed[0]?.defaultBranch, 'main');

    // Empty or omitted falls back to empty array
    assert.deepEqual(RepositoriesJsonSchema.parse(''), []);
    assert.deepEqual(RepositoriesJsonSchema.parse('[]'), []);

    // Malformed JSON throws
    assert.throws(
      () => RepositoriesJsonSchema.parse('{ broken json'),
      /REPOSITORIES_JSON contains invalid JSON syntax/
    );

    // Missing required field throws
    const invalidEntry = JSON.stringify([{ id: 'missing_path_and_name' }]);
    assert.throws(() => RepositoriesJsonSchema.parse(invalidEntry));
  });

  it('parseRawEnv correctly maps raw env strings to typed Partial<AppConfig>', () => {
    const mapped = parseRawEnv({
      NOTIFICATION_CHANNEL: 'console',
      QUOTA_CHECK_INTERVAL_SECONDS: '300',
      QUOTA_MILESTONE_HOURS: '12,6,1',
      WEB_UI_ENABLED: 'false',
      MIN_DISPATCH_HEADROOM_PERCENT: '20',
    });

    assert.equal(mapped.notificationChannel, 'console');
    assert.equal(mapped.quotaCheckIntervalSeconds, 300);
    assert.deepEqual(mapped.quotaMilestoneHours, [12, 6, 1]);
    assert.equal(mapped.webUiEnabled, false);
    assert.equal(mapped.minDispatchHeadroomPercent, 20);
  });
});

describe('ConfigStore Fallback Precedence Hierarchy (R5)', () => {
  it('Level 3: falls back to Built-in Defaults when neither SQLite nor Env is set', () => {
    const store = new ConfigStore(':memory:', {});
    const config = store.getResolvedConfig();

    assert.equal(config.quotaCheckIntervalSeconds, BUILTIN_DEFAULTS.quotaCheckIntervalSeconds);
    assert.equal(config.notificationChannel, BUILTIN_DEFAULTS.notificationChannel);
    assert.equal(config.webUiEnabled, false);
    assert.equal(config.minDispatchHeadroomPercent, 10);
    assert.deepEqual(config.quotaMilestoneHours, BUILTIN_DEFAULTS.quotaMilestoneHours);

    assert.equal(
      store.get('quotaCheckIntervalSeconds'),
      BUILTIN_DEFAULTS.quotaCheckIntervalSeconds
    );
    store.close();
  });

  it('Level 2: Environment Variables override Built-in Defaults', () => {
    const envOverrides = {
      quotaCheckIntervalSeconds: 1200,
      notificationChannel: 'webhook' as const,
      webUiEnabled: true,
      quotaMilestoneHours: [48, 24],
    };
    const store = new ConfigStore(':memory:', envOverrides);
    const config = store.getResolvedConfig();

    assert.equal(config.quotaCheckIntervalSeconds, 1200);
    assert.equal(config.notificationChannel, 'webhook');
    assert.equal(config.webUiEnabled, true);
    assert.deepEqual(config.quotaMilestoneHours, [48, 24]);

    assert.equal(store.get('quotaCheckIntervalSeconds'), 1200);
    assert.equal(store.get('notificationChannel'), 'webhook');
    store.close();
  });

  it('Level 1: SQLite UI Overrides take precedence over Environment Variables and Defaults', () => {
    const envOverrides = {
      quotaCheckIntervalSeconds: 1200,
      notificationChannel: 'console' as const,
    };
    const store = new ConfigStore(':memory:', envOverrides);

    // Initial state: Level 2 wins over Level 3
    assert.equal(store.get('quotaCheckIntervalSeconds'), 1200);
    assert.equal(store.get('notificationChannel'), 'console');

    // Apply SQLite UI override (Level 1)
    store.setOverride('quotaCheckIntervalSeconds', 300);
    store.setOverride('notificationChannel', 'discord');

    // Level 1 wins over Level 2
    assert.equal(store.get('quotaCheckIntervalSeconds'), 300);
    assert.equal(store.get('notificationChannel'), 'discord');
    const resolved = store.resolveConfig();
    assert.equal(resolved.quotaCheckIntervalSeconds, 300);
    assert.equal(resolved.notificationChannel, 'discord');

    // Removing SQLite UI override cleanly restores Level 2 (env)
    store.deleteOverride('quotaCheckIntervalSeconds');
    assert.equal(store.get('quotaCheckIntervalSeconds'), 1200);
    assert.equal(store.resolveConfig().quotaCheckIntervalSeconds, 1200);

    // Removing another override restores Level 2
    store.removeOverride('notificationChannel');
    assert.equal(store.get('notificationChannel'), 'console');

    store.close();
  });

  it('supports UPPER_SNAKE_CASE key mapping when getting and setting', () => {
    const store = new ConfigStore(':memory:', {
      quotaCheckIntervalSeconds: 1500,
    });

    assert.equal(store.get('QUOTA_CHECK_INTERVAL_SECONDS'), 1500);

    store.setOverride('QUOTA_CHECK_INTERVAL_SECONDS', 450);
    assert.equal(store.get('quotaCheckIntervalSeconds'), 450);
    assert.equal(store.get('QUOTA_CHECK_INTERVAL_SECONDS'), 450);

    store.removeOverride('QUOTA_CHECK_INTERVAL_SECONDS');
    assert.equal(store.get('quotaCheckIntervalSeconds'), 1500);

    store.close();
  });

  it('emits change and change:<key> events when overrides are mutated', () => {
    const store = new ConfigStore(':memory:', {});
    const changeEvents: unknown[] = [];
    let intervalChangedTo: unknown = null;

    store.on('change', (evt) => changeEvents.push(evt));
    store.on('change:quotaCheckIntervalSeconds', (newVal) => {
      intervalChangedTo = newVal;
    });

    store.setOverride('quotaCheckIntervalSeconds', 400);

    assert.equal(changeEvents.length, 1);
    assert.equal(intervalChangedTo, 400);

    store.deleteOverride('quotaCheckIntervalSeconds');
    assert.equal(changeEvents.length, 2);
    assert.equal(intervalChangedTo, BUILTIN_DEFAULTS.quotaCheckIntervalSeconds);

    store.clearAllOverrides();
    assert.equal(changeEvents.length, 3);

    store.close();
  });

  it('implements ConfigStore contract methods (get, set, delete, getAll, resolveConfig)', () => {
    const store = new ConfigStore(':memory:', {});

    // set and get
    store.set('webUiPort', 8088);
    assert.equal(store.get('webUiPort'), 8088);

    // getAll
    const all = store.getAll();
    assert.equal(all['webUiPort'], 8088);

    // resolveConfig
    const resolved = store.resolveConfig();
    assert.equal(resolved.webUiPort, 8088);

    // delete
    store.delete('webUiPort');
    assert.equal(store.get('webUiPort'), BUILTIN_DEFAULTS.webUiPort);

    store.close();
  });
});

describe('parseRawEnv malformed-value resilience', () => {
  it('falls back to built-in defaults instead of throwing on malformed env values', () => {
    const parsed = parseRawEnv({
      REPOSITORIES_JSON: '{ broken json',
      ORCHESTRATOR_ENABLED: 'maybe',
      WEB_UI_ENABLED: 'sure',
      QUOTA_MILESTONE_HOURS: 'abc,def',
    });

    assert.equal(parsed.repositories, undefined);
    assert.equal(parsed.orchestratorEnabled, undefined);
    assert.equal(parsed.webUiEnabled, undefined);
    assert.deepEqual(parsed.quotaMilestoneHours, [24, 12, 3]);

    // The ConfigStore constructor must not crash; the resolved config uses the defaults
    const store = new ConfigStore(':memory:', parsed);
    const config = store.resolveConfig();
    assert.deepEqual(config.repositories, []);
    assert.equal(config.orchestratorEnabled, false);
    assert.equal(config.webUiEnabled, false);
    assert.deepEqual(config.quotaMilestoneHours, [24, 12, 3]);
    store.close();
  });

  it('parses each env field independently so one bad value does not drop the rest', () => {
    const parsed = parseRawEnv({
      ORCHESTRATOR_ENABLED: 'maybe',
      REPOSITORIES_JSON: '{ broken json',
      LOG_LEVEL: 'debug',
      QUOTA_CHECK_INTERVAL_SECONDS: '300',
    });

    assert.equal(parsed.orchestratorEnabled, undefined);
    assert.equal(parsed.repositories, undefined);
    assert.equal(parsed.logLevel, 'debug');
    assert.equal(parsed.quotaCheckIntervalSeconds, 300);
  });

  it('logs a warning naming each malformed variable', () => {
    const memory = createMemorySink();
    const previousLevel = logger.getLevel();
    logger.setLevel('debug');
    const detach = logger.addSink(memory.sink);
    try {
      parseRawEnv({ REPOSITORIES_JSON: '{ broken json', QUOTA_MILESTONE_HOURS: 'abc' });
      const warnings = memory.records
        .filter((record) => record.level === 'warn')
        .map((record) => record.formatted);
      assert.ok(warnings.some((message) => message.includes('REPOSITORIES_JSON')));
      assert.ok(warnings.some((message) => message.includes('QUOTA_MILESTONE_HOURS')));
    } finally {
      detach();
      logger.setLevel(previousLevel);
    }
  });
});
