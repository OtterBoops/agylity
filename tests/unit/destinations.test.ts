import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '../../src/storage/db.js';
import { ConfigStore } from '../../src/config/store.js';
import { decryptSecret } from '../../src/storage/crypto.js';
import { encryptSecret, SECRET_JSON_MARKER } from '../../src/storage/crypto.js';
import {
  destinationChannelName,
  maskNotificationDestinations,
  mergeDestinationSecrets,
  resolveNotificationDestinations,
} from '../../src/config/destinations.js';
import { CompositeNotifier } from '../../src/notify/adapters/composite.js';
import { DEFAULT_NOTIFICATION_TYPES } from '../../src/shared/notificationKinds.js';
import type { DeliveryOutcome, Notifier } from '../../src/notify/types.js';
import { SentryStateManager } from '../../src/sentry/state.js';
import type { NotificationDestination } from '../../src/shared/contracts.js';

const withTempDir = async (fn: (dir: string) => Promise<void> | void): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'agylity-dest-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const legacyInstance = (
  id: string,
  type: NotificationDestination['type'],
  config: Record<string, unknown>
): NotificationDestination => ({
  id,
  type,
  label: type === 'discord' ? 'Discord Bot' : 'Webhook',
  enabled: true,
  pingOwner: true,
  config,
});

describe('Notification destinations: migration', () => {
  it('folds the legacy settings keys into instances and retires them in one transaction', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'agylity.db');
      new AppDatabase(path).close();

      const raw = new DatabaseSync(path);
      const insert = raw.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
      );
      insert.run('discordToken', JSON.stringify('discord-bot-token'));
      insert.run('discordNotificationChannelId', JSON.stringify('1234567890'));
      insert.run('discordClientId', JSON.stringify('client-id'));
      insert.run('discordPingOwner', JSON.stringify(false));
      insert.run('notificationWebhookUrl', JSON.stringify('https://example.test/hook/secret'));
      insert.run('webhookSecret', JSON.stringify('hmac-key'));
      insert.run('webhookPingOwner', JSON.stringify(true));
      insert.run('notificationChannels', JSON.stringify(['discord', 'webhook']));
      raw.prepare('DELETE FROM schema_migrations WHERE version = 10').run();
      raw.close();

      const db = new AppDatabase(path);
      try {
        const store = new ConfigStore(db, {});
        const resolved = store.resolveConfig();

        assert.equal(resolved.destinations.length, 2);
        const discord = resolved.destinations.find((entry) => entry.type === 'discord');
        const webhook = resolved.destinations.find((entry) => entry.type === 'webhook');
        assert.equal(discord?.config.token, 'discord-bot-token');
        assert.equal(discord?.config.channelId, '1234567890');
        assert.equal(discord?.config.clientId, 'client-id');
        assert.equal(discord?.pingOwner, false);
        assert.equal(webhook?.config.url, 'https://example.test/hook/secret');
        assert.equal(webhook?.config.secret, 'hmac-key');

        // The legacy rows are gone, and a re-run of the registry finds nothing to fold.
        assert.equal(db.get('discordToken'), undefined);
        assert.equal(db.get('notificationWebhookUrl'), undefined);
        assert.equal(db.get('notificationChannels'), undefined);
      } finally {
        db.close();
      }
    }));

  it('is a no-op when an explicit destinations row already exists', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'agylity.db');
      new AppDatabase(path).close();

      const raw = new DatabaseSync(path);
      raw
        .prepare("INSERT INTO settings (key, value) VALUES ('destinations', ?)")
        .run(JSON.stringify([legacyInstance('kept', 'webhook', { url: 'https://kept.test' })]));
      raw
        .prepare("INSERT INTO settings (key, value) VALUES ('discordToken', ?)")
        .run(JSON.stringify('orphan-token'));
      raw.prepare('DELETE FROM schema_migrations WHERE version = 10').run();
      raw.close();

      const db = new AppDatabase(path);
      try {
        const store = new ConfigStore(db, {});
        const resolved = store.resolveConfig();
        assert.deepEqual(
          resolved.destinations.map((entry) => entry.id),
          ['kept']
        );
        // The legacy row is still retired, but it never folded into a second instance.
        assert.equal(db.get('discordToken'), undefined);
      } finally {
        db.close();
      }
    }));
});

