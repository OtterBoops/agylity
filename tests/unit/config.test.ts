import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  RawEnvSchema,
  CONFIG_DOC_GROUPS,
  CONFIG_KEY_ENV_NAMES,
  CONFIG_REGISTRY,
  CANONICAL_SECRET_CONFIG_KEYS,
  ENV_TO_CONFIG_KEY,
  SECRET_CONFIG_KEY_ENV_NAMES,
  parseRawEnv,
  validateConfigOverridePatch,
  BUILTIN_DEFAULTS,
} from '../../src/config/registry.js';
import { booleanEnv, milestoneHoursEnv, RepositoriesJsonSchema } from '../../src/config/env.js';
import { applyConfigReference, renderEnvExample } from '../../src/config/docs.js';
import { PR_POLICIES, PR_POLICY_HINTS } from '../../src/shared/policies.js';
import { PR_POLICY_VALUES } from '../../src/shared/contracts.js';
import { ConfigStore } from '../../src/config/store.js';
import { warnDeprecatedEnvVars } from '../../src/config/deprecated.js';
import { logger } from '../../src/logs/logger.js';
import { createMemorySink, makeTempDir } from '../e2e/harness/index.js';

describe('Zod Configuration Schema & Preprocessors', () => {
  it('parses valid environment variables with correct coerced types', () => {
    const raw = {
      NOTIFICATION_CHANNELS: 'discord',
      QUOTA_CHECK_INTERVAL_SECONDS: '600',
      QUOTA_ALERT_THRESHOLD_PERCENT: '30',
      WEB_UI_PORT: '8080',
      MIN_DISPATCH_HEADROOM_PERCENT: '15',
      WEB_UI_AUTH_TOKEN: 'secret-token-123',
    };
    const parsed = RawEnvSchema.parse(raw);
    // RawEnvSchema publishes the converted value: a channel list, not the raw comma string.
    assert.deepEqual(parsed.NOTIFICATION_CHANNELS, ['discord']);
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
      RUNNER_SHARED_SECRET: 'your_runner_shared_secret_here',
    };
    const parsed = parseRawEnv(env);
    assert.equal(parsed.discordToken, undefined);
    assert.equal(parsed.discordOwnerUserId, undefined);
    assert.equal(parsed.webhookSecret, undefined);
    assert.equal(parsed.webUiAuthToken, undefined);
    assert.equal(parsed.antigravityCsrfToken, undefined);
    assert.equal(parsed.runnerSharedSecret, undefined);
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
    // The evaluator ignores an empty window list, so a patch must not be able to store one.
    assert.throws(
      () => validateConfigOverridePatch({ quotaMilestoneHours: [] }),
      /Too small: expected array to have >=1 items/
    );
    // An inherited Object member is not a config key, so it must not slip past the lookup.
    assert.throws(
      () => validateConfigOverridePatch({ toString: 'x' }),
      /Unknown configuration key/
    );
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
    assert.deepEqual(milestoneHoursEnv.parse(''), [48, 24, 12]);
    assert.deepEqual(milestoneHoursEnv.parse(undefined), [48, 24, 12]);
    assert.deepEqual(milestoneHoursEnv.parse([10, 5]), [10, 5]);
  });

  it('resolves the shipped milestones, burn window and dispatch model through the store', () => {
    const store = new ConfigStore(':memory:', {});
    const config = store.resolveConfig();
    assert.deepEqual(config.quotaMilestoneHours, [48, 24, 12]);
    assert.equal(config.quotaBurnMaxHours, 4);
    assert.equal(config.defaultDispatchModel, 'gemini-4-hydrogen');
    store.close();
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
      NOTIFICATION_CHANNELS: 'webhook',
      QUOTA_CHECK_INTERVAL_SECONDS: '300',
      QUOTA_MILESTONE_HOURS: '12,6,1',
      WEB_UI_ENABLED: 'false',
      MIN_DISPATCH_HEADROOM_PERCENT: '20',
    });

    assert.equal(mapped.notificationChannel, 'webhook');
    assert.deepEqual(mapped.notificationChannels, ['webhook']);
    assert.equal(mapped.quotaCheckIntervalSeconds, 300);
    assert.deepEqual(mapped.quotaMilestoneHours, [12, 6, 1]);
    assert.equal(mapped.webUiEnabled, false);
    assert.equal(mapped.minDispatchHeadroomPercent, 20);
  });

  it('keeps a repository description through the schema instead of dropping it', () => {
    const [described] = RepositoriesJsonSchema.parse(
      JSON.stringify([
        {
          id: 'agylity',
          name: 'Agylity Core',
          path: '/opt/agylity',
          description: '  Coordinator and runner  ',
        },
      ])
    );
    assert.equal(described?.description, 'Coordinator and runner');

    const [undescribed] = RepositoriesJsonSchema.parse(
      JSON.stringify([{ id: 'agylity', name: 'Agylity Core', path: '/opt/agylity' }])
    );
    assert.equal(undescribed !== undefined && 'description' in undescribed, false);
  });

  it('refuses a WEBHOOK_CUSTOM_HEADERS value that is not a flat string map', () => {
    assert.deepEqual(
      parseRawEnv({ WEBHOOK_CUSTOM_HEADERS: '{"X-Source":"agylity","X-Trace":"42"}' })
        .webhookCustomHeaders,
      { 'X-Source': 'agylity', 'X-Trace': '42' }
    );

    for (const raw of ['{"x":123}', '[1,2]', '{"nested":{"a":"b"}}', '{ broken']) {
      const parsed = parseRawEnv({ WEBHOOK_CUSTOM_HEADERS: raw });
      assert.equal('webhookCustomHeaders' in parsed, false, `expected a rejection for: ${raw}`);
    }
  });

  it('folds a pool policy set saved under the pre-merge group keys onto the merged group', () => {
    const legacy = validateConfigOverridePatch({
      poolGroupPolicies: {
        claude: { alertsEnabled: false, dispatchEnabled: false },
        'gemini-argon': { alertsEnabled: true, dispatchEnabled: true },
        'gemini-flash': { alertsEnabled: false, dispatchEnabled: true },
      },
    }) as Record<string, Record<string, { alertsEnabled: boolean; dispatchEnabled: boolean }>>;

    // The first legacy key in LEGACY_POOL_GROUPS claims the merged key; the rest collapse into it.
    assert.deepEqual(legacy.poolGroupPolicies?.gemini, {
      alertsEnabled: false,
      dispatchEnabled: true,
    });
    assert.equal(legacy.poolGroupPolicies?.['gemini-flash'], undefined);
    assert.equal(legacy.poolGroupPolicies?.['gemini-argon'], undefined);

    // A payload that already names the merged group keeps it, even beside a legacy spelling.
    const current = validateConfigOverridePatch({
      poolGroupPolicies: {
        claude: { alertsEnabled: true, dispatchEnabled: true },
        gemini: { alertsEnabled: true, dispatchEnabled: false },
        'gemini-hydrogen': { alertsEnabled: true, dispatchEnabled: true },
      },
    }) as Record<string, Record<string, { alertsEnabled: boolean; dispatchEnabled: boolean }>>;

    assert.equal(current.poolGroupPolicies?.gemini?.dispatchEnabled, false);
    assert.equal(current.poolGroupPolicies?.['gemini-hydrogen'], undefined);
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
      notificationChannel: 'webhook' as const,
    };
    const store = new ConfigStore(':memory:', envOverrides);

    // Initial state: Level 2 wins over Level 3
    assert.equal(store.get('quotaCheckIntervalSeconds'), 1200);
    assert.equal(store.get('notificationChannel'), 'webhook');

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
    assert.equal(store.get('notificationChannel'), 'webhook');

    store.close();
  });

  it('keeps a falsy override that an env value would otherwise win with', () => {
    const store = new ConfigStore(':memory:', {
      quotaAlertThresholdPercent: 40,
      minDispatchHeadroomPercent: 25,
      coordinatorEnabled: true,
      allowedIpRanges: ['10.0.0.0/8'],
    });

    store.setOverride('quotaAlertThresholdPercent', 0);
    store.setOverride('minDispatchHeadroomPercent', 0);
    store.setOverride('coordinatorEnabled', false);
    store.setOverride('allowedIpRanges', []);

    const resolved = store.resolveConfig();
    assert.equal(resolved.quotaAlertThresholdPercent, 0);
    assert.equal(resolved.minDispatchHeadroomPercent, 0);
    assert.equal(resolved.coordinatorEnabled, false);
    assert.deepEqual(resolved.allowedIpRanges, []);

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
    assert.equal(store.getAll()['quotaCheckIntervalSeconds'], 450);

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
});

