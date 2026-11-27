import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CompositeNotifier } from '../../src/notify/adapters/composite.js';
import type { DeliveryOutcome, Notifier } from '../../src/notify/types.js';
import {
  DEFAULT_NOTIFICATION_TYPES,
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_VALUES,
  notificationKindEnabled,
} from '../../src/shared/notificationKinds.js';
import { NotificationTypesSchema } from '../../src/config/schema.js';

const recordingNotifier = (): Notifier & { infos: number } => {
  const fake = {
    channelName: 'fake',
    infos: 0,
    initialize: async () => {},
    shutdown: async () => {},
    notifyQuotaAlert: async (): Promise<DeliveryOutcome> => ({ delivered: true, results: {} }),
    notifyDispatchStatus: async () => {},
    notifyInfo: async (): Promise<DeliveryOutcome> => {
      fake.infos += 1;
      return { delivered: true, results: { fake: { success: true } } };
    },
  };
  return fake;
};

describe('Notifications: type registry and per-type switches', () => {
  it('gives every kind a label, a description and an enabled default', () => {
    assert.equal(new Set(NOTIFICATION_KIND_VALUES).size, NOTIFICATION_KIND_VALUES.length);
    for (const entry of NOTIFICATION_KINDS) {
      assert.ok(entry.label.length > 0, entry.kind);
      assert.ok(entry.description.length > 0, entry.kind);
      assert.equal(
        DEFAULT_NOTIFICATION_TYPES[entry.kind as keyof typeof DEFAULT_NOTIFICATION_TYPES],
        entry.defaultEnabled
      );
    }
  });

  it('treats a missing switch as the registry default', () => {
    assert.equal(notificationKindEnabled(undefined, 'burn_kick'), true);
    assert.equal(notificationKindEnabled({}, 'burn_kick'), true);
    assert.equal(notificationKindEnabled({ burn_kick: false }, 'burn_kick'), false);
  });

  it('accepts a partial map from a settings override', () => {
    assert.deepEqual(NotificationTypesSchema.parse({ burn_kick: false }), {
      ...DEFAULT_NOTIFICATION_TYPES,
      burn_kick: false,
    });
  });

  it('skips delivery of a switched-off kind without dropping the other kinds', async () => {
    const fake = recordingNotifier();
    const composite = new CompositeNotifier([fake], undefined, {
      notificationTypes: { ...DEFAULT_NOTIFICATION_TYPES, early_reset: false },
    });

    const suppressed = await composite.notifyInfo({
      kind: 'early_reset',
      title: 'Quota reset early',
      message: 'Claude refilled ahead of schedule.',
    });
    assert.equal(suppressed.delivered, false);
    assert.equal(suppressed.suppressed, true);
    assert.deepEqual(suppressed.results, { fake: { success: false, suppressed: true } });
    assert.equal(fake.infos, 0);

    await composite.notifyInfo({ kind: 'burn_kick', title: 'Burn', message: 'Started.' });
    assert.equal(fake.infos, 1);
  });

  it('marks a suppressed quota alert with suppressed: true so callers do not retry it as a delivery failure', async () => {
    let alertCalls = 0;
    const fake: Notifier = {
      channelName: 'fake',
      initialize: async () => {},
      shutdown: async () => {},
      notifyQuotaAlert: async () => {
        alertCalls += 1;
        return { delivered: true, results: { fake: { success: true } } };
      },
      notifyDispatchStatus: async () => {},
      notifyInfo: async () => ({ delivered: true, results: {} }),
    };
    const composite = new CompositeNotifier([fake], undefined, {
      notificationTypes: { ...DEFAULT_NOTIFICATION_TYPES, quota_alert: false },
    });

    const outcome = await composite.notifyQuotaAlert({
      pool: {
        poolId: 'claude',
        poolGroup: 'claude',
        displayName: 'Claude',
        remainingFraction: 0.6,
        resetTime: new Date(Date.now() + 6 * 3600_000).toISOString(),
        hoursUntilReset: 6,
        models: ['Claude'],
      },
      milestoneHours: 12,
      remainingPercentage: 60,
      triggeredAt: new Date().toISOString(),
    });

    assert.equal(outcome.delivered, false);
    assert.equal(outcome.suppressed, true);
    assert.deepEqual(outcome.results, { fake: { success: false, suppressed: true } });
    assert.equal(alertCalls, 0);
  });

  it('suppresses a dispatch embed the same way as an info notice', async () => {
    let dispatched = 0;
    const fake: Notifier = {
      channelName: 'fake',
      initialize: async () => {},
      shutdown: async () => {},
      notifyQuotaAlert: async () => ({ delivered: true, results: {} }),
      notifyDispatchStatus: async () => {
        dispatched += 1;
      },
      notifyInfo: async () => ({ delivered: true, results: {} }),
    };
    const composite = new CompositeNotifier([fake], undefined, {
      notificationTypes: { ...DEFAULT_NOTIFICATION_TYPES, dispatch: false },
    });

    await composite.notifyDispatchStatus({ status: 'completed', taskId: 't1' });
    assert.equal(dispatched, 0);
  });
});
