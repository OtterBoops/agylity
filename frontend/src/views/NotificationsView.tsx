import { faLink, faRobot, type IconDefinition } from '@fortawesome/free-solid-svg-icons';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ConfigData, NotificationDestination, NotificationDestinationType } from '../types';
import { pushErrorToast, pushSuccessToast } from '../state/toastStore';
import { testDestination, updateConfig } from '../api';
import { DiscordChannelForm } from '../components/DiscordChannelForm';
import { NotificationActionBar } from '../components/NotificationActionBar';
import { NotificationChannelCard } from '../components/NotificationChannelCard';
import { SettingsLayout } from '../components/SettingsLayout';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { WebhookChannelForm } from '../components/WebhookChannelForm';
import {
  DEFAULT_NOTIFICATION_TYPES,
  NOTIFICATION_KINDS,
} from '../../../src/shared/notificationKinds.ts';

interface NotificationsViewProps {
  config: ConfigData;
  onSaved: () => void;
}

const SECRET_MASK = '••••••••';

const TYPE_META: Record<
  NotificationDestinationType,
  { label: string; icon: IconDefinition; iconColor: string }
> = {
  discord: { label: 'Discord', icon: faRobot, iconColor: 'text-pine-iris' },
  webhook: { label: 'Webhook', icon: faLink, iconColor: 'text-pine-foam' },
};

const randomSuffix = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);

const newDestination = (type: NotificationDestinationType): NotificationDestination => ({
  id: `${type}-${randomSuffix()}`,
  type,
  label: type === 'discord' ? 'Discord Bot' : 'Webhook',
  enabled: true,
  pingOwner: true,
  config: {},
});

const normalizeConfig = (config: Record<string, unknown> | undefined): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(config ?? {}).map(([key, value]) => [
      key,
      typeof value === 'string' || value == null ? (value ?? '') : String(value),
    ])
  );

const normalizeDestination = (raw: any): NotificationDestination => ({
  id: String(raw?.id ?? ''),
  type: raw?.type === 'webhook' ? 'webhook' : 'discord',
  label: String(raw?.label ?? ''),
  enabled: raw?.enabled !== false,
  pingOwner: raw?.pingOwner !== false,
  config: normalizeConfig(raw?.config),
});

const stringField = (destination: NotificationDestination, field: string): string =>
  String(destination.config[field] ?? '');

const isMask = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed === SECRET_MASK || trimmed === '********';
};

// The backend parses this string as a flat header map, so a typo has to fail here, not on delivery.
const customHeadersError = (destination: NotificationDestination): string | null => {
  if (destination.type !== 'webhook') return null;
  const raw = stringField(destination, 'customHeaders').trim();
  if (raw === '' || isMask(raw)) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'Custom headers must be a JSON object';
    }
    return null;
  } catch {
    return 'Custom headers must be valid JSON';
  }
};

