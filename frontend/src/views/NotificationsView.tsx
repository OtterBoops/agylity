import { useState, useEffect } from 'preact/hooks';
import type { ConfigData, ToastState } from '../types';
import { updateConfig, testNotification } from '../api';

interface NotificationsViewProps {
  config: ConfigData;
  onSaved: () => void;
}

export const NotificationsView = ({ config, onSaved }: NotificationsViewProps) => {
  const resolved = config.resolved || {};
  const currentChannel =
    (resolved.notificationChannel as 'discord' | 'webhook' | 'console') || 'discord';

  const [activeChannel, setActiveChannel] = useState<'discord' | 'webhook' | 'console'>(
    currentChannel
  );
  const [discordToken, setDiscordToken] = useState('');
  const [discordChannelId, setDiscordChannelId] = useState('');
  const [discordClientId, setDiscordClientId] = useState('');
  const [discordGuildId, setDiscordGuildId] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [showToken, setShowToken] = useState(false);

  const [toast, setToast] = useState<ToastState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);

  useEffect(() => {
    if (resolved.notificationChannel) {
      setActiveChannel(resolved.notificationChannel as any);
    }
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

  const handleSave = async (e: Event) => {
    e.preventDefault();
    setIsSaving(true);
    setToast(null);

    const payload: Record<string, unknown> = {
      notificationChannel: activeChannel,
    };

    if (activeChannel === 'discord') {
      if (discordToken.trim()) payload.discordToken = discordToken.trim();
      if (discordChannelId.trim()) payload.discordNotificationChannelId = discordChannelId.trim();
      if (discordClientId.trim()) payload.discordClientId = discordClientId.trim();
      if (discordGuildId.trim()) payload.discordGuildId = discordGuildId.trim();
    } else if (activeChannel === 'webhook') {
      payload.notificationWebhookUrl = webhookUrl.trim();
    }

    updateConfig(payload)
      .then(() => {
        setToast({
          type: 'success',
          message: 'Notification settings saved to SQLite (encrypted at rest)!',
        });
        setDiscordToken('');
        onSaved();
      })
      .catch((err) =>
        setToast({ type: 'error', message: err.message || 'Failed to save configuration' })
      )
      .finally(() => setIsSaving(false));
  };

  const handleSendTest = () => {
    setIsTesting(true);
    setToast(null);

    testNotification()
      .then((data) =>
        setToast({
          type: 'success',
          message: data.message || 'Test notification sent successfully!',
        })
      )
      .catch((err) =>
        setToast({ type: 'error', message: err.message || 'Test notification delivery failed' })
      )
      .finally(() => setIsTesting(false));
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
        <div class="mb-4 flex items-start justify-between">
          <div>
            <h2 class="text-xl font-semibold text-pine-text">Notification Channels</h2>
            <p class="mt-0.5 text-xs text-pine-subtle">
              Select where Agylity delivers rolling quota milestone warnings and remote task
              dispatch updates.
            </p>
          </div>
          <span
            class={`rounded border px-2.5 py-1 text-[11px] font-bold tracking-wider uppercase ${
              activeChannel === 'discord'
                ? isDiscordConfigured
                  ? 'border-pine-pine bg-pine-pine/20 text-pine-foam'
                  : 'border-pine-gold bg-pine-gold/20 text-pine-gold'
                : activeChannel === 'webhook'
                  ? isWebhookConfigured
                    ? 'border-pine-pine bg-pine-pine/20 text-pine-foam'
                    : 'border-pine-gold bg-pine-gold/20 text-pine-gold'
                  : 'border-pine-highlight bg-pine-overlay text-pine-subtle'
            }`}
          >
            {activeChannel === 'discord'
              ? isDiscordConfigured
                ? 'Discord Active'
                : 'Discord Incomplete'
              : activeChannel === 'webhook'
                ? isWebhookConfigured
                  ? 'Webhook Active'
                  : 'Webhook Incomplete'
                : 'Console Only'}
          </span>
        </div>

        {/* Channel Selection Radio Cards */}
        <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
          <button
            type="button"
            onClick={() => setActiveChannel('discord')}
            class={`flex cursor-pointer flex-col rounded-lg border p-4 text-left transition-all ${
              activeChannel === 'discord'
                ? 'border-pine-iris bg-pine-iris/15 text-pine-text shadow-sm'
                : 'border-pine-highlight/60 bg-pine-overlay/40 text-pine-subtle hover:border-pine-highlight hover:text-pine-text'
            }`}
          >
            <div class="mb-1 flex items-center gap-2 text-sm font-semibold">
              <span>💬</span> Discord Bot
            </div>
            <p class="text-xs text-pine-muted">
              Sends rich embeds to a Discord channel with slash commands (/quota) and interactive
              dispatch modals.
            </p>
          </button>

          <button
            type="button"
            onClick={() => setActiveChannel('webhook')}
            class={`flex cursor-pointer flex-col rounded-lg border p-4 text-left transition-all ${
              activeChannel === 'webhook'
                ? 'border-pine-iris bg-pine-iris/15 text-pine-text shadow-sm'
                : 'border-pine-highlight/60 bg-pine-overlay/40 text-pine-subtle hover:border-pine-highlight hover:text-pine-text'
            }`}
          >
            <div class="mb-1 flex items-center gap-2 text-sm font-semibold">
              <span>🔗</span> Webhook
            </div>
            <p class="text-xs text-pine-muted">
              Dispatches JSON payloads on quota milestones to custom endpoints (Slack, n8n, Home
              Assistant).
            </p>
          </button>

          <button
            type="button"
            onClick={() => setActiveChannel('console')}
            class={`flex cursor-pointer flex-col rounded-lg border p-4 text-left transition-all ${
              activeChannel === 'console'
                ? 'border-pine-iris bg-pine-iris/15 text-pine-text shadow-sm'
                : 'border-pine-highlight/60 bg-pine-overlay/40 text-pine-subtle hover:border-pine-highlight hover:text-pine-text'
            }`}
          >
            <div class="mb-1 flex items-center gap-2 text-sm font-semibold">
              <span>💻</span> Local Console
            </div>
            <p class="text-xs text-pine-muted">
              Prints formatted ASCII milestone boxes to stdout with zero network dependencies or
              external bots.
            </p>
          </button>
        </div>
      </div>

      {/* Channel-Specific Configuration Form */}
      <form
        onSubmit={handleSave}
        class="flex flex-col gap-5 rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm"
      >
        {activeChannel === 'discord' && (
          <div class="flex flex-col gap-4">
            <h3 class="text-base font-semibold text-pine-text">Discord Bot Credentials</h3>

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
                  type={showToken ? 'text' : 'password'}
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
                  onClick={() => setShowToken(!showToken)}
                >
                  {showToken ? 'Hide' : 'Show'}
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

        {activeChannel === 'webhook' && (
          <div class="flex flex-col gap-4">
            <h3 class="text-base font-semibold text-pine-text">Webhook Endpoint</h3>
            <div class="flex flex-col gap-1.5">
              <label class="flex items-center justify-between text-xs font-medium text-pine-subtle">
                <span class="flex items-center gap-1.5">
                  Target Webhook URL
                  <span class="text-[10px] text-pine-foam">🔒 Encrypted at rest (AES-256-GCM)</span>
                </span>
              </label>
              <input
                type="text"
                class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
                placeholder={
                  isWebhookConfigured
                    ? '•••••••••••••••••••• (Encrypted in SQLite — enter new URL to update)'
                    : 'https://your-server.com/api/webhook'
                }
                value={webhookUrl}
                onInput={(e) => setWebhookUrl((e.target as HTMLInputElement).value)}
              />
              <span class="text-[11px] text-pine-muted">
                Receives POST JSON requests with quota alerts and lifecycle events.
              </span>
            </div>
          </div>
        )}

        {activeChannel === 'console' && (
          <div class="rounded-lg border border-pine-highlight/40 bg-pine-overlay/40 p-4">
            <h3 class="mb-1 text-sm font-semibold text-pine-text">Console Output Active</h3>
            <p class="text-xs text-pine-muted">
              Milestone warnings are rendered directly to the host process console and streamed into
              the Live Logs view. No external bot tokens or credentials are required.
            </p>
          </div>
        )}

        {/* Action Buttons: Save & Test Notification */}
        <div class="flex flex-wrap items-center justify-between gap-3 border-t border-pine-highlight pt-4">
          <button
            type="button"
            onClick={handleSendTest}
            disabled={isTesting}
            class="flex cursor-pointer items-center gap-2 rounded-lg border border-pine-highlight bg-pine-overlay px-4 py-2 text-xs font-semibold text-pine-text transition-colors hover:bg-pine-highlight/50 disabled:opacity-50"
          >
            <span>🔔</span> {isTesting ? 'Sending Test...' : 'Send Test Notification'}
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
