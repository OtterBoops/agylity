import { useEffect, useRef, useState } from 'preact/hooks';
import { faTimes } from '@fortawesome/free-solid-svg-icons';
import type { BacklogTaskRecord, ReasoningEffort, RepositoryConfig } from '../../types';
import { createBacklogTask, updateBacklogTask } from '../../api';
import { EFFORT_OPTIONS } from '../../config/fields';
import { dialogBackdropClickHandler } from '../../utils/dialog';
import { Icon } from '../Icon';
import { ToggleSwitch } from '../ToggleSwitch';
import { ModelCascadeField, parseModelCascade } from './ModelCascadeField';
import type { NotifyTone } from './badges';

interface BacklogFormModalProps {
  /** Non-null edits that work item in place; null creates a new one. */
  item: BacklogTaskRecord | null;
  repositories: RepositoryConfig[];
  defaultRepoId: string;
  defaultModel: string;
  defaultEffort: ReasoningEffort;
  onClose: () => void;
  /** Called after a successful save so the page can reload and announce it. */
  onSaved: (message: string) => void | Promise<void>;
  notify: (tone: NotifyTone, message: string) => void;
}

export const BacklogFormModal = ({
  item,
  repositories,
  defaultRepoId,
  defaultModel,
  defaultEffort,
  onClose,
  onSaved,
  notify,
}: BacklogFormModalProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState(item?.title ?? '');
  const [prompt, setPrompt] = useState(item?.prompt ?? '');
  const [repositoryId, setRepositoryId] = useState(item?.repositoryId ?? defaultRepoId);
  const [models, setModels] = useState(item ? item.models.join(', ') : defaultModel);
  const [effort, setEffort] = useState<ReasoningEffort>(item?.effort ?? defaultEffort);
  const [verifyCommand, setVerifyCommand] = useState(item?.verifyCommand ?? '');
  const [autoCreatePr, setAutoCreatePr] = useState(item?.autoCreatePr ?? true);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    const cleanTitle = title.trim();
    const cleanPrompt = prompt.trim();
    if (!cleanTitle || !cleanPrompt) return;
    if (!(repositoryId || defaultRepoId)) {
      notify('error', 'Add a repository in Settings before creating work items.');
      return;
    }

    const chain = parseModelCascade(models);
    const resolvedModels = chain.length > 0 ? chain : [defaultModel];
    const resolvedRepo = repositoryId || defaultRepoId;
    const cleanVerify = verifyCommand.trim();

    setSaving(true);
    try {
      if (item) {
        await updateBacklogTask(item.id, {
          title: cleanTitle,
          prompt: cleanPrompt,
          repositoryId: resolvedRepo,
          models: resolvedModels,
          effort,
          verifyCommand: cleanVerify || null,
          autoCreatePr,
        });
      } else {
        await createBacklogTask({
          title: cleanTitle,
          prompt: cleanPrompt,
          repositoryId: resolvedRepo,
          models: resolvedModels,
          effort,
          verifyCommand: cleanVerify || undefined,
          autoCreatePr,
        });
      }
      await onSaved(`${item ? 'Updated' : 'Created'} backlog task "${cleanTitle}"`);
      onClose();
    } catch (err: any) {
      notify(
        'error',
        `Failed to ${item ? 'update' : 'create'} backlog task: ${err?.message || String(err)}`
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog
      id="backlog-dialog"
      aria-labelledby="backlog-dialog-title"
      aria-modal="true"
      ref={dialogRef}
      onClose={onClose}
      onClick={dialogBackdropClickHandler(dialogRef, onClose)}
      class="fixed inset-0 m-auto max-h-[85vh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl border border-pine-highlight bg-pine-surface p-5 text-pine-text shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-xs"
    >
      <div class="flex items-center justify-between border-b border-pine-highlight pb-3">
        <h2 id="backlog-dialog-title" class="text-base font-bold wrap-break-word text-pine-text">
          {item ? 'Edit Backlog Work Item' : 'New Backlog Work Item'}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close backlog work item dialog"
          class="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-lg border border-pine-highlight text-pine-subtle hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
        >
          <Icon icon={faTimes} class="size-4" />
        </button>
      </div>

      <form onSubmit={handleSubmit} class="mt-4 flex flex-col gap-3.5 text-xs">
        <div>
          <label class="mb-1 block font-medium text-pine-subtle">Title</label>
          <input
            type="text"
            required
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            placeholder="e.g. Migrate database schema for payments"
            class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-pine-text focus:border-pine-iris focus:outline-hidden"
          />
        </div>
        <div>
          <label class="mb-1 block font-medium text-pine-subtle">Target Repository</label>
          <select
            value={repositoryId || defaultRepoId}
            onChange={(e) => setRepositoryId((e.target as HTMLSelectElement).value)}
            class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-pine-text focus:border-pine-iris focus:outline-hidden"
          >
            {repositories.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name || repo.id}
              </option>
            ))}
          </select>
        </div>

        <ModelCascadeField value={models} onChange={setModels} />

        <div>
          <label class="mb-1 block font-medium text-pine-subtle">Reasoning Effort</label>
          <select
            value={effort}
            onChange={(e) => setEffort((e.target as HTMLSelectElement).value as ReasoningEffort)}
            class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-pine-text focus:border-pine-iris focus:outline-hidden"
          >
            {EFFORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label class="mb-1 block font-medium text-pine-subtle">Verify Command (optional)</label>
          <input
            type="text"
            value={verifyCommand}
            onInput={(e) => setVerifyCommand((e.target as HTMLInputElement).value)}
            placeholder="npm test"
            class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 font-mono text-pine-text focus:border-pine-iris focus:outline-hidden"
          />
        </div>
        <div class="flex items-center justify-between gap-3 rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2">
          <span class="font-medium text-pine-subtle">Open a pull request on completion</span>
          <ToggleSwitch
            checked={autoCreatePr}
            label="Open a pull request on completion"
            size="sm"
            onChange={setAutoCreatePr}
          />
        </div>
        <div>
          <label class="mb-1 block font-medium text-pine-subtle">Task Prompt</label>
          <textarea
            required
            rows={5}
            value={prompt}
            onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
            placeholder="Detailed instructions for the autonomous coding agent..."
            class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 font-mono text-pine-text focus:border-pine-iris focus:outline-hidden"
          />
        </div>
        <div class="mt-2 flex items-center justify-end gap-2 border-t border-pine-highlight pt-3">
          <button
            type="button"
            onClick={onClose}
            class="cursor-pointer rounded-lg border border-pine-highlight px-3.5 py-1.5 font-medium text-pine-subtle hover:bg-pine-overlay"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            class="cursor-pointer rounded-lg bg-pine-iris px-4 py-1.5 font-bold text-pine-base shadow-xs hover:opacity-90 disabled:opacity-50"
          >
            {item ? 'Save Changes' : 'Create Work Item'}
          </button>
        </div>
      </form>
    </dialog>
  );
};