describe('Notification destinations: per-instance secrets', () => {
  it('encrypts each secret at rest, decrypts on resolve and masks it for the client', () =>
    withTempDir(async (dir) => {
      const db = new AppDatabase(join(dir, 'agylity.db'));
      try {
        const store = new ConfigStore(db, {});
        store.setOverride('destinations', [
          legacyInstance('discord-a', 'discord', { token: 'super-secret-token', channelId: '42' }),
          legacyInstance('webhook-b', 'webhook', {
            url: 'https://hooks.test/services/T/B/secret',
            secret: 'signing-key',
          }),
        ]);

        const rawRow = db.getRaw('destinations');
        assert.ok(rawRow);
        assert.ok(!rawRow.includes('super-secret-token'));
        assert.ok(!rawRow.includes('signing-key'));
        assert.ok(rawRow.includes('enc:v1:'));

        const resolved = store.resolveConfig();
        const discord = resolved.destinations.find((entry) => entry.id === 'discord-a');
        const webhook = resolved.destinations.find((entry) => entry.id === 'webhook-b');
        assert.equal(discord?.config.token, 'super-secret-token');
        assert.equal(discord?.config.channelId, '42');
        assert.equal(webhook?.config.url, 'https://hooks.test/services/T/B/secret');
        assert.equal(webhook?.config.secret, 'signing-key');

        const masked = maskNotificationDestinations(resolved.destinations);
        const maskedDiscord = masked.destinations.find((entry) => entry.id === 'discord-a');
        assert.ok(maskedDiscord);
        assert.equal(maskedDiscord.config.token, '••••••••');
        assert.equal(maskedDiscord.config.channelId, '42');
        assert.equal(masked.meta['discord-a']?.token?.isSet, true);
        assert.equal(masked.meta['webhook-b']?.secret?.isSet, true);
      } finally {
        db.close();
      }
    }));

  it('keeps a stored secret when the masked placeholder is saved back', () =>
    withTempDir(async (dir) => {
      const db = new AppDatabase(join(dir, 'agylity.db'));
      try {
        const store = new ConfigStore(db, {});
        store.setOverride('destinations', [
          legacyInstance('webhook-b', 'webhook', { url: 'https://hooks.test/abc', secret: 'k1' }),
        ]);

        const stored = store.getAllOverrides().destinations as NotificationDestination[];
        const incoming: NotificationDestination[] = [
          {
            ...legacyInstance('webhook-b', 'webhook', { url: '••••••••', secret: '••••••••' }),
            label: 'Renamed hook',
          },
        ];
        store.setOverride('destinations', mergeDestinationSecrets(incoming, stored));

        const resolved = store.resolveConfig();
        const instance = resolved.destinations[0];
        assert.equal(instance?.label, 'Renamed hook');
        assert.equal(instance?.config.url, 'https://hooks.test/abc');
        assert.equal(instance?.config.secret, 'k1');
      } finally {
        db.close();
      }
    }));
});

describe('Notification destinations: resolution and fan-out', () => {
  it('seeds one instance per named legacy channel when no explicit instances exist', () => {
    const seeded = resolveNotificationDestinations({
      notificationChannels: ['discord', 'webhook'],
      discordToken: 't',
      webhookSecret: 's',
    });
    assert.deepEqual(
      seeded.map((entry) => `${entry.type}:${entry.id}`),
      ['discord:discord-seed', 'webhook:webhook-seed']
    );
  });

  it('treats an explicit empty array as none rather than re-seeding', () => {
    assert.deepEqual(
      resolveNotificationDestinations({
        destinations: [],
        notificationChannels: ['discord'],
        discordToken: 't',
      }),
      []
    );
  });

  it('names delivery outcomes by <type>:<id> and marks every instance suppressed', async () => {
    const fake = (name: string): Notifier => ({
      channelName: name,
      initialize: async () => {},
      shutdown: async () => {},
      notifyQuotaAlert: async (): Promise<DeliveryOutcome> => ({
        delivered: true,
        results: { [name]: { success: true } },
      }),
      notifyDispatchStatus: async () => {},
      notifyInfo: async (): Promise<DeliveryOutcome> => ({
        delivered: true,
        results: { [name]: { success: true } },
      }),
    });

    const composite = new CompositeNotifier([fake('discord:abc'), fake('webhook:def')], undefined, {
      notificationTypes: { ...DEFAULT_NOTIFICATION_TYPES, burn_kick: false },
    });

    const outcome = await composite.notifyInfo({
      kind: 'burn_kick',
      title: 'Burn',
      message: 'Pool entered its pre-reset window.',
    });
    assert.equal(outcome.delivered, false);
    assert.equal(outcome.suppressed, true);
    assert.deepEqual(outcome.results, {
      'discord:abc': { success: false, suppressed: true },
      'webhook:def': { success: false, suppressed: true },
    });
    assert.equal(destinationChannelName({ id: 'abc', type: 'discord' }), 'discord:abc');
  });
});

describe('Notification destinations: alert ledger', () => {
  it('persists suppressed channel results in channels_json', () =>
    withTempDir(async (dir) => {
      const db = new AppDatabase(join(dir, 'agylity.db'));
      try {
        const state = new SentryStateManager({ db });
        state.recordDeliveredAlert({
          poolId: 'gemini',
          resetTime: '2030-01-01T00:00:00.000Z',
          milestoneHours: 12,
          headroomPercent: 55,
          channels: { 'discord:abc': { success: false, suppressed: true } },
          firedAt: '2030-01-01T00:00:00.000Z',
        });

        const page = state.listAlertEvents({ limit: 10 });
        assert.equal(page.events.length, 1);
        assert.deepEqual(page.events[0]?.channels, {
          'discord:abc': { success: false, suppressed: true },
        });
      } finally {
        db.close();
      }
    }));
});

