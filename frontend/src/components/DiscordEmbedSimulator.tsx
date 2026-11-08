/* impeccable-disable side-tab -- Discord webhook embeds require a 4px left accent border */
import { faEye } from '@fortawesome/free-solid-svg-icons';
import { Icon } from './Icon';

interface DiscordEmbedSimulatorProps {
  previewTier: 'alert' | 'warning' | 'burn';
  onTierChange: (tier: 'alert' | 'warning' | 'burn') => void;
  pingOwner: boolean;
  ownerUserId: string;
}

export const DiscordEmbedSimulator = ({
  previewTier,
  onTierChange,
  pingOwner,
  ownerUserId,
}: DiscordEmbedSimulatorProps) => {
  return (
    <div class="flex flex-col gap-3 border-t border-pine-highlight/60 pt-4">
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-pine-highlight/60 pb-3">
        <div class="flex items-center gap-2">
          <Icon icon={faEye} class="size-3.5 text-pine-iris" />
          <h4 class="text-xs font-semibold tracking-wider text-pine-text uppercase">
            Live Embed Simulator
          </h4>
        </div>
        <div class="flex items-center gap-1.5 text-xs">
          <span class="text-xs text-pine-subtle">Preview Tier:</span>
          <button
            type="button"
            onClick={() => onTierChange('alert')}
            class={`cursor-pointer rounded-sm px-2.5 py-1 text-xs transition-colors ${
              previewTier === 'alert'
                ? 'border border-pine-love bg-pine-love font-bold text-pine-base shadow-xs'
                : 'text-pine-subtle hover:text-pine-text'
            }`}
          >
            Critical (15%)
          </button>
          <button
            type="button"
            onClick={() => onTierChange('warning')}
            class={`cursor-pointer rounded-sm px-2.5 py-1 text-xs transition-colors ${
              previewTier === 'warning'
                ? 'border border-pine-gold bg-pine-gold font-bold text-pine-base shadow-xs'
                : 'text-pine-subtle hover:text-pine-text'
            }`}
          >
            Warning (35%)
          </button>
          <button
            type="button"
            onClick={() => onTierChange('burn')}
            class={`cursor-pointer rounded-sm px-2.5 py-1 text-xs transition-colors ${
              previewTier === 'burn'
                ? 'border border-pine-iris bg-pine-iris font-bold text-pine-base shadow-xs'
                : 'text-pine-subtle hover:text-pine-text'
            }`}
          >
            Ready (85%)
          </button>
        </div>
      </div>

      {/* Discord-style Embed Container */}
      <div class="py-1 font-sans text-xs text-pine-text">
        <div class="mb-2 flex items-center gap-2">
          <div class="flex size-7 items-center justify-center rounded-full bg-pine-iris/30 text-pine-iris">
            <svg viewBox="0 0 24 24" fill="none" class="size-3.5" aria-hidden="true">
              <path
                fill-rule="evenodd"
                clip-rule="evenodd"
                d="M10.882 1.441A1.25 1.25 0 0 1 13.118 1.441L22.118 19.441A1.25 1.25 0 0 1 21 21.25H17A1.25 1.25 0 0 1 15.882 20.559L13.727 16.25H10.273L8.118 20.559A1.25 1.25 0 0 1 7 21.25H3A1.25 1.25 0 0 1 1.882 19.441ZM11.598 9.899A0.45 0.45 0 0 1 12.402 9.899L13.652 12.399A0.45 0.45 0 0 1 13.25 13.05H10.75A0.45 0.45 0 0 1 10.348 12.399Z"
                fill="currentColor"
              />
            </svg>
          </div>
          <span class="font-medium text-pine-text">Agylity Quota Sentry</span>
          <span class="rounded-sm bg-pine-iris px-1.5 py-0.5 text-xs font-bold text-pine-base uppercase">
            BOT
          </span>
          <span class="text-xs text-pine-subtle">Today at 22:58</span>
        </div>

        {pingOwner && (
          <div class="mb-2 text-xs font-normal text-pine-text">
            <span class="rounded-sm bg-pine-overlay px-1.5 py-0.5 font-medium text-pine-iris">
              @{ownerUserId.trim() || 'owner'}
            </span>
          </div>
        )}

        <div class="max-w-[572px] border-y border-pine-highlight/60 py-3">
          <div class="mb-2 flex items-center gap-2">
            <span
              class={`rounded-sm px-2 py-0.5 text-xs font-bold uppercase ${
                previewTier === 'alert'
                  ? 'bg-pine-love text-pine-base'
                  : previewTier === 'warning'
                    ? 'bg-pine-gold text-pine-base'
                    : 'bg-pine-iris text-pine-base'
              }`}
            >
              {previewTier === 'alert'
                ? '[Alert]'
                : previewTier === 'warning'
                  ? '[Warning]'
                  : '[Notice]'}
            </span>
            <span class="text-sm font-bold text-pine-text">
              Quota Milestone: Claude 5.5 Sonnet / Opus
            </span>
          </div>
          <div class="mb-3 text-xs text-pine-text">
            Milestone threshold:{' '}
            <strong>
              {previewTier === 'alert' ? '1h' : previewTier === 'warning' ? '3h' : '12h'}
            </strong>{' '}
            before quota reset.
          </div>

          <div class="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <div class="text-xs font-semibold text-pine-subtle uppercase">Remaining Quota</div>
              <div class="mt-1 flex items-center gap-2">
                <span class="rounded-sm bg-pine-overlay px-1.5 py-0.5 font-mono text-xs text-pine-text">
                  {previewTier === 'alert'
                    ? '[■■□□□□□□□□]'
                    : previewTier === 'warning'
                      ? '[■■■■□□□□□□]'
                      : '[■■■■■■■■□□]'}
                </span>
                <strong class="font-sans text-xs text-pine-text">
                  {previewTier === 'alert' ? '15%' : previewTier === 'warning' ? '35%' : '85%'}
                </strong>
              </div>
            </div>
            <div>
              <div class="text-xs font-semibold text-pine-subtle uppercase">Reset Window</div>
              <div class="mt-1 text-xs text-pine-text">
                {previewTier === 'alert'
                  ? 'Resets in 45m'
                  : previewTier === 'warning'
                    ? 'Resets in 2h 45m'
                    : 'Resets in 11h 30m'}
              </div>
            </div>
          </div>

          <div class="border-t border-pine-highlight pt-2 text-xs text-pine-subtle">
            Monitored Models:{' '}
            <span class="font-mono text-pine-text">
              claude-sonnet-5-5, claude-opus-5-5, gemini-4-argon
            </span>
          </div>

          <div class="mt-2 text-xs text-pine-subtle">Agylity Quota Sentry</div>
        </div>
      </div>
    </div>
  );
};
