import { useState } from 'preact/hooks';
import type { ConfigData, ToastState } from '../types';
import { updateConfig } from '../api';
import { StatusBanner } from './StatusBanner';

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
  'bg-pine-overlay border border-pine-highlight text-pine-text rounded-lg px-3 py-2 text-sm outline-none focus:border-pine-iris transition-colors';

export const RepoEditor = ({ config, onSaved }: RepoEditorProps) => {
  const current: Repo[] = config.resolved?.repositories || [];
  const [newRepoInput, setNewRepoInput] = useState('');
  const [toast, setToast] = useState<ToastState | null>(null);
  const [isSaving, setIsSaving] = useState(false);

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
      setToast({ type: 'error', message: `Repository "${newRepo.id}" already exists.` });
      return;
    }

    setIsSaving(true);
    setToast(null);

    const updated = [...current, newRepo];
    try {
      await updateConfig({ repositories: updated });
      setNewRepoInput('');
      setToast({ type: 'success', message: `Added repository "${newRepo.name}".` });
      onSaved();
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Failed to add repository' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemoveRepo = async (id: string) => {
    setIsSaving(true);
    setToast(null);
    const updated = current.filter((r) => r.id !== id);
    try {
      await updateConfig({ repositories: updated });
      setToast({ type: 'success', message: 'Repository removed.' });
      onSaved();
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Failed to remove repository' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div class="mb-8 flex flex-col gap-5 rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
      <div>
        <h2 class="text-lg font-semibold text-pine-text">Repositories</h2>
        <p class="mt-0.5 text-xs text-pine-subtle">
          Connected target repositories for automated runner task execution.
        </p>
      </div>

      <form onSubmit={handleAddRepo} class="flex gap-2">
        <input
          type="text"
          class={`flex-1 ${inputClass}`}
          placeholder="e.g. OtterBoops/agylity or https://github.com/OtterBoops/agylity.git"
          value={newRepoInput}
          onInput={(e) => setNewRepoInput((e.target as HTMLInputElement).value)}
        />
        <button
          type="submit"
          disabled={isSaving || !newRepoInput.trim()}
          class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-sm font-semibold text-pine-base shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {isSaving ? 'Adding...' : 'Add Repository'}
        </button>
      </form>

      {current.length === 0 ? (
        <p class="text-sm text-pine-muted">No repositories configured yet.</p>
      ) : (
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          {current.map((r) => (
            <div
              key={r.id}
              class="flex flex-col justify-between gap-3 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-4"
            >
              <div>
                <div class="flex items-center justify-between">
                  <h4 class="font-semibold text-pine-text">{r.name}</h4>
                  <span class="rounded-sm bg-pine-surface px-2 py-0.5 font-mono text-xs text-pine-muted">
                    {r.defaultBranch || 'main'}
                  </span>
                </div>
                <p class="mt-1 font-mono text-xs text-pine-foam">{r.path}</p>
                {r.cloneUrl && <p class="mt-0.5 truncate text-xs text-pine-subtle">{r.cloneUrl}</p>}
              </div>
              <div class="flex justify-end border-t border-pine-highlight/50 pt-2">
                <button
                  type="button"
                  onClick={() => handleRemoveRepo(r.id)}
                  disabled={isSaving}
                  class="cursor-pointer rounded-sm border border-pine-love/30 bg-pine-love/10 px-2 py-1 text-xs font-medium text-pine-love hover:bg-pine-love hover:text-white disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {toast && <StatusBanner status={toast} />}
    </div>
  );
};
