interface BulkActionBarProps {
  selectedCount: number;
  busy: boolean;
  onStopAndPause: () => void;
  onRetryFailed: () => void;
  onClear: () => void;
  note?: string | null;
}

export const BulkActionBar = ({
  selectedCount,
  busy,
  onStopAndPause,
  onRetryFailed,
  onClear,
  note,
}: BulkActionBarProps) => {
  if (selectedCount === 0) return null;
  const actionsDisabled = busy;

  return (
    <div
      role="toolbar"
      aria-label="Bulk task actions"
      class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-pine-highlight bg-pine-surface px-3 py-2.5 sm:px-4"
    >
      <div class="flex min-w-0 flex-col gap-1">
        <span class="text-xs font-semibold whitespace-nowrap text-pine-text">
          {selectedCount} selected
        </span>
        {note ? <span class="text-xs text-pine-subtle">{note}</span> : null}
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onStopAndPause}
          disabled={actionsDisabled}
          class="min-h-11 cursor-pointer rounded-lg border border-pine-love/40 bg-pine-love/10 px-3 text-xs font-semibold whitespace-nowrap text-pine-love transition-colors hover:bg-pine-love hover:text-pine-base disabled:cursor-not-allowed disabled:opacity-40"
        >
          Stop &amp; Pause
        </button>

        <button
          type="button"
          onClick={onRetryFailed}
          disabled={actionsDisabled}
          class="min-h-11 cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 text-xs font-semibold whitespace-nowrap text-pine-text transition-colors hover:bg-pine-highlight disabled:cursor-not-allowed disabled:opacity-40"
        >
          Retry failed
        </button>

        <button
          type="button"
          onClick={onClear}
          disabled={busy}
          class="min-h-11 cursor-pointer rounded-lg px-2 text-xs font-medium whitespace-nowrap text-pine-subtle transition-colors hover:text-pine-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          Clear
        </button>
      </div>
    </div>
  );
};
