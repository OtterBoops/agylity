import { faCoins, faKey, faRotate, faSearch } from '@fortawesome/free-solid-svg-icons';
import { Icon } from './Icon';

interface TopBarProps {
  title: string;
  isRefreshing: boolean;
  refreshCooldown: number;
  coordinatorEnabled?: boolean;
  remainingCredits?: number | null;
  onRefresh: () => void;
  onOpenCommandPalette?: () => void;
  onOpenAuthModal?: () => void;
}

export const TopBar = ({
  title,
  isRefreshing,
  refreshCooldown,
  remainingCredits,
  onRefresh,
  onOpenCommandPalette,
  onOpenAuthModal,
}: TopBarProps) => {
  return (
    <div class="grid min-h-13 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 sm:gap-4">
      <h1 class="min-w-0 text-lg font-semibold tracking-[-0.02em] text-pine-text sm:text-xl">
        {title}
      </h1>

      {onOpenCommandPalette && (
        <button
          type="button"
          onClick={onOpenCommandPalette}
          class="mx-auto flex w-full max-w-88 cursor-pointer items-center gap-2 rounded-lg border border-pine-highlight bg-pine-surface px-3 py-2 text-[0.95rem] text-pine-subtle transition-colors hover:border-pine-iris hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
          title="Search commands and navigate views (Ctrl+K)"
          aria-label="Search commands, views, tasks (Ctrl+K)"
        >
          <Icon icon={faSearch} class="size-3.5 shrink-0 text-pine-iris" />
          <span class="min-w-0 flex-1 truncate text-left">Search commands, views, tasks...</span>
          <kbd class="shrink-0 rounded-sm border border-pine-highlight bg-pine-overlay px-1.5 py-0.5 font-mono text-xs text-pine-subtle">
            Ctrl K
          </kbd>
        </button>
      )}

      <div class="flex shrink-0 items-center gap-1.5">
        {typeof remainingCredits === 'number' && (
          <div
            class="inline-flex items-center gap-1.5 rounded-lg border border-pine-highlight bg-pine-surface px-2 py-1 text-xs font-semibold text-pine-text"
            title="Available Google AI Credits / Flex Tokens"
          >
            <Icon icon={faCoins} class="size-3 text-pine-iris" />
            <span class="font-mono text-pine-iris">{remainingCredits}</span>
          </div>
        )}

        <button
          type="button"
          class="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-lg border border-pine-highlight bg-pine-surface p-2.5 text-pine-iris transition-colors hover:bg-pine-overlay focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
          onClick={onOpenAuthModal}
          title="Configure Control-Plane Auth Token"
          aria-label="Configure Control-Plane Auth Token"
        >
          <Icon icon={faKey} class="size-3.5" />
        </button>

        <button
          type="button"
          class="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-lg border border-pine-highlight bg-pine-surface p-2.5 text-pine-text transition-colors hover:bg-pine-overlay focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onRefresh}
          disabled={refreshCooldown > 0 || isRefreshing}
          title="Poll latest quota snapshots"
          aria-label="Poll latest quota snapshots"
        >
          <Icon icon={faRotate} class={`size-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>
    </div>
  );
};
