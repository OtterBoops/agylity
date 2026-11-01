import {
  faChevronDown,
  faChevronRight,
  faLink,
  faRobot,
  faTerminal,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import { useState, useEffect, useMemo } from 'preact/hooks';
import type { ConfigData, ToastState } from '../types';
import { updateConfig, testNotification, deleteConfigOverride } from '../api';
import { Icon } from '../components/Icon';
import { DiscordChannelForm } from '../components/DiscordChannelForm';
import { WebhookChannelForm } from '../components/WebhookChannelForm';
import { ConsoleChannelForm } from '../components/ConsoleChannelForm';

interface NotificationsViewProps {
  config: ConfigData;
  onSaved: () => void;
}

export type ChannelId = 'discord' | 'webhook' | 'console';

interface ChannelDef {
  id: ChannelId;
  label: string;
  description: string;
  icon: IconDefinition;
  iconColor: string;
}

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
  if (Array.isArray(resolved.notificationChannels) && resolved.notificationChannels.length > 0) {
    return resolved.notificationChannels
      .map((c) => String(c).trim().toLowerCase() as ChannelId)
      .filter((c): c is ChannelId => c === 'discord' || c === 'webhook' || c === 'console');
  }
  if (
    typeof resolved.notificationChannel === 'string' &&
    resolved.notificationChannel.trim() &&
    resolved.notificationChannel.trim().toLowerCase() !== 'none'
  ) {
    const single = resolved.notificationChannel.trim().toLowerCase() as ChannelId;
    if (single === 'discord' || single === 'webhook' || single === 'console') {
      return [single];
    }
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
    setWebhookUrl('');
    setWebhookSecret('');
    setToast(null);
  };

  const handleSave = async (e?: Event) => {
    if (e) e.preventDefault();
    setIsSaving(true);
    setToast(null);

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
        await deleteConfigOverride('discordNotificationChannelId');
      } else {
        payload.discordNotificationChannelId = discordChannelId.trim();
      }
    }
    if (discordClientId !== serverDiscordClientId) {
      if (discordClientId.trim() === '' && config.overrides?.discordClientId !== undefined) {
        await deleteConfigOverride('discordClientId');
      } else {
        payload.discordClientId = discordClientId.trim();
      }
    }
    if (discordGuildId !== serverDiscordGuildId) {
      if (discordGuildId.trim() === '' && config.overrides?.discordGuildId !== undefined) {
        await deleteConfigOverride('discordGuildId');
      } else {
        payload.discordGuildId = discordGuildId.trim();
      }
    }
    if (discordOwnerUserId !== serverDiscordOwnerUserId) {
      if (discordOwnerUserId.trim() === '' && config.overrides?.discordOwnerUserId !== undefined) {
        await deleteConfigOverride('discordOwnerUserId');
      } else {
        payload.discordOwnerUserId = discordOwnerUserId.trim();
      }
    }
    if (discordPingOwner !== serverDiscordPingOwner) {
      payload.discordPingOwner = discordPingOwner;
    }

    if (webhookUrl.trim() && webhookUrl.trim() !== '••••••••' && webhookUrl.trim() !== '********') {
      payload.notificationWebhookUrl = webhookUrl.trim();
    }
    if (webhookSecret.trim()) {
      payload.webhookSecret = webhookSecret.trim();
    }

    try {
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
    <div class="flex flex-col gap-6">
      {/* Page Header */}
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <h2 class="text-xl font-semibold text-pine-text">Notification Destinations</h2>
          {enabledChannels.length === 0 && (
            <span class="rounded-md bg-pine-overlay px-2 py-0.5 text-[11px] font-medium text-pine-muted">
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

        {/* Vertically Stacked Notification Channel Cards with Independent Toggles */}
        {CHANNELS.map((ch) => {
          const isEnabled = enabledChannels.includes(ch.id);
          const isExpanded = expandedChannels[ch.id];

          return (
            <div
              key={ch.id}
              class={`overflow-hidden rounded-xl border transition-all ${
                isEnabled
                  ? 'border-pine-iris/50 bg-pine-surface shadow-xs'
                  : 'border-pine-highlight bg-pine-surface/50 hover:border-pine-iris/50'
              }`}
            >
              {/* Card Header Row: Expand trigger + Icon/Label + Badges + Toggle Switch */}
              <div class="flex items-center justify-between gap-4 p-4 select-none md:p-5">
                <div
                  class="flex min-w-0 flex-1 cursor-pointer items-center gap-3.5"
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleToggleExpand(ch.id);
                    }
                  }}
                  onClick={() => handleToggleExpand(ch.id)}
                >
                  <span
                    class="text-pine-muted transition-colors hover:text-pine-text"
                    aria-hidden="true"
                  >
                    <Icon icon={isExpanded ? faChevronDown : faChevronRight} class="size-3.5" />
                  </span>

                  <div class="flex min-w-0 items-center gap-3">
                    <Icon icon={ch.icon} class={`size-4 shrink-0 ${ch.iconColor}`} />
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="text-sm font-semibold text-pine-text">{ch.label}</span>
                        {isEnabled ? (
                          <span class="rounded-sm bg-pine-iris/15 px-2 py-0.5 text-xs font-semibold text-pine-iris uppercase">
                            Enabled
                          </span>
                        ) : (
                          <span class="rounded-sm bg-pine-overlay px-2 py-0.5 text-xs font-medium text-pine-muted uppercase">
                            Off
                          </span>
                        )}
                      </div>
                      <p class="text-xs text-pine-muted">{ch.description}</p>
                    </div>
                  </div>
                </div>

                {/* Right-aligned Toggle Switch */}
                <div class="flex shrink-0 items-center gap-3">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isEnabled}
                    onClick={() => handleToggleChannel(ch.id)}
                    class={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                      isEnabled ? 'bg-pine-iris' : 'border-pine-highlight bg-pine-overlay'
                    }`}
                    title={isEnabled ? `Disable ${ch.label}` : `Enable ${ch.label}`}
                  >
                    <span
                      aria-hidden="true"
                      class={`pointer-events-none inline-block size-5 transform rounded-full bg-white shadow-xs ring-0 transition duration-200 ease-in-out ${
                        isEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>

              {/* Nested Config Section: Expanded configuration */}
              {isExpanded && (
                <div class="border-t border-pine-highlight bg-pine-overlay/20 p-4 md:p-6">
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
                </div>
              )}
            </div>
          );
        })}

        {/* Bottom Action Bar */}
        <div class="mt-2 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-pine-highlight bg-pine-surface p-4 shadow-sm">
          <div>
            {isDirty ? (
              <span class="text-xs font-medium text-pine-gold">Unsaved changes</span>
            ) : (
              <span class="text-xs text-pine-muted">Settings saved</span>
            )}
          </div>

          <div class="flex items-center gap-3">
            <button
              type="button"
              onClick={handleReset}
              disabled={!isDirty || isSaving}
              class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-4 py-2 text-xs font-medium text-pine-subtle transition-colors hover:text-pine-text disabled:cursor-not-allowed disabled:opacity-40"
            >
              Reset
            </button>

            <button
              type="submit"
              disabled={!isDirty || isSaving}
              class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-xs font-semibold text-pine-base shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving ? 'Saving...' : 'Save changes'}
            </button>
          </div>
        </div>

        {toast && (
          <div
            class={`rounded-lg border p-3 text-xs font-medium ${
              toast.type === 'success'
                ? 'border-pine-pine bg-pine-pine/20 text-pine-foam'
                : 'border-pine-love bg-pine-love/20 text-pine-love'
            }`}
          >
            {toast.message}
          </div>
        )}
      </form>
    </div>
  );
};
