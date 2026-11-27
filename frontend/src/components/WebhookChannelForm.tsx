import { useState } from 'preact/hooks';

const INPUT_CLASS =
  'rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text placeholder-pine-subtle transition-colors outline-none focus:border-pine-iris';

/** A stored secret arrives as the mask; the input stays empty and the placeholder says so. */
const MASKED = new Set(['••••••••', '********']);
const editable = (value: string): string => (MASKED.has(value.trim()) ? '' : value);

interface WebhookChannelFormProps {
  destinationId: string;
  url: string;
  onUrlChange: (val: string) => void;
  isUrlSet: boolean;
  secret: string;
  onSecretChange: (val: string) => void;
  isSecretSet: boolean;
  customHeaders: string;
  onCustomHeadersChange: (val: string) => void;
  isHeadersSet: boolean;
  ownerUserId?: string;
}

export const WebhookChannelForm = ({
  destinationId,
  url,
  onUrlChange,
  isUrlSet,
  secret,
  onSecretChange,
  isSecretSet,
  customHeaders,
  onCustomHeadersChange,
  isHeadersSet,
  ownerUserId = '',
}: WebhookChannelFormProps) => {
  const [showSecret, setShowSecret] = useState(false);

  return (
    <div class="flex flex-col gap-5">
      <div class="flex flex-col gap-1.5">
        <label
          class="flex items-center justify-between text-xs font-medium text-pine-subtle"
          for={`${destinationId}-url`}
        >
          <span class="flex items-center gap-1.5">
            Target Webhook URL
            <span class="text-xs text-pine-foam">(Encrypted at rest)</span>
          </span>
          {isUrlSet && <span class="font-mono text-xs text-pine-foam">Configured</span>}
        </label>
        <input
          id={`${destinationId}-url`}
          type="text"
          name={`agylity_${destinationId}_url`}
          autoComplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          class={INPUT_CLASS}
          placeholder={
            isUrlSet
              ? '•••••••• (stored — enter a new URL to replace)'
              : 'https://discord.com/api/webhooks/... or https://example.com/api/alert'
          }
          value={editable(url)}
          onInput={(e) => onUrlChange((e.target as HTMLInputElement).value)}
        />
        <span class="text-xs text-pine-subtle">
          Receives HTTP POST requests with JSON quota milestone payloads (Discord, Slack, &amp;
          generic endpoints supported).
        </span>
      </div>

      <div class="flex flex-col gap-1.5">
        <label
          class="flex items-center justify-between text-xs font-medium text-pine-subtle"
          for={`${destinationId}-secret`}
        >
          <span class="flex items-center gap-1.5">
            HMAC Secret Key (Optional)
            <span class="text-xs text-pine-foam">(Encrypted at rest)</span>
          </span>
          {isSecretSet && <span class="font-mono text-xs text-pine-foam">Configured</span>}
        </label>
        <div class="flex gap-2">
          <input
            id={`${destinationId}-secret`}
            type={showSecret ? 'text' : 'password'}
            name={`agylity_${destinationId}_secret`}
            autoComplete="new-password"
            data-1p-ignore="true"
            data-lpignore="true"
            class={`flex-1 ${INPUT_CLASS}`}
            placeholder={
              isSecretSet
                ? '•••••••• (stored — enter a new secret to replace)'
                : 'Optional secret for x-agylity-signature header'
            }
            value={editable(secret)}
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

      <div class="flex flex-col gap-1.5">
        <label
          class="flex items-center justify-between text-xs font-medium text-pine-subtle"
          for={`${destinationId}-headers`}
        >
          <span class="flex items-center gap-1.5">
            Custom Headers (Optional)
            <span class="text-xs text-pine-foam">(Encrypted at rest)</span>
          </span>
          {isHeadersSet && <span class="font-mono text-xs text-pine-foam">Configured</span>}
        </label>
        <textarea
          id={`${destinationId}-headers`}
          name={`agylity_${destinationId}_headers`}
          autoComplete="off"
          spellcheck={false}
          rows={3}
          data-1p-ignore="true"
          data-lpignore="true"
          class={`${INPUT_CLASS} resize-y font-mono text-xs`}
          placeholder={
            isHeadersSet
              ? '•••••••• (stored — enter new JSON to replace)'
              : '{"Authorization":"Bearer token"}'
          }
          value={editable(customHeaders)}
          onInput={(e) => onCustomHeadersChange((e.target as HTMLTextAreaElement).value)}
        />
        <span class="text-xs text-pine-subtle">
          A flat JSON object of string header values, sent with every delivery.
        </span>
      </div>

      <div class="border-t border-pine-highlight/40 pt-3 text-xs text-pine-subtle">
        {ownerUserId ? (
          <span>
            Owner mentions use the Discord-wide id{' '}
            <code class="font-mono text-pine-foam">&lt;@{ownerUserId}&gt;</code>. Discord webhook
            URLs only; other endpoints receive the payload untouched.
          </span>
        ) : (
          <span class="text-pine-gold">
            No owner id is configured, so ping owner sends no mention. Set one under Settings &gt;
            General.
          </span>
        )}
      </div>
    </div>
  );
};
