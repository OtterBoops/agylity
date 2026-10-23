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
        <p class="text-sm text-pine-subtle">{subtitle}</p>
      </div>

      <div class="flex items-center gap-3">
        <button
          type="button"
          class="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-pine-highlight bg-pine-surface px-3.5 py-1.5 text-sm font-medium text-pine-text transition-colors hover:bg-pine-overlay disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onRefresh}
          disabled={refreshCooldown > 0 || isRefreshing}
          title={
            refreshCooldown > 0
              ? `Rate limited: wait ${refreshCooldown}s`
              : 'Poll latest quota snapshots'
          }
        >
          {isRefreshing
            ? 'Refreshing...'
            : refreshCooldown > 0
              ? `Cooldown (${refreshCooldown}s)`
              : '↻ Refresh'}
        </button>

        <button
          type="button"
          class={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg px-4 py-1.5 text-sm font-semibold shadow-sm transition-all ${
            orchestratorEnabled
              ? 'bg-pine-iris text-pine-base hover:opacity-90'
              : 'border border-pine-highlight bg-pine-overlay text-pine-subtle hover:text-pine-text'
          }`}
          onClick={onOpenDispatch}
          title={
            orchestratorEnabled
              ? 'Dispatch continuation task to worker'
              : 'Orchestrator is disabled (operating in pure alerting mode). Click to view details.'
          }
        >
          {orchestratorEnabled ? '⚡ Dispatch Task' : '⚡ Dispatch (Off)'}
        </button>
      </div>
    </header>
  );
};
