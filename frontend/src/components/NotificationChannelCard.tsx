import {
  faChevronDown,
  faChevronRight,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import type { ComponentChildren } from 'preact';
import { Icon } from './Icon';

export type ChannelId = 'discord' | 'webhook' | 'console';

export interface ChannelDef {
  id: ChannelId;
  label: string;
  description: string;
  icon: IconDefinition;
  iconColor: string;
}

interface NotificationChannelCardProps {
  channel: ChannelDef;
  isEnabled: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onToggleChannel: () => void;
  children?: ComponentChildren;
}

export const NotificationChannelCard = ({
  channel,
  isEnabled,
  isExpanded,
  onToggleExpand,
  onToggleChannel,
  children,
}: NotificationChannelCardProps) => {
  return (
    <div
      class={`overflow-hidden rounded-xl border transition-all ${
        isEnabled
          ? 'border-pine-iris/50 bg-pine-surface shadow-xs'
          : 'border-pine-highlight bg-pine-surface/50 hover:border-pine-iris/50'
      }`}
    >
      {/* Card Header Row: Expand trigger + Icon/Label + Badges + Toggle Switch */}
      <div class="flex items-center justify-between gap-4 p-4 select-none md:p-5">
        <div
          class="flex min-w-0 flex-1 cursor-pointer items-center gap-3.5"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggleExpand();
            }
          }}
          onClick={onToggleExpand}
        >
          <span class="text-pine-muted transition-colors hover:text-pine-text" aria-hidden="true">
            <Icon icon={isExpanded ? faChevronDown : faChevronRight} class="size-3.5" />
          </span>

          <div class="flex min-w-0 items-center gap-3">
            <Icon icon={channel.icon} class={`size-4 shrink-0 ${channel.iconColor}`} />
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-semibold text-pine-text">{channel.label}</span>
                {isEnabled ? (
                  <span class="rounded-sm bg-pine-iris/15 px-2 py-0.5 text-xs font-semibold text-pine-iris uppercase">
                    Enabled
                  </span>
                ) : (
                  <span class="rounded-sm bg-pine-overlay px-2 py-0.5 text-xs font-medium text-pine-muted uppercase">
                    Off
                  </span>
                )}
              </div>
              <p class="text-xs text-pine-muted">{channel.description}</p>
            </div>
          </div>
        </div>

        {/* Right-aligned Toggle Switch */}
        <div class="flex shrink-0 items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={isEnabled}
            onClick={onToggleChannel}
            class={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
              isEnabled ? 'bg-pine-iris' : 'border-pine-highlight bg-pine-overlay'
            }`}
            title={isEnabled ? `Disable ${channel.label}` : `Enable ${channel.label}`}
          >
            <span
              aria-hidden="true"
              class={`pointer-events-none inline-block size-5 transform rounded-full bg-white shadow-xs ring-0 transition duration-200 ease-in-out ${
                isEnabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Nested Config Section: Expanded configuration */}
      {isExpanded && (
        <div class="border-t border-pine-highlight bg-pine-overlay/20 p-4 md:p-6">{children}</div>
      )}
    </div>
  );
};
