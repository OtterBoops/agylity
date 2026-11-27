import {
  faChevronDown,
  faChevronRight,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import type { ComponentChildren } from 'preact';
import type { NotificationDestination } from '../types';
import { Icon } from './Icon';
import { ToggleSwitch } from './ToggleSwitch';

interface NotificationChannelCardProps {
  destination: NotificationDestination;
  typeLabel: string;
  icon: IconDefinition;
  iconColor: string;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onLabelChange: (label: string) => void;
  onToggleEnabled: () => void;
  onTogglePingOwner: () => void;
  onSendTest: () => void;
  isTesting: boolean;
  onRemove: () => void;
  testResult: { success: boolean; message: string } | null;
  children?: ComponentChildren;
}

export const NotificationChannelCard = ({
  destination,
  typeLabel,
  icon,
  iconColor,
  isExpanded,
  onToggleExpand,
  onLabelChange,
  onToggleEnabled,
  onTogglePingOwner,
  onSendTest,
  isTesting,
  onRemove,
  testResult,
  children,
}: NotificationChannelCardProps) => {
  const panelId = `destination-config-${destination.id}`;
  const name = destination.label.trim() || typeLabel;

  return (
    <div
      class={`overflow-hidden rounded-xl border transition-all ${
        destination.enabled
          ? 'border-pine-iris/50 bg-pine-surface'
          : 'border-pine-highlight bg-pine-surface/50 hover:border-pine-iris/50'
      }`}
    >
      <div class="flex flex-col gap-3 p-4 md:p-5">
        <div class="flex flex-wrap items-center gap-3">
          <button
            type="button"
            aria-expanded={isExpanded}
            aria-controls={panelId}
            aria-label={isExpanded ? 'Collapse configuration' : 'Expand configuration'}
            onClick={onToggleExpand}
            class="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-pine-subtle transition-colors hover:bg-pine-overlay hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
          >
            <Icon icon={isExpanded ? faChevronDown : faChevronRight} class="size-3.5" />
          </button>

          <Icon icon={icon} class={`size-4 shrink-0 ${iconColor}`} />

          <input
            type="text"
            aria-label={`${typeLabel} destination label`}
            class="min-w-32 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm font-semibold text-pine-text placeholder-pine-subtle transition-colors outline-none hover:border-pine-highlight focus:border-pine-iris"
            value={destination.label}
            placeholder={typeLabel}
            onInput={(e) => onLabelChange((e.target as HTMLInputElement).value)}
          />

          <span class="shrink-0 rounded-sm bg-pine-overlay px-2 py-0.5 font-mono text-xs font-medium whitespace-nowrap text-pine-subtle uppercase">
            {typeLabel}
          </span>

          <ToggleSwitch
            checked={destination.enabled}
            onChange={onToggleEnabled}
            label={destination.enabled ? `Disable ${name}` : `Enable ${name}`}
          />
        </div>

        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-pine-highlight/60 pt-3">
          <div class="flex items-center gap-2">
            <span class="text-xs font-medium text-pine-subtle">Ping owner</span>
            <ToggleSwitch
              checked={destination.pingOwner}
              onChange={onTogglePingOwner}
              label={`${destination.pingOwner ? 'Disable' : 'Enable'} owner mention for ${name}`}
              size="sm"
            />
          </div>

          <div class="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onSendTest}
              disabled={isTesting || !destination.enabled}
              title={destination.enabled ? 'Send a test notification' : `Enable ${name} to test`}
              class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-2.5 py-1 text-xs font-medium whitespace-nowrap text-pine-subtle transition-colors hover:border-pine-iris hover:text-pine-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-pine-highlight disabled:hover:text-pine-subtle"
            >
              {isTesting ? 'Testing...' : 'Test'}
            </button>
            <button
              type="button"
              onClick={onRemove}
              class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-2.5 py-1 text-xs font-medium whitespace-nowrap text-pine-subtle transition-colors hover:border-pine-love/60 hover:text-pine-love"
            >
              Remove
            </button>
          </div>
        </div>

        {testResult && (
          <div
            role="status"
            class={`flex items-start gap-2.5 rounded-lg border p-3 text-xs ${
              testResult.success
                ? 'border-pine-foam/40 bg-pine-foam/10 text-pine-foam'
                : 'border-pine-love/40 bg-pine-love/10 text-pine-love'
            }`}
          >
            <span class="font-mono text-xs font-bold tracking-wider uppercase">
              [{testResult.success ? 'Success' : 'Error'}]
            </span>
            <span class="min-w-0 flex-1 wrap-break-word">{testResult.message}</span>
          </div>
        )}
      </div>

      {isExpanded && (
        <div id={panelId} class="border-t border-pine-highlight bg-pine-overlay/20 p-4 md:p-6">
          {children}
        </div>
      )}
    </div>
  );
};
