interface NotificationActionBarProps {
  isDirty: boolean;
  isSaving: boolean;
  onReset: () => void;
}

export const NotificationActionBar = ({
  isDirty,
  isSaving,
  onReset,
}: NotificationActionBarProps) => {
  return (
    <div class="mt-2 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-pine-highlight bg-pine-surface p-4 shadow-sm">
      <div>
        {isDirty ? (
          <span class="text-xs font-medium text-pine-gold">Unsaved changes</span>
        ) : (
          <span class="text-xs text-pine-subtle">Settings saved</span>
        )}
      </div>

      <div class="flex items-center gap-3">
        <button
          type="button"
          onClick={onReset}
          disabled={!isDirty || isSaving}
          class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-4 py-2 text-xs font-medium text-pine-subtle transition-colors hover:text-pine-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          Reset
        </button>

        <button
          type="submit"
          disabled={!isDirty || isSaving}
          class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-xs font-semibold text-pine-base shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? 'Saving...' : 'Save changes'}
        </button>
      </div>
    </div>
  );
};
