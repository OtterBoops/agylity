import { useState, useEffect } from 'preact/hooks';
import type { ConfigData, ToastState } from '../types';
import { updateConfig, testNotification } from '../api';

interface NotificationsViewProps {
  config: ConfigData;
  onSaved: () => void;
}

type ChannelId = 'discord' | 'webhook' | 'console';

export const NotificationsView = ({ config, onSaved }: NotificationsViewProps) => {
  const resolved = config.resolved || {};

  const getInitialChannels = (): Set<ChannelId> => {
    if (Array.isArray(resolved.notificationChannels) && resolved.notificationChannels.length > 0) {
      return new Set(
        resolved.notificationChannels.filter(
          (c): c is ChannelId => c === 'discord' || c === 'webhook' || c === 'console'
        )
      );
    }
    if (resolved.notificationChannel && resolved.notificationChannel !== 'none') {
      const ch = String(resolved.notificationChannel) as ChannelId;
      if (ch === 'discord' || ch === 'webhook' || ch === 'console') {
        return new Set([ch]);
      }
    }
    return new Set<ChannelId>();
  };

  const [selectedChannels, setSelectedChannels] = useState<Set<ChannelId>>(getInitialChannels);

  const [discordToken, setDiscordToken] = useState('');
  const [discordChannelId, setDiscordChannelId] = useState('');
  const [discordClientId, setDiscordClientId] = useState('');
  const [discordGuildId, setDiscordGuildId] = useState('');
  const [showDiscordToken, setShowDiscordToken] = useState(false);

  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [showWebhookSecret, setShowWebhookSecret] = useState(false);

  const [toast, setToast] = useState<ToastState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [testingChannel, setTestingChannel] = useState<string | null>(null);

  useEffect(() => {
    setSelectedChannels(getInitialChannels());

    if (resolved.discordNotificationChannelId && !discordChannelId) {
      setDiscordChannelId(String(resolved.discordNotificationChannelId));
    }
    if (resolved.discordClientId && !discordClientId) {
      setDiscordClientId(String(resolved.discordClientId));
    }
    if (resolved.discordGuildId && !discordGuildId) {
      setDiscordGuildId(String(resolved.discordGuildId));
    }
    if (resolved.notificationWebhookUrl && !webhookUrl) {
      setWebhookUrl(String(resolved.notificationWebhookUrl));
    }
  }, [resolved]);

  const toggleChannel = (channel: ChannelId) => {
    setSelectedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(channel)) {
        next.delete(channel);
      } else {
        next.add(channel);
      }
      return next;
    });
  };

  const handleSave = async (e: Event) => {
    e.preventDefault();
    setIsSaving(true);
    setToast(null);

    const channelsArray = Array.from(selectedChannels);
    const payload: Record<string, unknown> = {
      notificationChannels: channelsArray,
      notificationChannel: channelsArray[0] || 'none',
    };

    if (selectedChannels.has('discord')) {
      if (discordToken.trim()) payload.discordToken = discordToken.trim();
      if (discordChannelId.trim()) payload.discordNotificationChannelId = discordChannelId.trim();
      if (discordClientId.trim()) payload.discordClientId = discordClientId.trim();
      if (discordGuildId.trim()) payload.discordGuildId = discordGuildId.trim();
    }

    if (selectedChannels.has('webhook')) {
      if (webhookUrl.trim()) payload.notificationWebhookUrl = webhookUrl.trim();
      if (webhookSecret.trim()) payload.webhookSecret = webhookSecret.trim();
    }

    updateConfig(payload)
      .then(() => {
        setToast({
          type: 'success',
          message:
            channelsArray.length > 0
              ? `Notification channels (${channelsArray.join(', ')}) saved to SQLite!`
              : 'Silent sentry mode enabled (all channels disabled).',
        });
        setDiscordToken('');
        setWebhookSecret('');
        onSaved();
      })
      .catch((err) =>
        setToast({ type: 'error', message: err.message || 'Failed to save configuration' })
      )
      .finally(() => setIsSaving(false));
  };

  const handleSendTest = (channel?: ChannelId) => {
    setTestingChannel(channel || 'all');
    setToast(null);

    testNotification(channel)
      .then((data) =>
        setToast({
          type: 'success',
          message: data.message || 'Test notification dispatched successfully!',
        })
      )
      .catch((err) =>
        setToast({
          type: 'error',
          message: err.message || 'Test notification delivery failed.',
        })
      )
      .finally(() => setTestingChannel(null));
  };

  const isDiscordTokenSet = Boolean(
    config.secretsMeta?.discordToken?.isSet ?? Boolean(resolved.discordToken)
  );
  const isDiscordConfigured = Boolean(isDiscordTokenSet && resolved.discordNotificationChannelId);

  const isWebhookConfigured = Boolean(
    config.secretsMeta?.notificationWebhookUrl?.isSet ?? Boolean(resolved.notificationWebhookUrl)
  );

  return (
    <div class="flex flex-col gap-6">
      {/* Channel Selector Header */}
      <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
        <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class="text-xl font-semibold text-pine-text">Multi-Channel Notifications</h2>
            <p class="mt-0.5 text-xs text-pine-subtle">
              Configure simultaneous notification delivery across multiple destinations. Default is
              silent sentry mode (none).
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            {selectedChannels.size === 0 ? (
              <span class="rounded border border-pine-highlight bg-pine-overlay px-2.5 py-1 text-[11px] font-bold tracking-wider text-pine-subtle uppercase">
                Silent Sentry (None)
              </span>
            ) : (
              Array.from(selectedChannels).map((ch) => (
                <span
                  key={ch}
                  class={`rounded border px-2.5 py-1 text-[11px] font-bold tracking-wider uppercase ${
                    ch === 'discord'
                      ? isDiscordConfigured
                        ? 'border-pine-pine bg-pine-pine/20 text-pine-foam'
                        : 'border-pine-gold bg-pine-gold/20 text-pine-gold'
                      : ch === 'webhook'
                        ? isWebhookConfigured
                          ? 'border-pine-pine bg-pine-pine/20 text-pine-foam'
                          : 'border-pine-gold bg-pine-gold/20 text-pine-gold'
                        : 'border-pine-pine bg-pine-pine/20 text-pine-foam'
                  }`}
                >
                  {ch === 'discord'
                    ? isDiscordConfigured
                      ? 'Discord Active'
                      : 'Discord Incomplete'
                    : ch === 'webhook'
                      ? isWebhookConfigured
                        ? 'Webhook Active'
                        : 'Webhook Incomplete'
                      : 'Console Active'}
                </span>
              ))
            )}
          </div>
        </div>

        {/* Multi-Channel Toggle Cards */}
        <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
          {/* Discord Card */}
          <button
            type="button"
            onClick={() => toggleChannel('discord')}
            class={`flex cursor-pointer flex-col rounded-lg border p-4 text-left transition-all ${
              selectedChannels.has('discord')
                ? 'border-pine-iris bg-pine-iris/15 text-pine-text shadow-sm'
                : 'border-pine-highlight/60 bg-pine-overlay/40 text-pine-subtle hover:border-pine-highlight hover:text-pine-text'
            }`}
          >
            <div class="mb-1 flex items-center justify-between">
              <span class="text-sm font-semibold text-pine-text">💬 Discord Bot</span>
              <span
                class={`size-2 rounded-full ${
                  selectedChannels.has('discord') ? 'bg-pine-foam' : 'bg-pine-muted/40'
                }`}
              />
            </div>
            <p class="text-xs/relaxed text-pine-muted">
              Sends rich embeds to a Discord channel with slash commands (/quota) and interactive
              dispatch modals.
            </p>
          </button>

          {/* Webhook Card */}
          <button
            type="button"
            onClick={() => toggleChannel('webhook')}
            class={`flex cursor-pointer flex-col rounded-lg border p-4 text-left transition-all ${
              selectedChannels.has('webhook')
                ? 'border-pine-iris bg-pine-iris/15 text-pine-text shadow-sm'
                : 'border-pine-highlight/60 bg-pine-overlay/40 text-pine-subtle hover:border-pine-highlight hover:text-pine-text'
            }`}
          >
            <div class="mb-1 flex items-center justify-between">
              <span class="text-sm font-semibold text-pine-text">🔗 Generic Webhook</span>
              <span
                class={`size-2 rounded-full ${
                  selectedChannels.has('webhook') ? 'bg-pine-foam' : 'bg-pine-muted/40'
                }`}
              />
            </div>
            <p class="text-xs/relaxed text-pine-muted">
              Dispatches JSON payloads with optional HMAC-SHA256 signatures to custom HTTP endpoints
              (Slack, n8n, Home Assistant).
            </p>
          </button>

          {/* Console Card */}
          <button
            type="button"
            onClick={() => toggleChannel('console')}
            class={`flex cursor-pointer flex-col rounded-lg border p-4 text-left transition-all ${
              selectedChannels.has('console')
                ? 'border-pine-iris bg-pine-iris/15 text-pine-text shadow-sm'
                : 'border-pine-highlight/60 bg-pine-overlay/40 text-pine-subtle hover:border-pine-highlight hover:text-pine-text'
            }`}
          >
            <div class="mb-1 flex items-center justify-between">
              <span class="text-sm font-semibold text-pine-text">💻 Local Console</span>
              <span
                class={`size-2 rounded-full ${
                  selectedChannels.has('console') ? 'bg-pine-foam' : 'bg-pine-muted/40'
                }`}
              />
            </div>
            <p class="text-xs/relaxed text-pine-muted">
              Prints formatted ASCII milestone boxes directly to stdout and into the Live Logs view
              with zero network dependencies.
            </p>
          </button>
        </div>
      </div>

      {/* Configuration Form */}
      <form
        onSubmit={handleSave}
        class="flex flex-col gap-6 rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm"
      >
        {/* Discord Form */}
        {selectedChannels.has('discord') && (
          <div class="flex flex-col gap-4 border-b border-pine-highlight/60 pb-6">
            <div class="flex items-center justify-between">
              <h3 class="text-base font-semibold text-pine-text">Discord Bot Credentials</h3>
              <button
                type="button"
                onClick={() => handleSendTest('discord')}
                disabled={testingChannel !== null}
                class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-semibold text-pine-subtle transition-colors hover:text-pine-text disabled:opacity-50"
              >
                {testingChannel === 'discord' ? 'Testing...' : '🔔 Test Discord Ping'}
              </button>
            </div>

            <div class="flex flex-col gap-1.5">
              <label class="flex items-center justify-between text-xs font-medium text-pine-subtle">
                <span class="flex items-center gap-1.5">
                  Bot Application Token
                  <span class="text-[10px] text-pine-foam">🔒 Encrypted at rest (AES-256-GCM)</span>
                </span>
                {isDiscordTokenSet && (
                  <span class="text-[10px] font-semibold tracking-wider text-pine-foam uppercase">
                    Configured
                  </span>
                )}
              </label>
              <div class="flex gap-2">
                <input
                  type={showDiscordToken ? 'text' : 'password'}
                  class="flex-1 rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
                  placeholder={
                    isDiscordTokenSet
                      ? '•••••••••••••••••••• (Encrypted in SQLite — enter new token to update)'
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
                <label class="text-xs font-medium text-pine-subtle">Notification Channel ID</label>
                <input
                  type="text"
                  class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
                  placeholder="e.g. 123456789012345678"
                  value={discordChannelId}
                  onInput={(e) => setDiscordChannelId((e.target as HTMLInputElement).value)}
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
                  class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
                  placeholder="e.g. 987654321098765432"
                  value={discordClientId}
                  onInput={(e) => setDiscordClientId((e.target as HTMLInputElement).value)}
                />
                <span class="text-[11px] text-pine-muted">
                  Found in Discord Developer Portal General Info
                </span>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-xs font-medium text-pine-subtle">
                  Discord Guild ID (Optional)
                </label>
                <input
                  type="text"
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

        {/* Webhook Form */}
        {selectedChannels.has('webhook') && (
          <div class="flex flex-col gap-4 border-b border-pine-highlight/60 pb-6">
            <div class="flex items-center justify-between">
              <h3 class="text-base font-semibold text-pine-text">Webhook Endpoint & Security</h3>
              <button
                type="button"
                onClick={() => handleSendTest('webhook')}
                disabled={testingChannel !== null}
                class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-semibold text-pine-subtle transition-colors hover:text-pine-text disabled:opacity-50"
              >
                {testingChannel === 'webhook' ? 'Testing...' : '🔗 Test Webhook Ping'}
              </button>
            </div>

            <div class="flex flex-col gap-1.5">
              <label class="flex items-center justify-between text-xs font-medium text-pine-subtle">
                <span class="flex items-center gap-1.5">
                  Target Webhook URL
                  <span class="text-[10px] text-pine-foam">🔒 Encrypted at rest (AES-256-GCM)</span>
                </span>
                {isWebhookConfigured && (
                  <span class="text-[10px] font-semibold tracking-wider text-pine-foam uppercase">
                    Configured
                  </span>
                )}
              </label>
              <input
                type="text"
                class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
                placeholder={
                  isWebhookConfigured
                    ? '•••••••••••••••••••• (Encrypted in SQLite — enter new URL to update)'
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
                  <span class="text-[10px] text-pine-foam">🔒 Encrypted at rest (AES-256-GCM)</span>
                </span>
              </label>
              <div class="flex gap-2">
                <input
                  type={showWebhookSecret ? 'text' : 'password'}
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

        {/* Console Note */}
        {selectedChannels.has('console') && (
          <div class="rounded-lg border border-pine-highlight/40 bg-pine-overlay/40 p-4">
            <div class="flex items-center justify-between">
              <h3 class="mb-1 text-sm font-semibold text-pine-text">Console Output</h3>
              <button
                type="button"
                onClick={() => handleSendTest('console')}
                disabled={testingChannel !== null}
                class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1 text-xs font-semibold text-pine-subtle transition-colors hover:text-pine-text disabled:opacity-50"
              >
                {testingChannel === 'console' ? 'Testing...' : '💻 Test Console Output'}
              </button>
            </div>
            <p class="text-xs/relaxed text-pine-muted">
              Milestone warnings are rendered directly to the host process console and streamed into
              the Live Logs view. No external credentials required.
            </p>
          </div>
        )}

        {/* Action Buttons: Save & Test All */}
        <div class="flex flex-wrap items-center justify-between gap-3 pt-2">
          <button
            type="button"
            onClick={() => handleSendTest()}
            disabled={testingChannel !== null || selectedChannels.size === 0}
            class="flex cursor-pointer items-center gap-2 rounded-lg border border-pine-highlight bg-pine-overlay px-4 py-2 text-xs font-semibold text-pine-text transition-colors hover:bg-pine-highlight/50 disabled:opacity-50"
          >
            <span>🔔</span>{' '}
            {testingChannel === 'all' ? 'Broadcasting...' : 'Test All Active Channels'}
          </button>

          <button
            type="submit"
            disabled={isSaving}
            class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-sm font-semibold text-pine-base shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Save Settings to SQLite'}
          </button>
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
