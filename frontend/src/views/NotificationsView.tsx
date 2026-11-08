import { faLink, faRobot, faTerminal } from '@fortawesome/free-solid-svg-icons';
import { useState, useEffect, useMemo } from 'preact/hooks';
import type { ConfigData, ToastState } from '../types';
import { updateConfig, testNotification, deleteConfigOverride } from '../api';
import { DiscordChannelForm } from '../components/DiscordChannelForm';
import { WebhookChannelForm } from '../components/WebhookChannelForm';
import { ConsoleChannelForm } from '../components/ConsoleChannelForm';
import {
  NotificationChannelCard,
  type ChannelDef,
  type ChannelId,
} from '../components/NotificationChannelCard';
import { NotificationActionBar } from '../components/NotificationActionBar';
import { SettingsLayout } from '../components/SettingsLayout';
import { StatusBanner } from '../components/StatusBanner';

interface NotificationsViewProps {
  config: ConfigData;
  onSaved: () => void;
}

export type { ChannelId };

const CHANNELS: ChannelDef[] = [
  {
    id: 'discord',
    label: 'Discord Bot',
    description: 'Slash commands and rich alert embeds.',
    icon: faRobot,
    iconColor: 'text-pine-iris',
  },
  {
    id: 'webhook',
    label: 'Generic Webhook',
    description: 'HTTP POST milestone payloads with optional HMAC-SHA256 signatures.',
    icon: faLink,
    iconColor: 'text-pine-foam',
  },
  {
    id: 'console',
    label: 'Local Console',
    description: 'Milestone summaries emitted to stdout and Live Logs.',
    icon: faTerminal,
    iconColor: 'text-pine-gold',
  },
];

const getInitialChannels = (resolved: Record<string, unknown>): ChannelId[] => {
  if (Array.isArray(resolved.notificationChannels)) {
    return resolved.notificationChannels
      .map((c) => String(c).trim().toLowerCase() as ChannelId)
      .filter((c): c is ChannelId => c === 'discord' || c === 'webhook' || c === 'console');
  }
  return [];
};

