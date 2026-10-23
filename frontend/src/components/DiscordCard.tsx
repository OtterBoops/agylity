import { useState, useEffect } from 'preact/hooks';
import type { ConfigData, ToastState } from '../types';
import { updateConfig } from '../api';

interface DiscordCardProps {
  config: ConfigData;
  onSaved: () => void;
}

export const DiscordCard = ({ config, onSaved }: DiscordCardProps) => {
  const [discordToken, setDiscordToken] = useState('');
  const [discordChannelId, setDiscordChannelId] = useState('');
  const [discordClientId, setDiscordClientId] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (config.resolved?.discordNotificationChannelId && !discordChannelId) {
      setDiscordChannelId(String(config.resolved.discordNotificationChannelId));
    }
    if (config.resolved?.discordClientId && !discordClientId) {
      setDiscordClientId(String(config.resolved.discordClientId));
    }
  }, [config.resolved]);

  const handleSaveDiscord = (e: Event) => {
    e.preventDefault();
    setIsSaving(true);
    setToast(null);

    const payload: Record<string, string> = { notificationChannel: 'discord' };
    if (discordToken.trim()) payload.discordToken = discordToken.trim();
    if (discordChannelId.trim()) payload.discordNotificationChannelId = discordChannelId.trim();
    if (discordClientId.trim()) payload.discordClientId = discordClientId.trim();

    updateConfig(payload)
      .then(() => {
        setToast({
          type: 'success',
          message: 'Discord bot credentials persisted to SQLite! Connecting bot...',
        });
        setDiscordToken('');
        onSaved();
      })
      .catch((err) =>
        setToast({ type: 'error', message: err.message || 'Failed to save configuration' })
      )
      .finally(() => setIsSaving(false));
  };

  const isConnected =
    !!config.resolved?.discordToken && config.resolved?.notificationChannel === 'discord';

  return (
    <div class="mb-8 flex flex-col gap-5 rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
      <div class="flex items-start justify-between">
        <div>
          <h2 class="text-lg font-semibold text-pine-text">Discord Bot Integration</h2>
          <p class="mt-0.5 text-xs text-pine-subtle">
            Configure and persist Discord bot token &amp; notification channel IDs directly into
            SQLite
          </p>
        </div>
        <span
          class={`rounded px-2 py-0.5 text-[11px] font-bold tracking-wider uppercase ${
            isConnected
              ? 'border border-pine-pine bg-pine-pine/20 text-pine-foam'
              : 'border border-pine-gold bg-pine-gold/20 text-pine-gold'
          }`}
        >
          {isConnected ? 'Discord Connected' : 'Setup Required'}
        </span>
      </div>

      <form onSubmit={handleSaveDiscord} class="flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-medium text-pine-subtle">
            Discord Bot Token (Stored encrypted in SQLite / env)
          </label>
          <div class="flex gap-2">
            <input
              type={showToken ? 'text' : 'password'}
              class="flex-1 rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
              placeholder={
                config.resolved?.discordToken
                  ? '•••••••••••••••••••• (Configured — enter new token to update)'
                  : 'Paste Discord Bot Application Token'
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

        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium text-pine-subtle">Notification Channel ID</label>
            <input
              type="text"
              class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
              placeholder="e.g. 123456789012345678"
              value={discordChannelId}
              onInput={(e) => setDiscordChannelId((e.target as HTMLInputElement).value)}
            />
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
          </div>
        </div>

        <div class="mt-2 flex justify-end gap-3">
          <button
            type="submit"
            class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-sm font-semibold text-pine-base shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
            disabled={isSaving}
          >
            {isSaving ? 'Saving...' : '💾 Save to SQLite & Connect'}
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
