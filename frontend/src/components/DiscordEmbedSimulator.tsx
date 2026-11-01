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
    <div class="flex flex-col gap-3 rounded-xl border border-pine-highlight bg-pine-overlay/20 p-4 sm:p-5">
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-pine-highlight/60 pb-3">
        <div class="flex items-center gap-2">
          <Icon icon={faEye} class="size-3.5 text-pine-iris" />
          <h4 class="text-xs font-semibold tracking-wider text-pine-text uppercase">
            Live Embed Simulator
          </h4>
        </div>
        <div class="flex items-center gap-1.5 text-xs">
          <span class="text-[11px] text-pine-muted">Preview Tier:</span>
          <button
            type="button"
            onClick={() => onTierChange('alert')}
            class={`cursor-pointer rounded-sm px-2 py-0.5 text-[11px] font-medium transition-colors ${
              previewTier === 'alert'
                ? 'border border-pine-love/50 bg-pine-love/20 text-pine-love'
                : 'text-pine-subtle hover:text-pine-text'
            }`}
          >
            Critical (15%)
          </button>
          <button
            type="button"
            onClick={() => onTierChange('warning')}
            class={`cursor-pointer rounded-sm px-2 py-0.5 text-[11px] font-medium transition-colors ${
              previewTier === 'warning'
                ? 'border border-pine-gold/50 bg-pine-gold/20 text-pine-gold'
                : 'text-pine-subtle hover:text-pine-text'
            }`}
          >
            Warning (35%)
          </button>
          <button
            type="button"
            onClick={() => onTierChange('burn')}
            class={`cursor-pointer rounded-sm px-2 py-0.5 text-[11px] font-medium transition-colors ${
              previewTier === 'burn'
                ? 'border border-pine-iris/50 bg-pine-iris/20 text-pine-iris'
                : 'text-pine-subtle hover:text-pine-text'
            }`}
          >
            Ready (85%)
          </button>
        </div>
      </div>

      {/* Discord-style Embed Container */}
      <div class="rounded-lg bg-[#313338] p-4 font-sans text-xs text-[#dbdee1] shadow-inner">
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
          <span class="font-medium text-white">Agylity Quota Sentry</span>
          <span class="py-0.2 rounded-sm bg-[#5865F2] px-1 text-[9px] font-bold text-white uppercase">
            BOT
          </span>
          <span class="text-[10px] text-[#949ba4]">Today at 22:58</span>
        </div>

        {pingOwner && (
          <div class="mb-2 text-xs font-normal text-[#dbdee1]">
            <span class="rounded-sm bg-[#5865F2]/30 px-1 py-0.5 font-medium text-[#c9cdfb]">
              @{ownerUserId.trim() || 'owner'}
            </span>
          </div>
        )}

        <div
          class={`max-w-[520px] rounded-[4px] border-l-4 bg-[#2b2d31] p-3.5 shadow-sm ${
            previewTier === 'alert'
              ? 'border-[#eb6f92]'
              : previewTier === 'warning'
                ? 'border-[#f6c177]'
                : 'border-[#c4a7e7]'
          }`}
        >
          <div class="mb-1 text-sm font-bold text-white">
            [Alert] Quota Milestone: Claude 5.5 Sonnet / Opus
          </div>
          <div class="mb-3 text-xs text-[#dbdee1]">
            {pingOwner && (
              <>
                <span class="rounded-sm bg-[#5865F2]/30 px-1 py-0.5 font-medium text-[#c9cdfb]">
                  @{ownerUserId.trim() || 'owner'}
                </span>{' '}
              </>
            )}
            Milestone threshold:{' '}
            <strong>
              {previewTier === 'alert' ? '1h' : previewTier === 'warning' ? '3h' : '12h'}
            </strong>{' '}
            before quota reset.
          </div>

          <div class="mb-3 grid grid-cols-2 gap-3">
            <div>
              <div class="text-[10px] font-semibold text-[#949ba4] uppercase">Remaining Quota</div>
              <div class="mt-1 flex items-center gap-2">
                <span class="rounded-sm bg-[#1e1f22] px-1.5 py-0.5 font-mono text-xs text-[#dbdee1]">
                  {previewTier === 'alert'
                    ? '[■■□□□□□□□□]'
                    : previewTier === 'warning'
                      ? '[■■■■□□□□□□]'
                      : '[■■■■■■■■□□]'}
                </span>
                <strong class="font-sans text-xs text-white">
                  {previewTier === 'alert' ? '15%' : previewTier === 'warning' ? '35%' : '85%'}
                </strong>
              </div>
            </div>
            <div>
              <div class="text-[10px] font-semibold text-[#949ba4] uppercase">Reset Window</div>
              <div class="mt-1 text-xs text-white">
                {previewTier === 'alert'
                  ? 'Resets in 45m'
                  : previewTier === 'warning'
                    ? 'Resets in 2h 45m'
                    : 'Resets in 11h 30m'}
              </div>
            </div>
          </div>

          <div class="border-t border-[#3f4147] pt-2 text-[10px] text-[#949ba4]">
            Monitored Models:{' '}
            <span class="font-mono text-white">
              claude-sonnet-5-5, claude-opus-5-5, gemini-4-argon
            </span>
          </div>

          <div class="mt-2 text-[10px] text-[#949ba4]">Agylity Quota Sentry</div>
        </div>
      </div>
    </div>
  );
};
