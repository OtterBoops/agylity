import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons';
import { useState } from 'preact/hooks';
import { Icon } from './Icon';
import { DiscordEmbedSimulator } from './DiscordEmbedSimulator';

interface DiscordChannelFormProps {
  token: string;
  onTokenChange: (val: string) => void;
  isTokenSet: boolean;
  onClearToken: () => Promise<void>;
  clientId: string;
  onClientIdChange: (val: string) => void;
  channelId: string;
  onChannelIdChange: (val: string) => void;
  guildId: string;
  onGuildIdChange: (val: string) => void;
  ownerUserId: string;
  onOwnerUserIdChange: (val: string) => void;
  pingOwner: boolean;
  onPingOwnerChange: (val: boolean) => void;
  onSendTest: () => void;
  isTesting: boolean;
  diagnostics?: { success: boolean; message: string; timestamp: string } | null;
}

export const DiscordChannelForm = ({
  token,
  onTokenChange,
  isTokenSet,
  onClearToken,
  clientId,
  onClientIdChange,
  channelId,
  onChannelIdChange,
  guildId,
  onGuildIdChange,
  ownerUserId,
  onOwnerUserIdChange,
  pingOwner,
  onPingOwnerChange,
  onSendTest,
  isTesting,
  diagnostics,
}: DiscordChannelFormProps) => {
  const [showToken, setShowToken] = useState(false);
  const [embedPreviewTier, setEmbedPreviewTier] = useState<'alert' | 'warning' | 'burn'>('alert');

  return (
    <div class="flex flex-col gap-5">
      <div class="flex items-center justify-between border-b border-pine-highlight pb-3">
        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold text-pine-subtle">Discord Bot Configuration</span>
          <span class="text-[10px] text-pine-muted">• Slash commands &amp; rich alert embeds</span>
        </div>
        <button
          type="button"
          onClick={onSendTest}
          disabled={isTesting}
          class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-medium text-pine-subtle transition-colors hover:border-pine-iris hover:text-pine-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isTesting ? 'Testing...' : 'Test Discord Ping'}
        </button>
      </div>

      {diagnostics && (
        <div
          class={`flex items-start gap-2.5 rounded-lg border p-3 text-xs ${
            diagnostics.success
              ? 'border-pine-foam/40 bg-pine-foam/10 text-pine-foam'
              : 'border-pine-love/40 bg-pine-love/10 text-pine-love'
          }`}
        >
          <span class="font-mono text-[10px] font-bold tracking-wider uppercase">
            [{diagnostics.success ? 'Success' : 'Error'}]
          </span>
          <span class="flex-1 wrap-break-word">{diagnostics.message}</span>
          <span class="shrink-0 font-mono text-[10px] text-pine-muted">
            {diagnostics.timestamp}
          </span>
        </div>
      )}

      {/* Stage 1: Bot Credentials & App Identity */}
      <div class="flex flex-col gap-4 rounded-xl border border-pine-highlight bg-pine-overlay/30 p-4 sm:p-5">
        <div class="flex items-center justify-between border-b border-pine-highlight/60 pb-2">
          <h4 class="text-xs font-semibold tracking-wider text-pine-text uppercase">
            Stage 1: Bot Credentials &amp; Identity
          </h4>
          <span class="text-xs text-pine-muted">Discord Developer Portal</span>
        </div>

        <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div class="flex flex-col gap-1.5">
            <label class="flex items-center justify-between text-xs font-medium text-pine-subtle">
              <span class="flex items-center gap-1.5">
                Bot Application Token
                <span class="text-xs text-pine-foam">(Encrypted at rest)</span>
              </span>
              {isTokenSet && (
                <div class="flex items-center gap-2">
                  <span class="font-mono text-xs text-pine-foam">Configured</span>
                  <button
                    type="button"
                    onClick={onClearToken}
                    class="cursor-pointer text-xs text-pine-subtle transition-colors hover:text-pine-love hover:underline"
                    title="Clear saved Discord bot token"
                  >
                    Clear
                  </button>
                </div>
              )}
            </label>
            <div class="flex gap-2">
              <input
                type={showToken ? 'text' : 'password'}
                name="agylity_discord_bot_token"
                autoComplete="new-password"
                data-1p-ignore="true"
                data-lpignore="true"
                class="flex-1 rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
                placeholder={
                  isTokenSet
                    ? '•••••••••••••••••••• (Encrypted — enter new token to update)'
                    : 'Paste Discord Bot Token'
                }
                value={token}
                onInput={(e) => onTokenChange((e.target as HTMLInputElement).value)}
              />
              <button
                type="button"
                class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-xs font-medium text-pine-text transition-colors hover:bg-pine-highlight/50"
                onClick={() => setShowToken(!showToken)}
              >
                {showToken ? 'Hide' : 'Show'}
              </button>
            </div>
            <span class="text-xs text-pine-muted">Developer Portal &gt; Bot &gt; Reset Token</span>
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
              value={clientId}
              onInput={(e) => onClientIdChange((e.target as HTMLInputElement).value)}
            />
            <div class="flex items-center justify-between text-xs text-pine-muted">
              <span>Developer Portal General Information</span>
              {clientId.trim() && (
                <a
                  href={`https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId.trim())}&permissions=2147601408&scope=bot%20applications.commands`}
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
        </div>
      </div>

      {/* Stage 2: Notification Target & Guild Routing */}
      <div class="flex flex-col gap-4 rounded-xl border border-pine-highlight bg-pine-overlay/30 p-4 sm:p-5">
        <div class="flex items-center justify-between border-b border-pine-highlight/60 pb-2">
          <h4 class="text-xs font-semibold tracking-wider text-pine-text uppercase">
            Stage 2: Delivery Target &amp; Server Routing
          </h4>
          <span class="text-xs text-pine-muted">Discord Server &amp; Channels</span>
        </div>

        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium text-pine-subtle">Notification Channel ID</label>
            <input
              type="text"
              name="agylity_discord_channel_id"
              autoComplete="off"
              inputMode="numeric"
              data-1p-ignore="true"
              data-lpignore="true"
              class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
              placeholder="e.g. 123456789012345678"
              value={channelId}
              onInput={(e) => onChannelIdChange((e.target as HTMLInputElement).value)}
            />
            <span class="text-xs text-pine-muted">
              Right click channel in Discord &gt; Copy Channel ID
            </span>
          </div>

          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium text-pine-subtle">Discord Guild ID (Optional)</label>
            <input
              type="text"
              name="agylity_discord_guild_id"
              autoComplete="off"
              inputMode="numeric"
              data-1p-ignore="true"
              data-lpignore="true"
              class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
              placeholder="e.g. 112233445566778899"
              value={guildId}
              onInput={(e) => onGuildIdChange((e.target as HTMLInputElement).value)}
            />
            <span class="text-xs text-pine-muted">
              Target server for instant slash command registration
            </span>
          </div>

          <div class="flex flex-col gap-1.5 md:col-span-2">
            <label class="flex items-center justify-between text-xs font-medium text-pine-subtle">
              <span>Owner Discord User ID (Single-User Binding)</span>
              <span class="font-mono text-xs text-pine-foam">
                {ownerUserId.trim() ? 'Explicitly Bound' : 'Session Auto-Pinned (TOFU)'}
              </span>
            </label>
            <input
              type="text"
              name="agylity_discord_owner_user_id"
              autoComplete="off"
              inputMode="numeric"
              data-1p-ignore="true"
              data-lpignore="true"
              class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
              placeholder="e.g. 334455667788990011 (Restricts /quota and dispatches to this Discord user ID)"
              value={ownerUserId}
              onInput={(e) => onOwnerUserIdChange((e.target as HTMLInputElement).value)}
            />
            <span class="text-xs text-pine-muted">
              Enforces the Single-Tenant Invariant: only your Discord User ID can query quotas or
              trigger tasks
            </span>
          </div>

          <div class="flex items-center justify-between gap-4 rounded-lg border border-pine-highlight bg-pine-overlay/40 p-3.5 md:col-span-2">
            <div class="flex flex-col gap-0.5">
              <span class="text-xs font-semibold text-pine-text">Ping Owner on Discord</span>
              <span class="text-xs text-pine-muted">
                Mentions your Discord user ID (
                <code class="font-mono text-pine-foam">
                  &lt;@{ownerUserId.trim() || 'owner'}&gt;
                </code>
                ) in the notification message so Discord triggers an active push and sound alert
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={pingOwner}
              onClick={() => onPingOwnerChange(!pingOwner)}
              class={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                pingOwner ? 'bg-pine-iris' : 'border-pine-highlight bg-pine-overlay'
              }`}
              title={
                pingOwner
                  ? 'Disable owner mention in Discord notifications'
                  : 'Enable owner mention in Discord notifications'
              }
            >
              <span
                aria-hidden="true"
                class={`pointer-events-none inline-block size-5 transform rounded-full bg-white shadow-xs ring-0 transition duration-200 ease-in-out ${
                  pingOwner ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Live Embed Simulator */}
      <DiscordEmbedSimulator
        previewTier={embedPreviewTier}
        onTierChange={setEmbedPreviewTier}
        pingOwner={pingOwner}
        ownerUserId={ownerUserId}
      />
    </div>
  );
};