describe('Notification destinations: database key and object secrets', () => {
  it('encrypts a custom keyPath database with its own key, including object secrets', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'agylity.db');
      const keyPath = join(dir, 'custom.key');
      const db = new AppDatabase({ path, keyPath });
      try {
        const store = new ConfigStore(db, {});
        store.setOverride('destinations', [
          legacyInstance('hook', 'webhook', {
            url: 'https://hooks.test/x',
            customHeaders: { Authorization: 'Bearer header-secret' },
          }),
        ]);

        const raw = db.getRaw('destinations');
        assert.ok(raw);
        assert.ok(!raw.includes('header-secret'));
        assert.ok(!raw.includes('hooks.test'));

        const parsed = JSON.parse(raw) as NotificationDestination[];
        const headerCipher = String(parsed[0]?.config.customHeaders);
        assert.ok(headerCipher.startsWith('enc:v1:'));
        // The ciphertext must belong to THIS database's key, not the default key file.
        assert.equal(
          decryptSecret(headerCipher, db.getMasterKey()),
          `${SECRET_JSON_MARKER}${JSON.stringify({ Authorization: 'Bearer header-secret' })}`
        );

        const resolved = store.resolveConfig().destinations[0];
        assert.equal(resolved?.config.url, 'https://hooks.test/x');
        assert.deepEqual(resolved?.config.customHeaders, {
          Authorization: 'Bearer header-secret',
        });
      } finally {
        db.close();
      }
    }));

  it('folds a legacy ciphertext into an instance under a custom keyPath', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'agylity.db');
      const keyPath = join(dir, 'custom.key');
      const first = new AppDatabase({ path, keyPath });
      const key = first.getMasterKey();
      first.close();

      const raw = new DatabaseSync(path);
      const insert = raw.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
      );
      insert.run('discordToken', JSON.stringify(encryptSecret('legacy-bot-token', key)));
      insert.run('notificationChannels', JSON.stringify(['discord']));
      raw.prepare('DELETE FROM schema_migrations WHERE version = 10').run();
      raw.close();

      const db = new AppDatabase({ path, keyPath });
      try {
        const store = new ConfigStore(db, {});
        assert.equal(store.resolveConfig().destinations[0]?.config.token, 'legacy-bot-token');
      } finally {
        db.close();
      }
    }));
});

describe('Notification destinations: composite config updates', () => {
  it('keeps each instance config when destinations change and when only the owner changes', async () => {
    const seen: Record<string, any[]> = {};
    const fake = (name: string): Notifier => ({
      channelName: name,
      initialize: async () => {},
      shutdown: async () => {},
      notifyQuotaAlert: async (): Promise<DeliveryOutcome> => ({ delivered: true, results: {} }),
      notifyDispatchStatus: async () => {},
      notifyInfo: async (): Promise<DeliveryOutcome> => ({ delivered: true, results: {} }),
      updateConfig: async (config) => {
        (seen[name] ??= []).push(config);
      },
    });

    const webhook = fake('webhook:a');
    const discord = fake('discord:b');
    const composite = new CompositeNotifier([webhook, discord]);

    const destinations: NotificationDestination[] = [
      legacyInstance('a', 'webhook', { url: 'https://instance-a.test', secret: 's' }),
      legacyInstance('b', 'discord', { token: 'instance-token', channelId: '42' }),
    ];
    composite.setDestinations(destinations);

    await composite.updateConfig({
      destinations,
      notificationWebhookUrl: 'https://global.test',
      discordToken: 'global-token',
    } as any);

    const webhookConfig = seen['webhook:a']?.at(-1);
    assert.equal(webhookConfig?.notificationWebhookUrl, 'https://instance-a.test');
    assert.equal(webhookConfig?.webhookSecret, 's');
    const discordConfig = seen['discord:b']?.at(-1);
    assert.equal(discordConfig?.discordToken, 'instance-token');
    assert.equal(discordConfig?.discordNotificationChannelId, '42');

    await composite.updateConfig({ discordOwnerUserId: 'owner-9' } as any);

    const webhookAfterOwner = seen['webhook:a']?.at(-1);
    assert.equal(webhookAfterOwner?.discordOwnerUserId, 'owner-9');
    assert.equal(webhookAfterOwner?.notificationWebhookUrl, 'https://instance-a.test');
    const discordAfterOwner = seen['discord:b']?.at(-1);
    assert.equal(discordAfterOwner?.discordOwnerUserId, 'owner-9');
    assert.equal(discordAfterOwner?.discordToken, 'instance-token');
  });
});
