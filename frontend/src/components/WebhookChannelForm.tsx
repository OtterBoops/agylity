import { useState } from 'preact/hooks';
import { ToggleSwitch } from './ToggleSwitch';

interface WebhookChannelFormProps {
  url: string;
  onUrlChange: (val: string) => void;
  isUrlSet: boolean;
  onClearUrl: () => Promise<void>;
  secret: string;
  onSecretChange: (val: string) => void;
  isSecretSet: boolean;
  onClearSecret: () => Promise<void>;
  pingOwner: boolean;
  onPingOwnerChange: (val: boolean) => void;
  diagnostics?: { success: boolean; message: string; timestamp: string } | null;
}

export const WebhookChannelForm = ({
  url,
  onUrlChange,
  isUrlSet,
  onClearUrl,
  secret,
  onSecretChange,
  isSecretSet,
  onClearSecret,
  pingOwner,
  onPingOwnerChange,
  diagnostics,
}: WebhookChannelFormProps) => {
  const [showSecret, setShowSecret] = useState(false);

  return (
    <div class="flex flex-col gap-5">
      {diagnostics && (
        <div
          class={`flex items-start gap-2.5 rounded-lg border p-3 text-xs ${
            diagnostics.success
              ? 'border-pine-foam/40 bg-pine-foam/10 text-pine-foam'
              : 'border-pine-love/40 bg-pine-love/10 text-pine-love'
          }`}
        >
          <span class="font-mono text-xs font-bold tracking-wider uppercase">
            [{diagnostics.success ? 'Success' : 'Error'}]
          </span>
          <span class="flex-1 wrap-break-word">{diagnostics.message}</span>
          <span class="shrink-0 font-mono text-xs text-pine-subtle">{diagnostics.timestamp}</span>
        </div>
      )}

      <div class="flex flex-col gap-1.5">
        <label class="flex items-center justify-between text-xs font-medium text-pine-subtle">
          <span class="flex items-center gap-1.5">
            Target Webhook URL
            <span class="text-xs text-pine-foam">(Encrypted at rest)</span>
          </span>
          {isUrlSet && (
            <div class="flex items-center gap-2">
              <span class="font-mono text-xs text-pine-foam">Configured</span>
              <button
                type="button"
                onClick={onClearUrl}
                class="cursor-pointer text-xs text-pine-subtle transition-colors hover:text-pine-love hover:underline"
                title="Clear saved webhook URL"
              >
                Clear
              </button>
            </div>
          )}
        </label>
        <input
          type="text"
          name="agylity_webhook_target_url"
          autoComplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text placeholder-pine-subtle transition-colors outline-none focus:border-pine-iris"
          placeholder={
            isUrlSet
              ? '•••••••••••••••••••• (Encrypted — enter new URL to update)'
              : 'https://discord.com/api/webhooks/... or https://example.com/api/alert'
          }
          value={url}
          onInput={(e) => onUrlChange((e.target as HTMLInputElement).value)}
        />
        <span class="text-xs text-pine-subtle">
          Receives HTTP POST requests with JSON quota milestone payloads (Discord, Slack, &amp;
          generic endpoints supported).
        </span>
      </div>

      <div class="flex flex-col gap-1.5">
        <label class="flex items-center justify-between text-xs font-medium text-pine-subtle">
          <span class="flex items-center gap-1.5">
            HMAC Secret Key (Optional)
            <span class="text-xs text-pine-foam">(Encrypted at rest)</span>
          </span>
          {isSecretSet && (
            <div class="flex items-center gap-2">
              <span class="font-mono text-xs text-pine-foam">Configured</span>
              <button
                type="button"
                onClick={onClearSecret}
                class="cursor-pointer text-xs text-pine-subtle transition-colors hover:text-pine-love hover:underline"
                title="Clear saved HMAC secret key"
              >
                Clear
              </button>
            </div>
          )}
        </label>
        <div class="flex gap-2">
          <input
            type={showSecret ? 'text' : 'password'}
            name="agylity_webhook_secret_key"
            autoComplete="new-password"
            data-1p-ignore="true"
            data-lpignore="true"
            class="flex-1 rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text placeholder-pine-subtle transition-colors outline-none focus:border-pine-iris"
            placeholder={
              isSecretSet
                ? '•••••••••••••••••••• (Encrypted — enter new secret to update)'
                : 'Optional secret for x-agylity-signature header'
            }
            value={secret}
            onInput={(e) => onSecretChange((e.target as HTMLInputElement).value)}
          />
          <button
            type="button"
            class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-xs font-medium text-pine-text transition-colors hover:bg-pine-highlight/50"
            onClick={() => setShowSecret(!showSecret)}
          >
            {showSecret ? 'Hide' : 'Show'}
          </button>
        </div>
        <span class="text-xs text-pine-subtle">
          When specified, Agylity signs each payload with HMAC-SHA256 in the x-agylity-signature
          header.
        </span>
      </div>

      <div class="flex items-center justify-between gap-4 border-t border-pine-highlight/40 pt-3">
        <div class="flex flex-col gap-0.5">
          <span class="text-xs font-semibold text-pine-text">Ping Owner</span>
          <span class="text-xs text-pine-subtle">
            Mentions your Discord user ID on quota alerts and test pings. Applies to Discord webhook
            URLs only; other endpoints receive the payload untouched.
          </span>
        </div>
        <ToggleSwitch
          checked={pingOwner}
          onChange={onPingOwnerChange}
          label={
            pingOwner
              ? 'Disable owner mention for this webhook'
              : 'Enable owner mention for this webhook'
          }
        />
      </div>
    </div>
  );
};