describe('Coordinator GitHub token configuration', () => {
  it('resolves githubToken from the env spelling, then a SQLite override that wins, and to undefined when unset', () => {
    const { dir, cleanup } = makeTempDir('config_github_token_');

    try {
      const envConfig = parseRawEnv({ GITHUB_TOKEN: ' ghp_env_token ' });
      assert.equal(envConfig.githubToken, 'ghp_env_token');

      const store = new ConfigStore(path.join(dir, 'test.db'), envConfig);
      try {
        assert.equal(store.resolveConfig().githubToken, 'ghp_env_token');
        assert.equal(store.get('githubToken'), 'ghp_env_token');
        assert.equal(store.getSources().githubToken, 'env');

        store.setOverride('githubToken', 'ghp_override_token');
        assert.equal(store.resolveConfig().githubToken, 'ghp_override_token');
        assert.equal(store.get('githubToken'), 'ghp_override_token');
        assert.equal(store.getSources().githubToken, 'override');
      } finally {
        store.close();
      }

      const unset = new ConfigStore(path.join(dir, 'unset.db'), {});
      try {
        assert.equal(unset.resolveConfig().githubToken, undefined);
        assert.equal(unset.get('githubToken'), undefined);
      } finally {
        unset.close();
      }
    } finally {
      cleanup();
    }
  });

  it('persists githubToken as enc:v1 at rest and reads the plaintext back', () => {
    const { dir, cleanup } = makeTempDir('config_github_token_secret_');
    const dbPath = path.join(dir, 'test.db');
    const plaintext = 'ghp_at_rest_plaintext';

    try {
      const store = new ConfigStore(dbPath, {});
      try {
        store.setOverride('githubToken', plaintext);

        const raw = store.getDatabase().getRaw('githubToken');
        assert.ok(raw, 'githubToken must be written to the settings table');
        assert.match(raw, /^"enc:v1:/);
        assert.equal(raw.includes(plaintext), false, 'the raw row must not contain the token');
        assert.equal(store.get('githubToken'), plaintext);
        assert.equal(store.resolveConfig().githubToken, plaintext);
      } finally {
        store.close();
      }

      const reopened = new ConfigStore(dbPath, {});
      try {
        assert.equal(reopened.get('githubToken'), plaintext);
        assert.equal(reopened.resolveConfig().githubToken, plaintext);
      } finally {
        reopened.close();
      }
    } finally {
      cleanup();
    }
  });

  it('falls back to the env token when the githubToken override is cleared', () => {
    const { dir, cleanup } = makeTempDir('config_github_token_clear_');
    const store = new ConfigStore(path.join(dir, 'test.db'), { githubToken: 'ghp_env_token' });

    try {
      store.setOverride('githubToken', 'ghp_override_token');
      assert.equal(store.get('githubToken'), 'ghp_override_token');

      store.removeOverride('githubToken');
      assert.equal(store.resolveConfig().githubToken, 'ghp_env_token');
      assert.equal(store.get('githubToken'), 'ghp_env_token');
      assert.equal(store.getDatabase().getRaw('githubToken'), undefined);
    } finally {
      store.close();
      cleanup();
    }
  });

  it('defaults allowTokenlessRunner to false and honours both env and override', () => {
    const { dir, cleanup } = makeTempDir('config_allow_tokenless_');

    try {
      assert.equal(parseRawEnv({ ALLOW_TOKENLESS_RUNNER: 'true' }).allowTokenlessRunner, true);

      const defaults = new ConfigStore(path.join(dir, 'defaults.db'), {});
      try {
        assert.equal(defaults.resolveConfig().allowTokenlessRunner, false);
        assert.equal(defaults.get('allowTokenlessRunner'), false);
      } finally {
        defaults.close();
      }

      const store = new ConfigStore(path.join(dir, 'env.db'), { allowTokenlessRunner: true });
      try {
        assert.equal(store.resolveConfig().allowTokenlessRunner, true);

        store.setOverride('allowTokenlessRunner', false);
        assert.equal(store.resolveConfig().allowTokenlessRunner, false);
        assert.equal(store.get('allowTokenlessRunner'), false);

        store.removeOverride('allowTokenlessRunner');
        assert.equal(store.resolveConfig().allowTokenlessRunner, true);
      } finally {
        store.close();
      }
    } finally {
      cleanup();
    }
  });
});

describe('parseRawEnv malformed-value resilience', () => {
  it('falls back to built-in defaults instead of throwing on malformed env values', () => {
    const parsed = parseRawEnv({
      REPOSITORIES_JSON: '{ broken json',
      COORDINATOR_ENABLED: 'maybe',
      WEB_UI_ENABLED: 'sure',
      QUOTA_MILESTONE_HOURS: 'abc,def',
    });

    assert.equal(parsed.repositories, undefined);
    assert.equal(parsed.coordinatorEnabled, undefined);
    assert.equal(parsed.webUiEnabled, undefined);
    assert.deepEqual(parsed.quotaMilestoneHours, [48, 24, 12]);

    // The ConfigStore constructor must not crash; the resolved config uses the defaults
    const store = new ConfigStore(':memory:', parsed);
    const config = store.resolveConfig();
    assert.deepEqual(config.repositories, []);
    assert.equal(config.coordinatorEnabled, false);
    assert.equal(config.webUiEnabled, false);
    assert.deepEqual(config.quotaMilestoneHours, [48, 24, 12]);
    store.close();
  });

  it('parses each env field independently so one bad value does not drop the rest', () => {
    const parsed = parseRawEnv({
      COORDINATOR_ENABLED: 'maybe',
      REPOSITORIES_JSON: '{ broken json',
      LOG_LEVEL: 'debug',
      QUOTA_CHECK_INTERVAL_SECONDS: '300',
    });

    assert.equal(parsed.coordinatorEnabled, undefined);
    assert.equal(parsed.repositories, undefined);
    assert.equal(parsed.logLevel, 'debug');
    assert.equal(parsed.quotaCheckIntervalSeconds, 300);
  });

  it('drops an unparsable ALLOW_OVERAGE instead of throwing', () => {
    const parsed = parseRawEnv({ ALLOW_OVERAGE: 'maybe' });

    assert.equal('allowOverage' in parsed, false);
  });

  it('trims a padded env value so it reaches the consumer bind-ready', () => {
    assert.equal(parseRawEnv({ WEB_UI_HOST: ' 0.0.0.0 ' }).webUiHost, '0.0.0.0');
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

describe('ConfigStore accessor agreement', () => {
  it('get() and resolveConfig() agree on notificationChannel when only the plural form is set', () => {
    const store = new ConfigStore(':memory:', {});
    store.setOverride('notificationChannels', ['webhook']);

    const resolved = store.resolveConfig();
    assert.equal(resolved.notificationChannel, 'webhook');
    // Reading the singular key raw would return the built-in 'none' instead.
    assert.equal(store.get('notificationChannel'), 'webhook');

    store.close();
  });
});

describe('Antigravity CLI update scheduling configuration', () => {
  it('coerces AGY_UPDATE_INTERVAL_HOURS, defaults to 24 and lets 0 disable it', () => {
    const parsed = RawEnvSchema.parse({ AGY_UPDATE_INTERVAL_HOURS: '6' });
    assert.equal(parsed.AGY_UPDATE_INTERVAL_HOURS, 6);

    assert.equal(parseRawEnv({}).agyUpdateIntervalHours, undefined);
    const defaults = new ConfigStore(':memory:', {});
    try {
      assert.equal(defaults.resolveConfig().agyUpdateIntervalHours, 24);
    } finally {
      defaults.close();
    }
    assert.equal(parseRawEnv({ AGY_UPDATE_INTERVAL_HOURS: '0' }).agyUpdateIntervalHours, 0);

    assert.equal(
      validateConfigOverridePatch({ agyUpdateIntervalHours: 12 }).agyUpdateIntervalHours,
      12
    );
    assert.throws(() => validateConfigOverridePatch({ agyUpdateIntervalHours: -1 }));
  });

  it('warns at boot when removed legacy env vars are still set', () => {
    const warnings: string[] = [];
    const found = warnDeprecatedEnvVars(
      { NOTIFICATION_CHANNEL: 'discord', WEBHOOK_URL: '   ', ENCRYPTION_KEY: 'secret' },
      { warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')) }
    );
    assert.deepEqual(found, ['NOTIFICATION_CHANNEL', 'ENCRYPTION_KEY']);
    assert.equal(warnings.length, 2);
    assert.ok(warnings[0]?.includes('NOTIFICATION_CHANNELS'));
    assert.ok(warnings[1]?.includes('AGYLITY_SECRET_KEY'));
  });
});

describe('Backlog dispatch headroom configuration', () => {
  it('defaults backlogMinHeadroomPercent to 40 and parses the env spelling, including 0 and 100', () => {
    // Unset env leaves the field absent so the default applies downstream.
    assert.equal(parseRawEnv({}).backlogMinHeadroomPercent, undefined);

    assert.equal(
      RawEnvSchema.parse({ BACKLOG_MIN_HEADROOM_PERCENT: '55' }).BACKLOG_MIN_HEADROOM_PERCENT,
      55
    );
    assert.equal(parseRawEnv({ BACKLOG_MIN_HEADROOM_PERCENT: '55' }).backlogMinHeadroomPercent, 55);

    // Boundary values are valid: 0 defers to the global safety floor, 100 is the strictest.
    assert.equal(parseRawEnv({ BACKLOG_MIN_HEADROOM_PERCENT: '0' }).backlogMinHeadroomPercent, 0);
    assert.equal(
      parseRawEnv({ BACKLOG_MIN_HEADROOM_PERCENT: '100' }).backlogMinHeadroomPercent,
      100
    );
  });

  it('lets a SQLite override outrank both the env value and the built-in default', () => {
    const { dir, cleanup } = makeTempDir('config_backlog_headroom_');

    try {
      const defaults = new ConfigStore(path.join(dir, 'defaults.db'), {});
      try {
        assert.equal(defaults.resolveConfig().backlogMinHeadroomPercent, 40);
        assert.equal(defaults.getSources().backlogMinHeadroomPercent, 'default');
      } finally {
        defaults.close();
      }

      const store = new ConfigStore(path.join(dir, 'env.db'), {
        backlogMinHeadroomPercent: 60,
      });
      try {
        // Level 2 beats the built-in default.
        assert.equal(store.resolveConfig().backlogMinHeadroomPercent, 60);
        assert.equal(store.getSources().backlogMinHeadroomPercent, 'env');

        // Level 1 beats both env and the default.
        store.setOverride('backlogMinHeadroomPercent', 25);
        assert.equal(store.resolveConfig().backlogMinHeadroomPercent, 25);
        assert.equal(store.get('backlogMinHeadroomPercent'), 25);
        assert.equal(store.get('BACKLOG_MIN_HEADROOM_PERCENT'), 25);
        assert.equal(store.getSources().backlogMinHeadroomPercent, 'override');

        // Clearing the override falls back to the env value.
        store.deleteOverride('backlogMinHeadroomPercent');
        assert.equal(store.resolveConfig().backlogMinHeadroomPercent, 60);
        assert.equal(store.getSources().backlogMinHeadroomPercent, 'env');
      } finally {
        store.close();
      }
    } finally {
      cleanup();
    }
  });

  it('rejects out-of-range overrides but accepts a value inside 0-100', () => {
    assert.equal(
      validateConfigOverridePatch({ backlogMinHeadroomPercent: 55 }).backlogMinHeadroomPercent,
      55
    );

    assert.throws(() => validateConfigOverridePatch({ backlogMinHeadroomPercent: 101 }), /Too big/);
    assert.throws(
      () => validateConfigOverridePatch({ backlogMinHeadroomPercent: -1 }),
      /Too small/
    );
  });
});

describe('CONFIG_REGISTRY (single source of config truth)', () => {
  it('maps every registry env spelling onto its config key in both directions', () => {
    const pairs = CONFIG_REGISTRY.filter(
      (entry) => entry.env !== undefined && entry.key !== undefined
    );
    const envSpellings = CONFIG_REGISTRY.flatMap((entry) => (entry.env ? [entry.env] : []));
    assert.equal(new Set(envSpellings).size, envSpellings.length, 'env spellings must be unique');

    for (const entry of pairs) {
      assert.equal(CONFIG_KEY_ENV_NAMES[entry.key], entry.env);
      assert.equal(ENV_TO_CONFIG_KEY[entry.env], entry.key);
    }
    assert.equal(
      Object.keys(ENV_TO_CONFIG_KEY).length,
      pairs.length,
      'ENV_TO_CONFIG_KEY must hold exactly the registry pairs'
    );
  });

  it('documents every entry in a declared group', () => {
    const groups = new Set(CONFIG_DOC_GROUPS.map((group) => group.id));
    for (const entry of CONFIG_REGISTRY) {
      const name = entry.env ?? entry.key;
      assert.ok(entry.description.trim() !== '', `${name} needs a description`);
      assert.ok(groups.has(entry.group), `${name} names an undeclared doc group`);
    }
  });

  it('accepts each built-in default as an override, so every key is dashboard-writable', () => {
    for (const [key, value] of Object.entries(BUILTIN_DEFAULTS)) {
      assert.doesNotThrow(
        () => validateConfigOverridePatch({ [key]: structuredClone(value) }),
        `${key} must accept its own built-in default`
      );
    }
  });

  it('derives the secret list and its env spellings from the registry secret flag', () => {
    const secretKeys = CONFIG_REGISTRY.flatMap((entry) =>
      entry.key !== undefined && entry.secret ? [entry.key] : []
    );
    assert.deepEqual([...CANONICAL_SECRET_CONFIG_KEYS].sort(), secretKeys.sort());
    for (const [key, env] of Object.entries(SECRET_CONFIG_KEY_ENV_NAMES)) {
      assert.equal(CONFIG_KEY_ENV_NAMES[key as keyof typeof CONFIG_KEY_ENV_NAMES], env);
    }
  });

  it('keeps docs/configuration.md generated from the registry', () => {
    const docPath = path.resolve(import.meta.dirname, '../../docs/configuration.md');
    const doc = readFileSync(docPath, 'utf8');
    assert.equal(
      applyConfigReference(doc),
      doc,
      'docs/configuration.md is stale: npm run docs:config'
    );
  });

  it('keeps .env.example generated from the registry', () => {
    const envPath = path.resolve(import.meta.dirname, '../../.env.example');
    assert.equal(
      readFileSync(envPath, 'utf8'),
      renderEnvExample(),
      '.env.example is stale: npm run docs:config'
    );
  });
});

describe('PR_POLICIES (single source of policy copy)', () => {
  it('covers every wire value exactly once with a label and a hint', () => {
    assert.deepEqual(
      PR_POLICIES.map((policy) => policy.value).sort(),
      [...PR_POLICY_VALUES].sort()
    );
    for (const policy of PR_POLICIES) {
      assert.ok(policy.label.trim() !== '', `${policy.value} needs a label`);
      assert.equal(PR_POLICY_HINTS[policy.value], policy.hint);
    }
  });
});

describe('TRUSTED_PROXY_RANGES validation', () => {
  it('accepts valid IPv4/IPv6 addresses and CIDR ranges in env and overrides', () => {
    const parsed = parseRawEnv({
      TRUSTED_PROXY_RANGES: '172.18.0.0/16, 10.0.0.1, ::1/128, fc00::/7',
    });
    assert.deepEqual(parsed.trustedProxyRanges, [
      '172.18.0.0/16',
      '10.0.0.1',
      '::1/128',
      'fc00::/7',
    ]);

    const override = validateConfigOverridePatch({
      trustedProxyRanges: ['172.18.0.0/16', '::1/128'],
    });
    assert.deepEqual(override.trustedProxyRanges, ['172.18.0.0/16', '::1/128']);
    assert.deepEqual(
      validateConfigOverridePatch({ trustedProxyRanges: [] }).trustedProxyRanges,
      []
    );
  });

  it('rejects malformed entries in both TRUSTED_PROXY_RANGES env and override patches', () => {
    assert.equal(
      parseRawEnv({ TRUSTED_PROXY_RANGES: '172.18.0.0/16, not-an-ip' }).trustedProxyRanges,
      undefined
    );
    assert.equal(
      parseRawEnv({ TRUSTED_PROXY_RANGES: '10.0.0.0/33' }).trustedProxyRanges,
      undefined
    );
    assert.throws(() => RawEnvSchema.parse({ TRUSTED_PROXY_RANGES: 'not-an-ip' }));
    assert.throws(() => validateConfigOverridePatch({ trustedProxyRanges: ['not-an-ip'] }));
    assert.throws(() => validateConfigOverridePatch({ trustedProxyRanges: ['10.0.0.0/33'] }));
    assert.throws(() => validateConfigOverridePatch({ trustedProxyRanges: [''] }));
  });
});
