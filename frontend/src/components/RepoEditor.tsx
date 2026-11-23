import { useState } from 'preact/hooks';
import type { ConfigData } from '../types';
import { updateConfig } from '../api';
import { pushErrorToast, pushSuccessToast } from '../state/toastStore';

interface Repo {
  id: string;
  name: string;
  path: string;
  cloneUrl?: string;
  defaultBranch?: string;
}

interface RepoEditorProps {
  config: ConfigData;
  onSaved: () => void;
}

const inputClass =
  'bg-pine-overlay border border-pine-highlight text-pine-text placeholder-pine-subtle rounded-lg px-3 py-2 text-sm outline-none focus:border-pine-iris transition-colors';

const hasCustomPath = (repo: Repo): boolean =>
  repo.path !== '' && repo.path !== `/repos/${repo.id}`;

export const RepoEditor = ({ config, onSaved }: RepoEditorProps) => {
  const current: Repo[] = config.resolved?.repositories || [];
  const [newRepoInput, setNewRepoInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Repo | null>(null);

  const deriveRepo = (input: string): Repo => {
    const trimmed = input.trim();
    let derivedId = '';
    let derivedName = '';
    let cloneUrl = '';

    if (
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('git@')
    ) {
      cloneUrl = trimmed;
      const match = trimmed.match(/([^/:]+)\/([^/]+?)(?:\.git)?$/);
      if (match && match[2]) {
        derivedId = match[2];
        derivedName = `${match[1]}/${match[2]}`;
      } else {
        derivedId = trimmed.replace(/[^a-zA-Z0-9_-]/g, '_');
        derivedName = trimmed;
      }
    } else if (trimmed.includes('/')) {
      const parts = trimmed.split('/');
      derivedId = parts[1] || parts[0]!;
      derivedName = trimmed;
      cloneUrl = `https://github.com/${trimmed}.git`;
    } else {
      derivedId = trimmed;
      derivedName = trimmed;
    }

    return {
      id: derivedId,
      name: derivedName,
      path: `/repos/${derivedId}`,
      cloneUrl: cloneUrl || undefined,
      defaultBranch: 'main',
    };
  };

  const handleAddRepo = async (e: Event) => {
    e.preventDefault();
    if (!newRepoInput.trim()) return;

    const newRepo = deriveRepo(newRepoInput);
    if (current.some((r) => r.id === newRepo.id)) {
      pushErrorToast('Could not add repository', `Repository "${newRepo.id}" already exists.`);
      return;
    }

    setIsSaving(true);

    const updated = [...current, newRepo];
    try {
      await updateConfig({ repositories: updated });
      setNewRepoInput('');
      pushSuccessToast('Repository added', `Added repository "${newRepo.name}".`);
      onSaved();
    } catch (err: any) {
      pushErrorToast('Could not add repository', err?.message || 'Failed to add repository');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemoveRepo = async (id: string) => {
    setIsSaving(true);
    const updated = current.filter((r) => r.id !== id);
    try {
      await updateConfig({ repositories: updated });
      pushSuccessToast('Repository removed');
      onSaved();
    } catch (err: any) {
      pushErrorToast('Could not remove repository', err?.message || 'Failed to remove repository');
    } finally {
      setIsSaving(false);
    }
  };

  const startEditRepo = (repo: Repo) => {
    setEditingId(repo.id);
    setDraft({
      ...repo,
      cloneUrl: repo.cloneUrl || '',
      defaultBranch: repo.defaultBranch || 'main',
    });
  };

  const cancelEditRepo = () => {
    setEditingId(null);
    setDraft(null);
  };

  const updateDraft = (patch: Partial<Repo>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const handleSaveRepo = async (e: Event) => {
    e.preventDefault();
    if (!editingId || !draft) return;

    setIsSaving(true);

    const entry: Repo = {
      ...draft,
      name: draft.name.trim(),
      path: draft.path.trim(),
      cloneUrl: draft.cloneUrl?.trim() || undefined,
      defaultBranch: draft.defaultBranch?.trim() || 'main',
    };
    const updated = current.map((r) => (r.id === editingId ? entry : r));
    try {
      await updateConfig({ repositories: updated });
      setEditingId(null);
      setDraft(null);
      pushSuccessToast('Repository updated', `Updated repository "${entry.name}".`);
      onSaved();
    } catch (err: any) {
      pushErrorToast('Could not update repository', err?.message || 'Failed to update repository');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div class="mb-8 flex flex-col gap-5 rounded-xl border border-pine-highlight bg-pine-surface p-6">
      <form onSubmit={handleAddRepo} class="flex flex-col gap-2 sm:flex-row">
        <input
          id="repo-input"
          aria-label="Repository name or Git clone URL"
          type="text"
          class={`flex-1 ${inputClass}`}
          placeholder="e.g. OtterBoops/agylity or https://github.com/OtterBoops/agylity.git"
          value={newRepoInput}
          onInput={(e) => setNewRepoInput((e.target as HTMLInputElement).value)}
        />
        <button
          type="submit"
          disabled={isSaving || !newRepoInput.trim()}
          class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-sm font-semibold text-pine-base transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-pine-overlay disabled:text-pine-subtle"
        >
          {isSaving ? 'Adding...' : 'Add Repository'}
        </button>
      </form>

      {current.length === 0 ? (
        <p class="text-sm text-pine-subtle">No repositories configured yet.</p>
      ) : (
        <div class="flex flex-col divide-y divide-pine-highlight/40 border-t border-pine-highlight/40">
          {current.map((r) =>
            editingId === r.id && draft ? (
              <form
                key={r.id}
                onSubmit={handleSaveRepo}
                aria-label={`Edit repository ${r.name}`}
                class="flex flex-col gap-2 py-3"
              >
                <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <input
                    aria-label="Repository name"
                    type="text"
                    class={`${inputClass} font-mono`}
                    placeholder="Name"
                    value={draft.name}
                    onInput={(e) => updateDraft({ name: (e.target as HTMLInputElement).value })}
                  />
                  <input
                    aria-label="Repository path"
                    type="text"
                    class={`${inputClass} font-mono`}
                    placeholder="Path"
                    value={draft.path}
                    onInput={(e) => updateDraft({ path: (e.target as HTMLInputElement).value })}
                  />
                  <input
                    aria-label="Default branch"
                    type="text"
                    class={`${inputClass} font-mono`}
                    placeholder="main"
                    value={draft.defaultBranch || ''}
                    onInput={(e) =>
                      updateDraft({ defaultBranch: (e.target as HTMLInputElement).value })
                    }
                  />
                  <input
                    aria-label="Git clone URL"
                    type="text"
                    class={`${inputClass} font-mono`}
                    placeholder="Git clone URL"
                    value={draft.cloneUrl || ''}
                    onInput={(e) => updateDraft({ cloneUrl: (e.target as HTMLInputElement).value })}
                  />
                </div>
                <div class="flex items-center gap-2">
                  <button
                    type="submit"
                    disabled={isSaving}
                    class="cursor-pointer rounded-lg bg-pine-iris px-3 py-1.5 text-xs font-semibold text-pine-base transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden disabled:cursor-not-allowed disabled:bg-pine-overlay disabled:text-pine-subtle"
                  >
                    {isSaving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={cancelEditRepo}
                    disabled={isSaving}
                    class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-semibold text-pine-text transition-colors hover:bg-pine-highlight focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div
                key={r.id}
                class="flex flex-col gap-2 py-3 lg:flex-row lg:items-center lg:justify-between"
              >
                <div class="flex min-w-0 flex-wrap items-center gap-2">
                  {r.cloneUrl ? (
                    <a
                      href={r.cloneUrl}
                      target="_blank"
                      rel="noreferrer"
                      title={r.cloneUrl}
                      class="font-mono text-sm font-semibold text-pine-text hover:text-pine-iris hover:underline"
                    >
                      {r.name}
                    </a>
                  ) : (
                    <span class="font-mono text-sm font-semibold text-pine-text">{r.name}</span>
                  )}
                  {r.defaultBranch && (
                    <span class="rounded-sm bg-pine-overlay px-2 py-0.5 font-mono text-xs whitespace-nowrap text-pine-subtle">
                      {r.defaultBranch}
                    </span>
                  )}
                  {hasCustomPath(r) && (
                    <span class="rounded-sm bg-pine-overlay/60 px-2 py-0.5 font-mono text-xs text-pine-foam">
                      {r.path}
                    </span>
                  )}
                </div>
                <div class="flex items-center gap-2 self-start lg:self-auto">
                  <button
                    type="button"
                    onClick={() => startEditRepo(r)}
                    disabled={isSaving}
                    aria-label={`Edit repository ${r.name}`}
                    class="cursor-pointer rounded-sm border border-pine-highlight bg-pine-overlay px-2.5 py-1 text-xs font-medium whitespace-nowrap text-pine-text hover:bg-pine-highlight focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden disabled:opacity-50"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveRepo(r.id)}
                    disabled={isSaving}
                    class="cursor-pointer rounded-sm border border-pine-love/30 bg-pine-love/10 px-2.5 py-1 text-xs font-medium whitespace-nowrap text-pine-love hover:bg-pine-love hover:text-pine-base focus-visible:ring-2 focus-visible:ring-pine-love focus-visible:outline-hidden disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
};
