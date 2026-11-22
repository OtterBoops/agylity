import { useEffect } from 'preact/hooks';
import { clearAllDrafts, configStore, dirtyKeys, saveDrafts } from '../../state/configStore';
import { useStore } from '../../state/store';

export const UnsavedBar = () => {
  const { config, saving, error } = useStore(configStore);
  const dirty = dirtyKeys(config);
  const count = dirty.length;

  useEffect(() => {
    if (count === 0) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [count]);

  if (count === 0 && !saving && !error) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      class="flex flex-col gap-2 rounded-xl border border-pine-gold/40 bg-pine-gold/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div class="flex min-w-0 flex-col gap-0.5">
        <span class="text-sm font-semibold text-pine-gold">
          {count === 0 ? 'No unsaved changes' : `${count} unsaved change${count === 1 ? '' : 's'}`}
        </span>
        {error && (
          <span class="text-xs text-pine-love" role="alert">
            {error}
          </span>
        )}
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={clearAllDrafts}
          disabled={saving || count === 0}
          class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-4 py-2 text-xs font-medium text-pine-subtle transition-colors hover:text-pine-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          Discard all
        </button>
        <button
          type="button"
          onClick={() => {
            void saveDrafts().catch(() => undefined);
          }}
          disabled={saving || count === 0}
          class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-xs font-semibold text-pine-base transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-pine-overlay disabled:text-pine-subtle"
        >
          {saving ? 'Saving...' : 'Save all sections'}
        </button>
      </div>
    </div>
  );
};
