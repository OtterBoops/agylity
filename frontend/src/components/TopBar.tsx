import { faBolt, faRotate } from '@fortawesome/free-solid-svg-icons';
import { Icon } from './Icon';

interface TopBarProps {
  title: string;
  subtitle: string;
  isRefreshing: boolean;
  refreshCooldown: number;
  orchestratorEnabled?: boolean;
  onRefresh: () => void;
  onOpenDispatch: () => void;
}

export const TopBar = ({
  title,
  subtitle,
  isRefreshing,
  refreshCooldown,
  orchestratorEnabled = false,
  onRefresh,
  onOpenDispatch,
}: TopBarProps) => {
  return (
    <header class="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-pine-highlight pb-4">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-pine-text">{title}</h1>
        {subtitle && <p class="text-sm text-pine-subtle">{subtitle}</p>}
      </div>

      <div class="flex items-center gap-3">
        <button
          type="button"
          class="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-pine-highlight bg-pine-surface px-3.5 py-1.5 text-sm font-medium text-pine-text transition-colors hover:bg-pine-overlay disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onRefresh}
          disabled={refreshCooldown > 0 || isRefreshing}
          title="Poll latest quota snapshots"
        >
          <Icon icon={faRotate} class={`size-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>

        {orchestratorEnabled && (
          <button
            type="button"
            class="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-pine-iris px-4 py-1.5 text-sm font-semibold text-pine-base shadow-xs transition-opacity hover:opacity-90"
            onClick={onOpenDispatch}
            title="Dispatch continuation task to worker"
          >
            <Icon icon={faBolt} class="size-3.5" />
            <span>Dispatch Task</span>
          </button>
        )}
      </div>
    </header>
  );
};
