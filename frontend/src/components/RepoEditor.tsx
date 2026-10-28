import { useState } from 'preact/hooks';
import type { ConfigData, ToastState } from '../types';
import { updateConfig } from '../api';

interface Repo {
  id: string;
  name: string;
  path: string;
  description?: string;
  defaultBranch?: string;
}

interface RepoEditorProps {
  config: ConfigData;
  onSaved: () => void;
}

const inputClass =
  'bg-pine-overlay border border-pine-highlight text-pine-text rounded-lg px-3 py-2 text-sm outline-none focus:border-pine-iris transition-colors';

export const RepoEditor = ({ config, onSaved }: RepoEditorProps) => {
  const current: Repo[] = config.resolved?.repositories || [];
  const [draft, setDraft] = useState<Repo[] | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const repos = draft ?? current;
  const update = (next: Repo[]) => setDraft(next);
  const patch = (i: number, p: Partial<Repo>) =>
    update(repos.map((r, idx) => (idx === i ? { ...r, ...p } : r)));

  const invalid = repos.some((r) => !r.id.trim() || !r.name.trim());
  const ids = repos.map((r) => r.id.trim());
  const duplicate = new Set(ids).size !== ids.length;

  const handleSave = async () => {
    setIsSaving(true);
    setToast(null);

    const clean = repos.map((r) => {
      const id = r.id.trim();
      const path = r.path?.trim() || (id ? `/repos/${id}` : '/repos');
      return {
        id,
        name: r.name.trim(),
        path,
        defaultBranch: r.defaultBranch?.trim() || 'main',
        ...(r.description?.trim() ? { description: r.description.trim() } : {}),
      };
    });

    updateConfig({ repositories: clean })
      .then(() => {
        setDraft(null);
        setToast({ type: 'success', message: 'Repositories saved.' });
        onSaved();
      })
      .catch((err) =>
        setToast({ type: 'error', message: err.message || 'Failed to save repositories' })
      )
      .finally(() => setIsSaving(false));
  };

  return (
    <div class="mb-8 flex flex-col gap-5 rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
      <div>
        <h2 class="text-lg font-semibold text-pine-text">Repositories</h2>
        <p class="mt-0.5 text-xs text-pine-subtle">
          Target workspaces for Discord and dashboard task dispatch.
        </p>
      </div>

      {repos.length === 0 && <p class="text-sm text-pine-muted">No repositories configured.</p>}

      <div class="flex flex-col gap-3">
        {repos.map((r, i) => (
          <div
            key={i}
            class="grid grid-cols-1 items-end gap-3 rounded-lg border border-pine-highlight/50 bg-pine-overlay/20 p-3 md:grid-cols-[1fr_1fr_2fr_auto]"
          >
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-medium text-pine-subtle">ID</label>
              <input
                class={inputClass}
                name={`agylity_repo_id_${i}`}
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                value={r.id}
                placeholder="agylity"
                onInput={(e) => {
                  const nextId = (e.target as HTMLInputElement).value;
                  const prevAuto = r.id ? `/repos/${r.id}` : '';
                  const isAuto = !r.path || r.path === prevAuto;
                  patch(i, {
                    id: nextId,
                    path: isAuto ? (nextId ? `/repos/${nextId.trim()}` : '') : r.path,
                  });
                }}
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-medium text-pine-subtle">Name</label>
              <input
                class={inputClass}
                name={`agylity_repo_name_${i}`}
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                value={r.name}
                placeholder="Agylity"
                onInput={(e) => patch(i, { name: (e.target as HTMLInputElement).value })}
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between">
                <label class="text-xs font-medium text-pine-subtle">In-container path</label>
                <span class="font-mono text-[10px] text-pine-muted">
                  auto: /repos/{r.id.trim() || 'id'}
                </span>
              </div>
              <input
                class={inputClass}
                name={`agylity_repo_path_${i}`}
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                value={r.path || (r.id.trim() ? `/repos/${r.id.trim()}` : '')}
                placeholder={`/repos/${r.id.trim() || 'id'}`}
                onInput={(e) => patch(i, { path: (e.target as HTMLInputElement).value })}
              />
            </div>
            <button
              type="button"
              class="cursor-pointer rounded-lg border border-pine-love/30 bg-pine-love/15 px-3 py-2 text-xs font-medium text-pine-love transition-colors hover:bg-pine-love hover:text-white"
              onClick={() => update(repos.filter((_, idx) => idx !== i))}
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <div class="flex items-center justify-between gap-3">
        <button
          type="button"
          class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm font-medium text-pine-text transition-colors hover:bg-pine-highlight/50"
          onClick={() => update([...repos, { id: '', name: '', path: '' }])}
        >
          + Add repository
        </button>
        <div class="flex items-center gap-3">
          {(invalid || duplicate) && draft && (
            <span class="text-xs text-pine-gold">
              {duplicate ? 'IDs must be unique' : 'ID and name are required'}
            </span>
          )}
          <button
            type="button"
            class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-sm font-semibold text-pine-base shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
            disabled={isSaving || !draft || invalid || duplicate}
            onClick={handleSave}
          >
            {isSaving ? 'Saving...' : 'Save repositories'}
          </button>
        </div>
      </div>

      {toast && (
        <div
          class={`rounded-lg border p-3 text-xs font-medium ${
            toast.type === 'success'
              ? 'border-pine-pine bg-pine-pine/20 text-pine-foam'
              : 'border-pine-love bg-pine-love/20 text-pine-love'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
};
