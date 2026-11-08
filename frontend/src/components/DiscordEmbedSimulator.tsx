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
  const tierLabel =
    previewTier === 'alert' ? 'Alert' : previewTier === 'warning' ? 'Warning' : 'Notice';
  const tierPercent = previewTier === 'alert' ? 15 : previewTier === 'warning' ? 39 : 85;
  const tierHours = previewTier === 'alert' ? '1h' : previewTier === 'warning' ? '12h' : '24h';
  const tierReset =
    previewTier === 'alert'
      ? 'in 45 minutes ( 16:15 )'
      : previewTier === 'warning'
        ? 'in 19 hours ( 03:30 )'
        : 'in 11 hours ( 02:30 )';
  const tierBars =
    previewTier === 'alert'
      ? '▰▰▱▱▱▱▱▱▱▱'
      : previewTier === 'warning'
        ? '▰▰▰▰▱▱▱▱▱▱'
        : '▰▰▰▰▰▰▰▰▱▱';
  const tierAccent =
    previewTier === 'alert' ? '#ee82a0' : previewTier === 'warning' ? '#f6c177' : '#c4a7e7';

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
            Warning (39%)
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

      {/* Discord Native Message Simulator */}
      <div class="rounded-lg bg-[#313338] p-4 font-sans text-xs text-[#dbdee1] select-none">
        {/* Timestamp and Mention Header */}
        <div class="mb-2 flex items-center gap-2 text-xs">
          <span class="text-[11px] text-[#949ba4]">15:31</span>
          {pingOwner && (
            <span class="rounded-sm bg-[#5865f2]/20 px-1 py-0.5 font-semibold text-[#c9cdfb]">
              @{ownerUserId.trim() || 'Otter'}
            </span>
          )}
        </div>

        {/* Discord Native Embed Card */}
        <div
          class="w-full max-w-[480px] rounded-[4px] bg-[#2b2d31] px-4 py-3 shadow-sm"
          style={{ borderLeft: `4px solid ${tierAccent}` }}
        >
          {/* Clean Pool Title (No percentage in title) */}
          <div class="mb-1 text-sm/snug font-bold text-white">
            [{tierLabel}] Claude and GPT models
          </div>

          {/* Milestone Description */}
          <div class="mb-2.5 text-xs text-[#dbdee1]">
            Crossed the <strong class="font-bold text-white">{tierHours}</strong> milestone before
            reset.
          </div>

          {/* Weekly Quota Bar & Percentage moved to bottom */}
          <div class="mb-1.5 flex items-center gap-2">
            <span class="rounded-sm bg-[#1e1f22] px-1.5 py-0.5 font-mono text-xs text-[#dbdee1]">
              {tierBars}
            </span>
            <strong class="text-xs font-bold text-white">{tierPercent}% remaining</strong>
            <span class="text-[11px] text-[#949ba4]">(weekly)</span>
          </div>

          {/* Subtext: Reset countdown */}
          <div class="mb-2.5 text-[11px] text-[#949ba4]">
            weekly · resets{' '}
            <span class="rounded-sm bg-[#383a40] px-1 py-0.5 text-[#dbdee1]">{tierReset}</span>
          </div>

          {/* Model Chips & Footer */}
          <div class="flex items-center justify-between border-t border-[#35373c] pt-2 text-[11px] text-[#949ba4]">
            <div class="flex flex-wrap items-center gap-1">
              <span class="rounded-sm bg-[#1e1f22] px-1 font-mono">Claude Opus</span>
              <span>•</span>
              <span class="rounded-sm bg-[#1e1f22] px-1 font-mono">Claude Sonnet</span>
              <span>•</span>
              <span class="rounded-sm bg-[#1e1f22] px-1 font-mono">GPT-OSS</span>
            </div>
            <span class="text-[10px]">Agylity v0.4.2</span>
          </div>
        </div>
      </div>
    </div>
  );
};