export const NotificationsView = ({ config, onSaved }: NotificationsViewProps) => {
  const serverDestinations = useMemo<NotificationDestination[]>(() => {
    const raw = config.resolved?.destinations;
    return Array.isArray(raw) ? raw.map(normalizeDestination) : [];
  }, [config.resolved?.destinations]);
  const serverSignature = JSON.stringify(serverDestinations);

  const serverTypes = useMemo<Record<string, boolean>>(
    () => ({ ...DEFAULT_NOTIFICATION_TYPES, ...(config.resolved?.notificationTypes ?? {}) }),
    [config.resolved?.notificationTypes]
  );
  const typesSignature = JSON.stringify(serverTypes);

  const [draft, setDraft] = useState<NotificationDestination[]>(serverDestinations);
  const [baseline, setBaseline] = useState<NotificationDestination[]>(serverDestinations);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<
    Record<string, { success: boolean; message: string } | null>
  >({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [types, setTypes] = useState<Record<string, boolean>>(serverTypes);
  const [pendingKind, setPendingKind] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;

  // A refresh triggered by an unrelated save must not overwrite edits the user has not saved yet.
  useEffect(() => {
    if (dirtyRef.current) return;
    setDraft(serverDestinations);
    setBaseline(serverDestinations);
  }, [serverSignature]);

  useEffect(() => {
    setTypes(serverTypes);
  }, [typesSignature]);

  const updateDestination = (id: string, patch: Partial<NotificationDestination>) =>
    setDraft((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));

  const updateConfigField = (id: string, field: string, value: string) =>
    setDraft((prev) =>
      prev.map((entry) =>
        entry.id === id ? { ...entry, config: { ...entry.config, [field]: value } } : entry
      )
    );

  const handleToggleKind = async (kind: string, next: boolean) => {
    const previous = types;
    const label = NOTIFICATION_KINDS.find((entry) => entry.kind === kind)?.label ?? kind;
    setTypes({ ...previous, [kind]: next });
    setPendingKind(kind);
    try {
      await updateConfig({ notificationTypes: { ...previous, [kind]: next } });
      pushSuccessToast(
        next ? 'Notification type enabled' : 'Notification type muted',
        next ? `${label} will be delivered.` : `${label} is recorded without delivery.`
      );
      onSaved();
    } catch (err: any) {
      setTypes(previous);
      pushErrorToast(
        'Could not update notification types',
        err?.message || 'Failed to save the notification type'
      );
    } finally {
      setPendingKind(null);
    }
  };

  const handleAdd = (type: NotificationDestinationType) => {
    const destination = newDestination(type);
    setDraft((prev) => [...prev, destination]);
    setExpanded((prev) => ({ ...prev, [destination.id]: true }));
  };

  const handleRemove = (id: string) => {
    setDraft((prev) => prev.filter((entry) => entry.id !== id));
    setTestResults((prev) => {
      if (!Object.hasOwn(prev, id)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleReset = () => {
    setDraft(baseline);
    setTestResults({});
  };

  const handleSaveDestinations = async (e: Event) => {
    e.preventDefault();
    if (!isDirty) return;

    const problem = draft.map(customHeadersError).find((message) => message !== null);
    if (problem) {
      pushErrorToast('Could not save notification destinations', problem);
      return;
    }

    setIsSaving(true);
    try {
      await updateConfig({ destinations: draft });
      setBaseline(draft);
      pushSuccessToast(
        'Notification destinations saved',
        `${draft.length} destination${draft.length === 1 ? '' : 's'} configured.`
      );
      onSaved();
    } catch (err: any) {
      pushErrorToast(
        'Could not save notification destinations',
        err?.message || 'Failed to save notification destinations'
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleTest = async (destination: NotificationDestination) => {
    const problem = customHeadersError(destination);
    if (problem) {
      setTestResults((prev) => ({
        ...prev,
        [destination.id]: { success: false, message: problem },
      }));
      pushErrorToast('Test notification failed', problem);
      return;
    }

    // An existing instance with unsaved edits is a draft: test what the user is looking at.
    const baselineEntry = baseline.find((entry) => entry.id === destination.id);
    const edited =
      Boolean(baselineEntry) && JSON.stringify(destination) !== JSON.stringify(baselineEntry);
    setTestingId(destination.id);
    setTestResults((prev) => ({ ...prev, [destination.id]: null }));
    try {
      const result =
        baselineEntry && !edited
          ? await testDestination({ destinationId: destination.id })
          : await testDestination({ destination });
      setTestResults((prev) => ({
        ...prev,
        [destination.id]: { success: true, message: result.message },
      }));
      pushSuccessToast('Test notification sent', result.message);
    } catch (err: any) {
      const message = err?.message || 'Delivery failed or target unreachable';
      setTestResults((prev) => ({ ...prev, [destination.id]: { success: false, message } }));
      pushErrorToast('Test notification failed', message);
    } finally {
      setTestingId(null);
    }
  };

  const ownerUserId = String(config.resolved?.discordOwnerUserId ?? '');

  return (
    <SettingsLayout>
      <section class="flex flex-col gap-3">
        <div>
          <h2 class="text-base font-bold text-pine-text">What to send</h2>
          <p class="mt-0.5 text-xs text-pine-subtle">
            A muted type is still recorded in the delivery history, just never pushed.
          </p>
        </div>

        <div class="overflow-hidden rounded-xl border border-pine-highlight bg-pine-surface">
          {NOTIFICATION_KINDS.map((entry) => {
            const enabled = types[entry.kind] !== false;
            return (
              <div
                key={entry.kind}
                class="flex items-center justify-between gap-4 border-t border-pine-highlight p-4 first:border-t-0"
              >
                <div class="min-w-0">
                  <h3 class="text-sm font-semibold text-pine-text">{entry.label}</h3>
                  <p class="text-xs text-pine-subtle">{entry.description}</p>
                </div>
                <ToggleSwitch
                  checked={enabled}
                  disabled={pendingKind === entry.kind}
                  onChange={(next) => void handleToggleKind(entry.kind, next)}
                  label={`${entry.label} notifications`}
                />
              </div>
            );
          })}
        </div>
      </section>

      <form onSubmit={handleSaveDestinations} autoComplete="off" class="flex flex-col gap-4">
        <div class="flex flex-wrap items-end justify-between gap-3">
          <div class="min-w-0">
            <h2 class="text-base font-bold text-pine-text">Where to send</h2>
            <p class="mt-0.5 text-xs text-pine-subtle">
              Every enabled destination receives each event independently.
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => handleAdd('discord')}
              class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-medium text-pine-text transition-colors hover:border-pine-iris"
            >
              Add Discord
            </button>
            <button
              type="button"
              onClick={() => handleAdd('webhook')}
              class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-medium text-pine-text transition-colors hover:border-pine-iris"
            >
              Add Webhook
            </button>
          </div>
        </div>

        {draft.length === 0 ? (
          <div class="rounded-xl border border-dashed border-pine-highlight bg-pine-surface/50 p-6 text-center text-xs text-pine-subtle">
            No destinations configured. Alerts are recorded but never delivered.
          </div>
        ) : (
          draft.map((destination) => {
            const meta = config.destinationsMeta?.[destination.id] ?? {};
            const typeMeta = TYPE_META[destination.type];
            return (
              <NotificationChannelCard
                key={destination.id}
                destination={destination}
                typeLabel={typeMeta.label}
                icon={typeMeta.icon}
                iconColor={typeMeta.iconColor}
                isExpanded={expanded[destination.id] !== false}
                onToggleExpand={() =>
                  setExpanded((prev) => ({
                    ...prev,
                    [destination.id]: prev[destination.id] === false,
                  }))
                }
                onLabelChange={(label) => updateDestination(destination.id, { label })}
                onToggleEnabled={() =>
                  updateDestination(destination.id, { enabled: !destination.enabled })
                }
                onTogglePingOwner={() =>
                  updateDestination(destination.id, { pingOwner: !destination.pingOwner })
                }
                onSendTest={() => void handleTest(destination)}
                isTesting={testingId === destination.id}
                onRemove={() => handleRemove(destination.id)}
                testResult={testResults[destination.id] ?? null}
              >
                {destination.type === 'discord' ? (
                  <DiscordChannelForm
                    destinationId={destination.id}
                    token={stringField(destination, 'token')}
                    onTokenChange={(value) => updateConfigField(destination.id, 'token', value)}
                    isTokenSet={Boolean(meta.token?.isSet)}
                    channelId={stringField(destination, 'channelId')}
                    onChannelIdChange={(value) =>
                      updateConfigField(destination.id, 'channelId', value)
                    }
                    clientId={stringField(destination, 'clientId')}
                    onClientIdChange={(value) =>
                      updateConfigField(destination.id, 'clientId', value)
                    }
                    guildId={stringField(destination, 'guildId')}
                    onGuildIdChange={(value) => updateConfigField(destination.id, 'guildId', value)}
                    ownerUserId={ownerUserId}
                    pingOwner={destination.pingOwner}
                  />
                ) : (
                  <WebhookChannelForm
                    destinationId={destination.id}
                    url={stringField(destination, 'url')}
                    onUrlChange={(value) => updateConfigField(destination.id, 'url', value)}
                    isUrlSet={Boolean(meta.url?.isSet)}
                    secret={stringField(destination, 'secret')}
                    onSecretChange={(value) => updateConfigField(destination.id, 'secret', value)}
                    isSecretSet={Boolean(meta.secret?.isSet)}
                    customHeaders={stringField(destination, 'customHeaders')}
                    onCustomHeadersChange={(value) =>
                      updateConfigField(destination.id, 'customHeaders', value)
                    }
                    isHeadersSet={Boolean(meta.customHeaders?.isSet)}
                    ownerUserId={ownerUserId}
                  />
                )}
              </NotificationChannelCard>
            );
          })
        )}

        <NotificationActionBar isDirty={isDirty} isSaving={isSaving} onReset={handleReset} />
      </form>
    </SettingsLayout>
  );
};
