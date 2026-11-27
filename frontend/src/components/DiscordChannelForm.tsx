import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons';
import { useState } from 'preact/hooks';
import { Icon } from './Icon';
import { DiscordEmbedSimulator } from './DiscordEmbedSimulator';

const INPUT_CLASS =
  'rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text placeholder-pine-subtle transition-colors outline-none focus:border-pine-iris';

/** A stored secret arrives as the mask; the input stays empty and the placeholder says so. */
const MASKED = new Set(['••••••••', '********']);
const editable = (value: string): string => (MASKED.has(value.trim()) ? '' : value);

interface DiscordChannelFormProps {
  destinationId: string;
  token: string;
  onTokenChange: (val: string) => void;
  isTokenSet: boolean;
  clientId: string;
  onClientIdChange: (val: string) => void;
  channelId: string;
  onChannelIdChange: (val: string) => void;
  guildId: string;
  onGuildIdChange: (val: string) => void;
  ownerUserId: string;
  pingOwner: boolean;
}

export const DiscordChannelForm = ({
  destinationId,
  token,
  onTokenChange,
  isTokenSet,
  clientId,
  onClientIdChange,
  channelId,
  onChannelIdChange,
  guildId,
  onGuildIdChange,
  ownerUserId,
  pingOwner,
}: DiscordChannelFormProps) => {
  const [showToken, setShowToken] = useState(false);
  const [embedPreviewTier, setEmbedPreviewTier] = useState<'alert' | 'warning' | 'burn'>('alert');

  return (
    <div class="flex flex-col gap-5">
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div class="flex flex-col gap-1.5">
          <label
            class="flex items-center justify-between text-xs font-medium text-pine-subtle"
            for={`${destinationId}-token`}
          >
            <span class="flex items-center gap-1.5">
              Bot Token
              <span class="text-xs text-pine-foam">(Encrypted at rest)</span>
            </span>
            {isTokenSet && <span class="font-mono text-xs text-pine-foam">Configured</span>}
          </label>
          <div class="flex gap-2">
            <input
              id={`${destinationId}-token`}
              type={showToken ? 'text' : 'password'}
              name={`agylity_${destinationId}_token`}
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              class={`flex-1 ${INPUT_CLASS}`}
              placeholder={
                isTokenSet
                  ? '•••••••••••••••••••• (stored — enter a new token to replace)'
                  : 'Paste Discord bot token'
              }
              value={editable(token)}
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
          <span class="text-xs text-pine-subtle">Developer Portal &gt; Bot &gt; Reset Token</span>
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-medium text-pine-subtle" for={`${destinationId}-client-id`}>
            Client / Application ID
          </label>
          <input
            id={`${destinationId}-client-id`}
            type="text"
            name={`agylity_${destinationId}_client_id`}
            autoComplete="off"
            inputMode="numeric"
            data-1p-ignore="true"
            data-lpignore="true"
            class={INPUT_CLASS}
            placeholder="e.g. 123456789012345678"
            value={clientId}
            onInput={(e) => onClientIdChange((e.target as HTMLInputElement).value)}
          />
          <div class="flex items-center justify-between text-xs text-pine-subtle">
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

        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-medium text-pine-subtle" for={`${destinationId}-channel-id`}>
            Notification Channel ID
          </label>
          <input
            id={`${destinationId}-channel-id`}
            type="text"
            name={`agylity_${destinationId}_channel_id`}
            autoComplete="off"
            inputMode="numeric"
            data-1p-ignore="true"
            data-lpignore="true"
            class={INPUT_CLASS}
            placeholder="e.g. 123456789012345678"
            value={channelId}
            onInput={(e) => onChannelIdChange((e.target as HTMLInputElement).value)}
          />
          <span class="text-xs text-pine-subtle">
            Right click channel in Discord &gt; Copy Channel ID
          </span>
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-medium text-pine-subtle" for={`${destinationId}-guild-id`}>
            Guild ID (Optional)
          </label>
          <input
            id={`${destinationId}-guild-id`}
            type="text"
            name={`agylity_${destinationId}_guild_id`}
            autoComplete="off"
            inputMode="numeric"
            data-1p-ignore="true"
            data-lpignore="true"
            class={INPUT_CLASS}
            placeholder="e.g. 123456789012345678"
            value={guildId}
            onInput={(e) => onGuildIdChange((e.target as HTMLInputElement).value)}
          />
          <span class="text-xs text-pine-subtle">
            Target server for instant slash command registration
          </span>
        </div>
      </div>

      <DiscordEmbedSimulator
        previewTier={embedPreviewTier}
        onTierChange={setEmbedPreviewTier}
        pingOwner={pingOwner}
        ownerUserId={ownerUserId}
      />
    </div>
  );
};
