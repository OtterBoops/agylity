import {
  faChevronDown,
  faChevronRight,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import type { ComponentChildren } from 'preact';
import { Icon } from './Icon';
import { ToggleSwitch } from './ToggleSwitch';

export type ChannelId = 'discord' | 'webhook';

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
  testLabel: string;
  onSendTest: () => void;
  isTesting: boolean;
  children?: ComponentChildren;
}

export const NotificationChannelCard = ({
  channel,
  isEnabled,
  isExpanded,
  onToggleExpand,
  onToggleChannel,
  testLabel,
  onSendTest,
  isTesting,
  children,
}: NotificationChannelCardProps) => {
  return (
    <div
      class={`overflow-hidden rounded-xl border transition-all ${
        isEnabled
          ? 'border-pine-iris/50 bg-pine-surface'
          : 'border-pine-highlight bg-pine-surface/50 hover:border-pine-iris/50'
      }`}
    >
      <div class="flex items-center justify-between gap-4 p-4 select-none md:p-5">
        <button
          type="button"
          aria-expanded={isExpanded}
          aria-controls={`channel-config-${channel.id}`}
          onClick={onToggleExpand}
          class="flex min-w-0 flex-1 cursor-pointer items-center gap-3.5 rounded-lg text-left focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
        >
          <span class="text-pine-subtle transition-colors hover:text-pine-text" aria-hidden="true">
            <Icon icon={isExpanded ? faChevronDown : faChevronRight} class="size-3.5" />
          </span>

          <div class="flex min-w-0 items-center gap-3">
            <Icon icon={channel.icon} class={`size-4 shrink-0 ${channel.iconColor}`} />
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h3 class="text-sm font-semibold text-pine-text">{channel.label}</h3>
                {isEnabled ? (
                  <span class="rounded-sm bg-pine-iris/15 px-2 py-0.5 text-xs font-semibold text-pine-iris uppercase">
                    Enabled
                  </span>
                ) : (
                  <span class="rounded-sm bg-pine-overlay px-2 py-0.5 text-xs font-medium text-pine-subtle uppercase">
                    Off
                  </span>
                )}
              </div>
              <p class="text-xs text-pine-subtle">{channel.description}</p>
            </div>
          </div>
        </button>

        <div class="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={onSendTest}
            disabled={!isEnabled || isTesting}
            title={isEnabled ? testLabel : `Enable ${channel.label} to test`}
            class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-2.5 py-1 text-xs font-medium whitespace-nowrap text-pine-subtle transition-colors hover:border-pine-iris hover:text-pine-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-pine-highlight disabled:hover:text-pine-subtle"
          >
            {isTesting ? 'Testing...' : testLabel}
          </button>
          <ToggleSwitch
            checked={isEnabled}
            onChange={onToggleChannel}
            label={isEnabled ? `Disable ${channel.label}` : `Enable ${channel.label}`}
          />
        </div>
      </div>

      {isExpanded && (
        <div
          id={`channel-config-${channel.id}`}
          class="border-t border-pine-highlight bg-pine-overlay/20 p-4 md:p-6"
        >
          {children}
        </div>
      )}
    </div>
  );
};