export const NotificationsView = ({ config, onSaved }: NotificationsViewProps) => {
  const resolved = config.resolved || {};

  const serverChannels = useMemo(() => getInitialChannels(resolved), [resolved]);
  const serverDiscordChannelId = useMemo(
    () => String(resolved.discordNotificationChannelId || ''),
    [resolved.discordNotificationChannelId]
  );
  const serverDiscordClientId = useMemo(
    () => String(resolved.discordClientId || ''),
    [resolved.discordClientId]
  );
  const serverDiscordGuildId = useMemo(
    () => String(resolved.discordGuildId || ''),
    [resolved.discordGuildId]
  );
  const serverDiscordOwnerUserId = useMemo(
    () => String(resolved.discordOwnerUserId || ''),
    [resolved.discordOwnerUserId]
  );
  const serverDiscordPingOwner = useMemo(
    () => resolved.discordPingOwner !== false,
    [resolved.discordPingOwner]
  );
  const serverBaseUrl = useMemo(() => String(resolved.baseUrl || ''), [resolved.baseUrl]);

  const isDiscordTokenSet = Boolean(
    config.secretsMeta?.discordToken?.isSet ?? Boolean(resolved.discordToken)
  );
  const isWebhookConfigured = Boolean(
    config.secretsMeta?.notificationWebhookUrl?.isSet ?? Boolean(resolved.notificationWebhookUrl)
  );
  const isWebhookSecretSet = Boolean(
    config.secretsMeta?.webhookSecret?.isSet ?? Boolean(resolved.webhookSecret)
  );

  // Enabled channels set (multi-channel toggle state)
  const [enabledChannels, setEnabledChannels] = useState<ChannelId[]>(serverChannels);

  // Expanded panel state per channel
  const [expandedChannels, setExpandedChannels] = useState<Record<ChannelId, boolean>>(() => {
    const initial: Record<ChannelId, boolean> = {
      discord: false,
      webhook: false,
      console: false,
    };
    if (serverChannels.length > 0) {
      for (const ch of serverChannels) {
        initial[ch] = true;
      }
    } else {
      initial.discord = true;
    }
    return initial;
  });

  // Persistent credential fields
  const [discordToken, setDiscordToken] = useState('');
  const [discordChannelId, setDiscordChannelId] = useState(serverDiscordChannelId);
  const [discordClientId, setDiscordClientId] = useState(serverDiscordClientId);
  const [discordGuildId, setDiscordGuildId] = useState(serverDiscordGuildId);
  const [discordOwnerUserId, setDiscordOwnerUserId] = useState(serverDiscordOwnerUserId);
  const [discordPingOwner, setDiscordPingOwner] = useState(serverDiscordPingOwner);

  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');

  // Shared by every channel: the origin embed links point at.
  const [baseUrl, setBaseUrl] = useState(serverBaseUrl);

  const [toast, setToast] = useState<ToastState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [testingChannel, setTestingChannel] = useState<string | null>(null);
  const [testDiagnostics, setTestDiagnostics] = useState<{
    channel: ChannelId;
    success: boolean;
    message: string;
    timestamp: string;
  } | null>(null);

  // Synchronize when server config updates
  useEffect(() => {
    setEnabledChannels(serverChannels);
    setDiscordChannelId(serverDiscordChannelId);
    setDiscordClientId(serverDiscordClientId);
    setDiscordGuildId(serverDiscordGuildId);
    setDiscordOwnerUserId(serverDiscordOwnerUserId);
    setDiscordPingOwner(serverDiscordPingOwner);
    setBaseUrl(serverBaseUrl);
    setWebhookUrl('');
    setDiscordToken('');
    setWebhookSecret('');
  }, [
    serverChannels,
    serverDiscordChannelId,
    serverDiscordClientId,
    serverDiscordGuildId,
    serverDiscordOwnerUserId,
    serverDiscordPingOwner,
    serverBaseUrl,
  ]);

  const ensureChannelEnabled = (id: ChannelId) => {
    setEnabledChannels((prev) => {
      if (prev.includes(id)) return prev;
      return [...prev, id];
    });
    setExpandedChannels((prev) => {
      if (prev[id]) return prev;
      return { ...prev, [id]: true };
    });
  };

  const handleToggleChannel = (id: ChannelId) => {
    setEnabledChannels((prev) => {
      const isCurrentlyEnabled = prev.includes(id);
      const next = isCurrentlyEnabled ? prev.filter((c) => c !== id) : [...prev, id];
      setExpandedChannels((exp) => ({ ...exp, [id]: !isCurrentlyEnabled }));
      return next;
    });
  };

  const handleToggleExpand = (id: ChannelId) => {
    setExpandedChannels((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const allExpanded = useMemo(
    () => CHANNELS.every((ch) => expandedChannels[ch.id]),
    [expandedChannels]
  );

  const handleToggleAllExpanded = () => {
    const nextState = !allExpanded;
    setExpandedChannels({
      discord: nextState,
      webhook: nextState,
      console: nextState,
    });
  };

  const isChannelsDirty = useMemo(() => {
    if (enabledChannels.length !== serverChannels.length) return true;
    const sortedEnabled = [...enabledChannels].sort();
    const sortedServer = [...serverChannels].sort();
    return sortedEnabled.some((ch, i) => ch !== sortedServer[i]);
  }, [enabledChannels, serverChannels]);

  const isDirty = useMemo(() => {
    if (isChannelsDirty) return true;
    if (discordToken.trim().length > 0) return true;
    if (discordChannelId !== serverDiscordChannelId) return true;
    if (discordClientId !== serverDiscordClientId) return true;
    if (discordGuildId !== serverDiscordGuildId) return true;
    if (discordOwnerUserId !== serverDiscordOwnerUserId) return true;
    if (discordPingOwner !== serverDiscordPingOwner) return true;
    if (baseUrl.trim() !== serverBaseUrl) return true;
    if (webhookUrl.trim().length > 0) return true;
    if (webhookSecret.trim().length > 0) return true;
    return false;
  }, [
    isChannelsDirty,
    discordToken,
    discordChannelId,
    serverDiscordChannelId,
    discordClientId,
    serverDiscordClientId,
    discordGuildId,
    serverDiscordGuildId,
    discordOwnerUserId,
    serverDiscordOwnerUserId,
    discordPingOwner,
    serverDiscordPingOwner,
    baseUrl,
    serverBaseUrl,
    webhookUrl,
    webhookSecret,
  ]);

  const handleReset = () => {
    setEnabledChannels(serverChannels);
    setDiscordToken('');
    setDiscordChannelId(serverDiscordChannelId);
    setDiscordClientId(serverDiscordClientId);
    setDiscordGuildId(serverDiscordGuildId);
    setDiscordOwnerUserId(serverDiscordOwnerUserId);
    setDiscordPingOwner(serverDiscordPingOwner);
    setBaseUrl(serverBaseUrl);
    setWebhookUrl('');
    setWebhookSecret('');
    setToast(null);
  };

  const handleSave = async (e?: Event) => {
    if (e) e.preventDefault();
    setIsSaving(true);
    setToast(null);

    const overrideDeletes: string[] = [];
    const channelsList = [...enabledChannels];
    const payload: Record<string, unknown> = {
      notificationChannels: channelsList,
      notificationChannel: channelsList[0] ?? 'none',
    };

    if (discordToken.trim()) payload.discordToken = discordToken.trim();
    if (discordChannelId !== serverDiscordChannelId) {
      if (
        discordChannelId.trim() === '' &&
        config.overrides?.discordNotificationChannelId !== undefined
      ) {
        overrideDeletes.push('discordNotificationChannelId');
      } else {
        payload.discordNotificationChannelId = discordChannelId.trim();
      }
    }
    if (discordClientId !== serverDiscordClientId) {
      if (discordClientId.trim() === '' && config.overrides?.discordClientId !== undefined) {
        overrideDeletes.push('discordClientId');
      } else {
        payload.discordClientId = discordClientId.trim();
      }
    }
    if (discordGuildId !== serverDiscordGuildId) {
      if (discordGuildId.trim() === '' && config.overrides?.discordGuildId !== undefined) {
        overrideDeletes.push('discordGuildId');
      } else {
        payload.discordGuildId = discordGuildId.trim();
      }
    }
    if (discordOwnerUserId !== serverDiscordOwnerUserId) {
      if (discordOwnerUserId.trim() === '' && config.overrides?.discordOwnerUserId !== undefined) {
        overrideDeletes.push('discordOwnerUserId');
      } else {
        payload.discordOwnerUserId = discordOwnerUserId.trim();
      }
    }
    if (discordPingOwner !== serverDiscordPingOwner) {
      payload.discordPingOwner = discordPingOwner;
    }

    if (baseUrl.trim() !== serverBaseUrl) {
      if (baseUrl.trim() === '' && config.overrides?.baseUrl !== undefined) {
        overrideDeletes.push('baseUrl');
      } else {
        payload.baseUrl = baseUrl.trim();
      }
    }

    if (webhookUrl.trim() && webhookUrl.trim() !== '••••••••' && webhookUrl.trim() !== '********') {
      payload.notificationWebhookUrl = webhookUrl.trim();
    }
    if (webhookSecret.trim()) {
      payload.webhookSecret = webhookSecret.trim();
    }

    try {
      for (const key of overrideDeletes) {
        await deleteConfigOverride(key);
      }
      await updateConfig(payload);
      setToast({
        type: 'success',
        message:
          channelsList.length === 0
            ? 'Silent Sentry mode enabled (all push destinations turned off).'
            : `Notification channels updated (${channelsList.length} active)!`,
      });
      setDiscordToken('');
      setWebhookUrl('');
      setWebhookSecret('');
      onSaved();
    } catch (err: any) {
      setToast({
        type: 'error',
        message: err?.message || 'Failed to save configuration',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSendTest = (channel: ChannelId) => {
    setTestingChannel(channel);
    setToast(null);

    const overrides: Record<string, unknown> = {};
    if (baseUrl.trim() !== serverBaseUrl) {
      overrides.baseUrl = baseUrl.trim();
    }
    if (channel === 'webhook') {
      if (
        webhookUrl.trim() &&
        webhookUrl.trim() !== '••••••••' &&
        webhookUrl.trim() !== '********'
      ) {
        overrides.notificationWebhookUrl = webhookUrl.trim();
      }
      if (webhookSecret.trim()) {
        overrides.webhookSecret = webhookSecret.trim();
      }
      if (discordOwnerUserId.trim() !== serverDiscordOwnerUserId) {
        overrides.discordOwnerUserId = discordOwnerUserId.trim();
      }
      if (discordPingOwner !== serverDiscordPingOwner) {
        overrides.discordPingOwner = discordPingOwner;
      }
    } else if (channel === 'discord') {
      if (discordToken.trim()) {
        overrides.discordToken = discordToken.trim();
      }
      if (discordChannelId.trim() !== serverDiscordChannelId) {
        overrides.discordNotificationChannelId = discordChannelId.trim();
      }
      if (discordOwnerUserId.trim() !== serverDiscordOwnerUserId) {
        overrides.discordOwnerUserId = discordOwnerUserId.trim();
      }
      if (discordPingOwner !== serverDiscordPingOwner) {
        overrides.discordPingOwner = discordPingOwner;
      }
    }

    testNotification(channel, overrides)
      .then((data) => {
        setToast({
          type: 'success',
          message: data.message || `Test ${channel} notification dispatched successfully!`,
        });
        setTestDiagnostics({
          channel,
          success: true,
          message: data.message || 'Notification delivered successfully (HTTP 200 OK)',
          timestamp: new Date().toLocaleTimeString(),
        });
      })
      .catch((err) => {
        setToast({
          type: 'error',
          message: err.message || `Test ${channel} notification delivery failed.`,
        });
        setTestDiagnostics({
          channel,
          success: false,
          message: err.message || 'Delivery failed or target unreachable',
          timestamp: new Date().toLocaleTimeString(),
        });
      })
      .finally(() => setTestingChannel(null));
  };

  const handleClearWebhook = async () => {
    try {
      await deleteConfigOverride('notificationWebhookUrl');
      await deleteConfigOverride('webhookUrl');
      setToast({
        type: 'success',
        message: 'Saved webhook URL override removed successfully.',
      });
      setWebhookUrl('');
      onSaved();
    } catch (err: any) {
      setToast({
        type: 'error',
        message: err?.message || 'Failed to clear webhook URL override',
      });
    }
  };

  const handleClearWebhookSecret = async () => {
    try {
      await deleteConfigOverride('webhookSecret');
      setToast({
        type: 'success',
        message: 'Saved HMAC secret key override removed successfully.',
      });
      setWebhookSecret('');
      onSaved();
    } catch (err: any) {
      setToast({
        type: 'error',
        message: err?.message || 'Failed to clear HMAC secret key override',
      });
    }
  };

  const handleClearDiscordToken = async () => {
    try {
      await deleteConfigOverride('discordToken');
      setToast({
        type: 'success',
        message: 'Saved Discord Bot Token override removed successfully.',
      });
      setDiscordToken('');
      onSaved();
    } catch (err: any) {
      setToast({
        type: 'error',
        message: err?.message || 'Failed to clear Discord Bot Token override',
      });
    }
  };

  return (
    <SettingsLayout
      activeTab="notifications"
      coordinatorEnabled={Boolean(config.resolved?.coordinatorEnabled)}
    >
      {/* Page Header */}
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <h2 class="text-xl font-semibold text-pine-text">Notification Destinations</h2>
          {enabledChannels.length === 0 && (
            <span class="rounded-md bg-pine-overlay px-2 py-0.5 text-xs font-medium text-pine-subtle">
              Alerts muted
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleToggleAllExpanded}
          class="cursor-pointer text-xs font-medium text-pine-subtle transition-colors hover:text-pine-text"
        >
          {allExpanded ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      <form onSubmit={handleSave} autoComplete="off" class="flex flex-col gap-4">
        {/* Invisible dummy inputs preventing browser autofill heuristics from attaching to credentials */}
        <input
          type="text"
          style={{ display: 'none' }}
          tabIndex={-1}
          aria-hidden="true"
          autoComplete="off"
        />
        <input
          type="password"
          style={{ display: 'none' }}
          tabIndex={-1}
          aria-hidden="true"
          autoComplete="off"
        />

        {/* Link target shared by every channel, so it sits above the channel cards */}
        <div class="flex flex-col gap-1.5 rounded-xl border border-pine-highlight bg-pine-overlay/40 p-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <label
              for="agylity-base-url"
              class="text-xs font-semibold tracking-wider text-pine-text uppercase"
            >
              Embed Link Base URL
            </label>
            <span class="text-xs text-pine-subtle">Optional</span>
          </div>
          <input
            id="agylity-base-url"
            type="url"
            autoComplete="off"
            name="agylity_base_url"
            class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text placeholder-pine-subtle transition-colors outline-none focus:border-pine-iris"
            placeholder="https://agylity.example.com"
            value={baseUrl}
            onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
          />
          <span class="text-xs text-pine-subtle">
            When set, embed titles link to this dashboard: the task inspector for dispatch status,
            the quota overview for alerts.
          </span>
        </div>

        {/* Vertically Stacked Notification Channel Cards with Independent Toggles */}
        {CHANNELS.map((ch) => {
          const isEnabled = enabledChannels.includes(ch.id);
          const isExpanded = expandedChannels[ch.id];

          return (
            <NotificationChannelCard
              key={ch.id}
              channel={ch}
              isEnabled={isEnabled}
              isExpanded={isExpanded}
              onToggleExpand={() => handleToggleExpand(ch.id)}
              onToggleChannel={() => handleToggleChannel(ch.id)}
            >
              {ch.id === 'discord' && (
                <DiscordChannelForm
                  token={discordToken}
                  onTokenChange={(val) => {
                    setDiscordToken(val);
                    if (val.length > 0) ensureChannelEnabled('discord');
                  }}
                  isTokenSet={isDiscordTokenSet}
                  onClearToken={handleClearDiscordToken}
                  clientId={discordClientId}
                  onClientIdChange={(val) => {
                    setDiscordClientId(val);
                    if (val.length > 0) ensureChannelEnabled('discord');
                  }}
                  channelId={discordChannelId}
                  onChannelIdChange={(val) => {
                    setDiscordChannelId(val);
                    if (val.length > 0) ensureChannelEnabled('discord');
                  }}
                  guildId={discordGuildId}
                  onGuildIdChange={(val) => {
                    setDiscordGuildId(val);
                    if (val.length > 0) ensureChannelEnabled('discord');
                  }}
                  ownerUserId={discordOwnerUserId}
                  onOwnerUserIdChange={(val) => {
                    setDiscordOwnerUserId(val);
                    if (val.length > 0) ensureChannelEnabled('discord');
                  }}
                  pingOwner={discordPingOwner}
                  onPingOwnerChange={setDiscordPingOwner}
                  onSendTest={() => handleSendTest('discord')}
                  isTesting={testingChannel === 'discord'}
                  diagnostics={testDiagnostics?.channel === 'discord' ? testDiagnostics : null}
                />
              )}

              {ch.id === 'webhook' && (
                <WebhookChannelForm
                  url={webhookUrl}
                  onUrlChange={(val) => {
                    setWebhookUrl(val);
                    if (val.length > 0) ensureChannelEnabled('webhook');
                  }}
                  isUrlSet={isWebhookConfigured}
                  onClearUrl={handleClearWebhook}
                  secret={webhookSecret}
                  onSecretChange={(val) => {
                    setWebhookSecret(val);
                    if (val.length > 0) ensureChannelEnabled('webhook');
                  }}
                  isSecretSet={isWebhookSecretSet}
                  onClearSecret={handleClearWebhookSecret}
                  onSendTest={() => handleSendTest('webhook')}
                  isTesting={testingChannel === 'webhook'}
                  diagnostics={testDiagnostics?.channel === 'webhook' ? testDiagnostics : null}
                />
              )}

              {ch.id === 'console' && (
                <ConsoleChannelForm
                  onSendTest={() => handleSendTest('console')}
                  isTesting={testingChannel === 'console'}
                />
              )}
            </NotificationChannelCard>
          );
        })}

        {/* Bottom Action Bar */}
        <NotificationActionBar isDirty={isDirty} isSaving={isSaving} onReset={handleReset} />

        {toast && <StatusBanner status={toast} />}
      </form>
    </SettingsLayout>
  );
};
