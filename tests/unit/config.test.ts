import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RawEnvSchema,
  booleanEnv,
  milestoneHoursEnv,
  RepositoriesJsonSchema,
  MacAddressSchema,
  parseRawEnv,
  BUILTIN_DEFAULTS,
} from '../../src/config/schema.js';
import { ConfigStore } from '../../src/config/store.js';

describe('Zod Configuration Schema & Preprocessors', () => {
  it('parses valid environment variables with correct coerced types', () => {
    const raw = {
      NOTIFICATION_CHANNEL: 'discord',
      QUOTA_CHECK_INTERVAL_SECONDS: '600',
      QUOTA_ALERT_THRESHOLD_PERCENT: '30',
      WEB_UI_PORT: '8080',
      MIN_DISPATCH_HEADROOM_PERCENT: '15',
    };
    const parsed = RawEnvSchema.parse(raw);
    assert.equal(parsed.NOTIFICATION_CHANNEL, 'discord');
    assert.equal(parsed.QUOTA_CHECK_INTERVAL_SECONDS, 600);
    assert.equal(parsed.QUOTA_ALERT_THRESHOLD_PERCENT, 30);
    assert.equal(parsed.WEB_UI_PORT, 8080);
    assert.equal(parsed.MIN_DISPATCH_HEADROOM_PERCENT, 15);
  });

  it('fails on invalid MAC address format', () => {
    assert.throws(() => MacAddressSchema.parse('invalid-mac-format'), /Invalid MAC address format/);
    assert.throws(() => MacAddressSchema.parse('00:11:22:33:44'), /Invalid MAC address format/);
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
