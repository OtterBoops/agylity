import {
  faArrowUpRightFromSquare,
  faChevronDown,
  faChevronRight,
  faLink,
  faRobot,
  faTerminal,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import { useState, useEffect, useMemo } from 'preact/hooks';
import type { ConfigData, ToastState } from '../types';
import { updateConfig, testNotification } from '../api';
import { Icon } from '../components/Icon';

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
  const serverWebhookUrl = useMemo(
    () => String(resolved.notificationWebhookUrl || ''),
    [resolved.notificationWebhookUrl]
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
  const [showDiscordToken, setShowDiscordToken] = useState(false);

  const [webhookUrl, setWebhookUrl] = useState(serverWebhookUrl);
  const [webhookSecret, setWebhookSecret] = useState('');
  const [showWebhookSecret, setShowWebhookSecret] = useState(false);

  const [toast, setToast] = useState<ToastState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [testingChannel, setTestingChannel] = useState<string | null>(null);

  // Synchronize when server config updates
  useEffect(() => {
    setEnabledChannels(serverChannels);
    setDiscordChannelId(serverDiscordChannelId);
    setDiscordClientId(serverDiscordClientId);
    setDiscordGuildId(serverDiscordGuildId);
    setWebhookUrl(serverWebhookUrl);
    setDiscordToken('');
    setWebhookSecret('');
  }, [
    serverChannels,
    serverDiscordChannelId,
    serverDiscordClientId,
    serverDiscordGuildId,
    serverWebhookUrl,
  ]);

  const handleToggleChannel = (id: ChannelId) => {
    setEnabledChannels((prev) => {
      const isCurrentlyEnabled = prev.includes(id);
      const next = isCurrentlyEnabled ? prev.filter((c) => c !== id) : [...prev, id];
      if (!isCurrentlyEnabled) {
        setExpandedChannels((exp) => ({ ...exp, [id]: true }));
      }
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
    if (webhookUrl !== serverWebhookUrl) return true;
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
    webhookUrl,
    serverWebhookUrl,
    webhookSecret,
  ]);

  const handleReset = () => {
    setEnabledChannels(serverChannels);
    setDiscordToken('');
    setDiscordChannelId(serverDiscordChannelId);
    setDiscordClientId(serverDiscordClientId);
    setDiscordGuildId(serverDiscordGuildId);
    setWebhookUrl(serverWebhookUrl);
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
      payload.discordNotificationChannelId = discordChannelId.trim();
    }
    if (discordClientId !== serverDiscordClientId) {
      payload.discordClientId = discordClientId.trim();
    }
    if (discordGuildId !== serverDiscordGuildId) {
      payload.discordGuildId = discordGuildId.trim();
    }

    if (webhookUrl !== serverWebhookUrl) {
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

    testNotification(channel)
      .then((data) =>
        setToast({
          type: 'success',
          message: data.message || `Test ${channel} notification dispatched successfully!`,
        })
      )
      .catch((err) =>
        setToast({
          type: 'error',
          message: err.message || `Test ${channel} notification delivery failed.`,
        })
      )
      .finally(() => setTestingChannel(null));
  };

  const isDiscordTokenSet = Boolean(
    config.secretsMeta?.discordToken?.isSet ?? Boolean(resolved.discordToken)
  );
  const isWebhookConfigured = Boolean(
    config.secretsMeta?.notificationWebhookUrl?.isSet ??
    Boolean(webhookUrl || resolved.notificationWebhookUrl)
  );

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
                  : 'border-pine-highlight/50 bg-pine-surface/50 hover:border-pine-highlight'
              }`}
            >
              {/* Card Header Row: Expand trigger + Icon/Label + Badges + Toggle Switch */}
              <div class="flex items-center justify-between gap-4 p-4 select-none md:p-5">
                <div
                  class="flex min-w-0 flex-1 cursor-pointer items-center gap-3.5"
                  onClick={() => handleToggleExpand(ch.id)}
                >
                  <button
                    type="button"
                    class="cursor-pointer text-pine-muted transition-colors hover:text-pine-text"
                    aria-label={isExpanded ? `Collapse ${ch.label}` : `Expand ${ch.label}`}
                  >
                    <Icon icon={isExpanded ? faChevronDown : faChevronRight} class="size-3.5" />
                  </button>

                  <div class="flex min-w-0 items-center gap-3">
                    <Icon icon={ch.icon} class={`size-4 shrink-0 ${ch.iconColor}`} />
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="text-sm font-semibold text-pine-text">{ch.label}</span>
                        {isEnabled ? (
                          <span class="rounded bg-pine-iris/15 px-1.5 py-0.5 text-[10px] font-semibold text-pine-iris uppercase">
                            Enabled
                          </span>
                        ) : (
                          <span class="rounded bg-pine-overlay px-1.5 py-0.5 text-[10px] font-medium text-pine-muted uppercase">
                            Off
                          </span>
                        )}
                      </div>
                      <p class="truncate text-xs text-pine-muted">{ch.description}</p>
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
                      isEnabled ? 'bg-pine-iris' : 'border-pine-highlight/80 bg-pine-overlay'
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
                <div class="border-t border-pine-highlight/50 bg-pine-overlay/20 p-4 md:p-6">
                  {ch.id === 'discord' && (
                    <div class="flex flex-col gap-5">
                      <div class="flex items-center justify-between border-b border-pine-highlight/40 pb-3">
                        <span class="text-xs font-semibold text-pine-subtle">
                          Discord Bot Credentials
                        </span>
                        <button
                          type="button"
                          onClick={() => handleSendTest('discord')}
                          disabled={testingChannel !== null}
                          class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-medium text-pine-subtle transition-colors hover:text-pine-text disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {testingChannel === 'discord' ? 'Testing...' : 'Test Discord Ping'}
                        </button>
                      </div>

                      <div class="flex flex-col gap-1.5">
                        <label class="flex items-center justify-between text-xs font-medium text-pine-subtle">
                          <span class="flex items-center gap-1.5">
                            Bot Application Token
                            <span class="text-[10px] text-pine-foam">(Encrypted at rest)</span>
                          </span>
                          {isDiscordTokenSet && (
                            <span class="font-mono text-[10px] text-pine-foam">Configured</span>
                          )}
                        </label>
                        <div class="flex gap-2">
                          <input
                            type={showDiscordToken ? 'text' : 'password'}
                            name="agylity_discord_bot_token"
                            autoComplete="new-password"
                            data-1p-ignore="true"
                            data-lpignore="true"
                            class="flex-1 rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
                            placeholder={
                              isDiscordTokenSet
                                ? '•••••••••••••••••••• (Encrypted — enter new token to update)'
                                : 'Paste Discord Bot Token from Developer Portal'
                            }
                            value={discordToken}
                            onInput={(e) => setDiscordToken((e.target as HTMLInputElement).value)}
                          />
                          <button
                            type="button"
                            class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-xs font-medium text-pine-text transition-colors hover:bg-pine-highlight/50"
                            onClick={() => setShowDiscordToken(!showDiscordToken)}
                          >
                            {showDiscordToken ? 'Hide' : 'Show'}
                          </button>
                        </div>
                      </div>

                      <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
                        <div class="flex flex-col gap-1.5">
                          <label class="text-xs font-medium text-pine-subtle">
                            Notification Channel ID
                          </label>
                          <input
                            type="text"
                            name="agylity_discord_channel_id"
                            autoComplete="off"
                            inputMode="numeric"
                            data-1p-ignore="true"
                            data-lpignore="true"
                            class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
                            placeholder="e.g. 123456789012345678"
                            value={discordChannelId}
                            onInput={(e) =>
                              setDiscordChannelId((e.target as HTMLInputElement).value)
                            }
                          />
                          <span class="text-[11px] text-pine-muted">
                            Right click channel in Discord &gt; Copy Channel ID
                          </span>
                        </div>
                        <div class="flex flex-col gap-1.5">
                          <label class="text-xs font-medium text-pine-subtle">
                            Discord Client / Application ID
                          </label>
                          <input
                            type="text"
                            name="agylity_discord_client_id"
                            autoComplete="off"
                            inputMode="numeric"
                            data-1p-ignore="true"
                            data-lpignore="true"
                            class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
                            placeholder="e.g. 987654321098765432"
                            value={discordClientId}
                            onInput={(e) =>
                              setDiscordClientId((e.target as HTMLInputElement).value)
                            }
                          />
                          <div class="flex items-center justify-between text-[11px] text-pine-muted">
                            <span>Found in Discord Developer Portal General Info</span>
                            {discordClientId.trim() && (
                              <a
                                href={`https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(discordClientId.trim())}&permissions=2147601408&scope=bot%20applications.commands`}
                                target="_blank"
                                rel="noopener noreferrer"
                                class="inline-flex items-center gap-1 font-medium text-pine-iris hover:underline"
                                title="Authorize bot with exact required permissions and slash command scopes"
                              >
                                <span>Authorize Bot URL</span>
                                <Icon icon={faArrowUpRightFromSquare} class="size-2.5" />
                              </a>
                            )}
                          </div>
                        </div>
                        <div class="flex flex-col gap-1.5">
                          <label class="text-xs font-medium text-pine-subtle">
                            Discord Guild ID (Optional)
                          </label>
                          <input
                            type="text"
                            name="agylity_discord_guild_id"
                            autoComplete="off"
                            inputMode="numeric"
                            data-1p-ignore="true"
                            data-lpignore="true"
                            class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
                            placeholder="e.g. 112233445566778899"
                            value={discordGuildId}
                            onInput={(e) => setDiscordGuildId((e.target as HTMLInputElement).value)}
                          />
                          <span class="text-[11px] text-pine-muted">
                            Target server for fast command registration
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  {ch.id === 'webhook' && (
                    <div class="flex flex-col gap-5">
                      <div class="flex items-center justify-between border-b border-pine-highlight/40 pb-3">
                        <span class="text-xs font-semibold text-pine-subtle">
                          Webhook Endpoint &amp; Security
                        </span>
                        <button
                          type="button"
                          onClick={() => handleSendTest('webhook')}
                          disabled={testingChannel !== null}
                          class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-medium text-pine-subtle transition-colors hover:text-pine-text disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {testingChannel === 'webhook' ? 'Testing...' : 'Test Webhook Ping'}
                        </button>
                      </div>

                      <div class="flex flex-col gap-1.5">
                        <label class="flex items-center justify-between text-xs font-medium text-pine-subtle">
                          <span class="flex items-center gap-1.5">
                            Target Webhook URL
                            <span class="text-[10px] text-pine-foam">(Encrypted at rest)</span>
                          </span>
                          {isWebhookConfigured && (
                            <span class="font-mono text-[10px] text-pine-foam">Configured</span>
                          )}
                        </label>
                        <input
                          type="text"
                          name="agylity_webhook_target_url"
                          autoComplete="off"
                          data-1p-ignore="true"
                          data-lpignore="true"
                          class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
                          placeholder={
                            isWebhookConfigured
                              ? '•••••••••••••••••••• (Encrypted — enter new URL to update)'
                              : 'https://your-server.com/api/agylity-alert'
                          }
                          value={webhookUrl}
                          onInput={(e) => setWebhookUrl((e.target as HTMLInputElement).value)}
                        />
                        <span class="text-[11px] text-pine-muted">
                          Receives HTTP POST requests with JSON quota milestone payloads.
                        </span>
                      </div>

                      <div class="flex flex-col gap-1.5">
                        <label class="flex items-center justify-between text-xs font-medium text-pine-subtle">
                          <span class="flex items-center gap-1.5">
                            HMAC Secret Key (Optional)
                            <span class="text-[10px] text-pine-foam">(Encrypted at rest)</span>
                          </span>
                        </label>
                        <div class="flex gap-2">
                          <input
                            type={showWebhookSecret ? 'text' : 'password'}
                            name="agylity_webhook_secret_key"
                            autoComplete="new-password"
                            data-1p-ignore="true"
                            data-lpignore="true"
                            class="flex-1 rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
                            placeholder="Optional secret for x-agylity-signature header"
                            value={webhookSecret}
                            onInput={(e) => setWebhookSecret((e.target as HTMLInputElement).value)}
                          />
                          <button
                            type="button"
                            class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-xs font-medium text-pine-text transition-colors hover:bg-pine-highlight/50"
                            onClick={() => setShowWebhookSecret(!showWebhookSecret)}
                          >
                            {showWebhookSecret ? 'Hide' : 'Show'}
                          </button>
                        </div>
                        <span class="text-[11px] text-pine-muted">
                          When specified, Agylity signs each payload with HMAC-SHA256 in the
                          x-agylity-signature header.
                        </span>
                      </div>
                    </div>
                  )}

                  {ch.id === 'console' && (
                    <div class="flex flex-col gap-4">
                      <div class="flex items-center justify-between border-b border-pine-highlight/40 pb-3">
                        <span class="text-xs font-semibold text-pine-subtle">
                          Console Output Stream
                        </span>
                        <button
                          type="button"
                          onClick={() => handleSendTest('console')}
                          disabled={testingChannel !== null}
                          class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-medium text-pine-subtle transition-colors hover:text-pine-text disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {testingChannel === 'console' ? 'Testing...' : 'Test Console Output'}
                        </button>
                      </div>
                      <p class="text-xs/relaxed text-pine-muted">
                        Milestone warnings and quota alerts are formatted into clean ASCII boxes and
                        emitted directly to standard output, which streams live into the{' '}
                        <strong class="font-medium text-pine-text">Logs</strong> tab.
                      </p>
                    </div>
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
