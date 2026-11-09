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
    // The outer columns need a min-content floor: with a fixed 24rem search, 1fr sides collapse to
    // 0px between 768px and 900px and the view title disappears.
    <div class="grid h-10 grid-cols-[minmax(min-content,1fr)_minmax(0,24rem)_minmax(min-content,1fr)] items-center gap-3">
      <div class="flex min-w-0 items-center">
        <h1 class="truncate text-lg font-semibold tracking-tight text-pine-text sm:text-xl">
          {title}
        </h1>
      </div>

      <div class="flex items-center justify-center">
        {onOpenCommandPalette && (
          <button
            type="button"
            onClick={onOpenCommandPalette}
            class="flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg border border-pine-highlight bg-pine-surface px-3 text-xs text-pine-subtle transition-colors hover:border-pine-iris hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden sm:text-sm"
            title="Search commands and navigate views (Ctrl+K)"
            aria-label="Search commands, views, tasks (Ctrl+K)"
          >
            <Icon icon={faSearch} class="size-3.5 shrink-0 text-pine-iris" />
            <span class="min-w-0 flex-1 truncate text-left">Search commands, views, tasks...</span>
            <kbd class="hidden shrink-0 rounded-sm border border-pine-highlight bg-pine-overlay px-1.5 py-0.5 font-mono text-[11px] text-pine-subtle sm:inline-block">
              Ctrl K
            </kbd>
          </button>
        )}
      </div>

      <div class="flex shrink-0 items-center justify-end gap-2">
        {typeof remainingCredits === 'number' && (
          <div
            class="inline-flex h-9 items-center gap-1.5 rounded-lg border border-pine-highlight bg-pine-surface px-2.5 text-xs font-semibold text-pine-text"
            title="Available Google AI Credits / Flex Tokens"
          >
            <Icon icon={faCoins} class="size-3 text-pine-iris" />
            <span class="font-mono text-pine-iris">{remainingCredits}</span>
          </div>
        )}

        <button
          type="button"
          class="inline-flex size-9 cursor-pointer items-center justify-center rounded-lg border border-pine-highlight bg-pine-surface text-pine-iris transition-colors hover:bg-pine-overlay focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
          onClick={onOpenAuthModal}
          title="Configure Control-Plane Auth Token"
          aria-label="Configure Control-Plane Auth Token"
        >
          <Icon icon={faKey} class="size-3.5" />
        </button>

        <button
          type="button"
          class="inline-flex size-9 cursor-pointer items-center justify-center rounded-lg border border-pine-highlight bg-pine-surface text-pine-text transition-colors hover:bg-pine-overlay focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50"
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
