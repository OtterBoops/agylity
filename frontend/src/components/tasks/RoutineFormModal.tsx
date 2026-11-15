import { useEffect, useRef, useState } from 'preact/hooks';
import { faTimes } from '@fortawesome/free-solid-svg-icons';
import type { PrPolicy, ReasoningEffort, RepositoryConfig, RoutineTaskRecord } from '../../types';
import { createRoutine, updateRoutine } from '../../api';
import { EFFORT_OPTIONS } from '../../config/fields';
import { dialogBackdropClickHandler } from '../../utils/dialog';
import { Icon } from '../Icon';
import { ModelCascadeField, parseModelCascade } from './ModelCascadeField';
import type { NotifyTone } from './badges';

// An empty optional number means "use the server default". 0 is a real value here (it removes
// the floor), so `Number('') === 0` must never reach the create call.
const parseOptionalNumber = (
  raw: string,
  min: number,
  max: number
): number | undefined | 'invalid' => {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < min || value > max) return 'invalid';
  return value;
};

interface RoutineFormModalProps {
  /** Non-null edits that routine in place; null creates a new one. */
  routine: RoutineTaskRecord | null;
  repositories: RepositoryConfig[];
  defaultRepoId: string;
  defaultModel: string;
  defaultEffort: ReasoningEffort;
  defaultMinHeadroom: number;
  onClose: () => void;
  /** Called after a successful save so the page can reload and announce it. */
  onSaved: (message: string) => void | Promise<void>;
  notify: (tone: NotifyTone, message: string) => void;
}

export const RoutineFormModal = ({
  routine,
  repositories,
  defaultRepoId,
  defaultModel,
  defaultEffort,
  defaultMinHeadroom,
  onClose,
  onSaved,
  notify,
}: RoutineFormModalProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState(routine?.title ?? '');
  const [prompt, setPrompt] = useState(routine?.prompt ?? '');
  const [repositoryId, setRepositoryId] = useState(routine?.repositoryId ?? defaultRepoId);
  const [models, setModels] = useState(routine ? routine.models.join(', ') : defaultModel);
  const [effort, setEffort] = useState<ReasoningEffort>(routine?.effort ?? defaultEffort);
  const [triggerHours, setTriggerHours] = useState(
    routine ? String(routine.triggerBeforeResetHours) : '4'
  );
  const [minHeadroom, setMinHeadroom] = useState(
    routine ? String(routine.minHeadroomPercent) : String(defaultMinHeadroom)
  );
  const [verifyCommand, setVerifyCommand] = useState(routine?.verifyCommand ?? '');
  const [prPolicy, setPrPolicy] = useState<PrPolicy | ''>(routine?.prPolicy ?? '');

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    const cleanTitle = title.trim();
    const cleanPrompt = prompt.trim();
    if (!cleanTitle || !cleanPrompt) return;
    if (!(repositoryId || defaultRepoId)) {
      notify('error', 'Add a repository in Settings before creating routines.');
      return;
    }

    const parsedHours = parseOptionalNumber(triggerHours, 1, 24);
    const parsedHeadroom = parseOptionalNumber(minHeadroom, 1, 90);
    if (parsedHours === 'invalid' || parsedHeadroom === 'invalid') {
      notify('error', 'Trigger window must be 1-24h and headroom floor 1-90%.');
      return;
    }

    const chain = parseModelCascade(models);
    const resolvedModels = chain.length > 0 ? chain : [defaultModel];
    const resolvedRepo = repositoryId || defaultRepoId;

    setSaving(true);
    try {
      if (routine) {
        await updateRoutine(routine.id, {
          title: cleanTitle,
          prompt: cleanPrompt,
          repositoryId: resolvedRepo,
          models: resolvedModels,
          effort,
          triggerBeforeResetHours: parsedHours,
          minHeadroomPercent: parsedHeadroom,
          verifyCommand: verifyCommand.trim() || null,
          prPolicy: prPolicy || null,
        });
      } else {
        await createRoutine({
          title: cleanTitle,
          prompt: cleanPrompt,
          repositoryId: resolvedRepo,
          models: resolvedModels,
          effort,
          triggerBeforeResetHours: parsedHours,
          minHeadroomPercent: parsedHeadroom,
          verifyCommand: verifyCommand.trim() || undefined,
          prPolicy: prPolicy || undefined,
          enabled: true,
          autoCreatePr: true,
        });
      }
      await onSaved(`${routine ? 'Updated' : 'Created'} routine "${cleanTitle}"`);
      onClose();
    } catch (err: any) {
      notify(
        'error',
        `Failed to ${routine ? 'update' : 'create'} routine: ${err?.message || String(err)}`
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog
      id="routine-dialog"
      aria-labelledby="routineDialogTitle"
      aria-modal="true"
      ref={dialogRef}
      onClose={onClose}
      onClick={dialogBackdropClickHandler(dialogRef, onClose)}
      class="fixed inset-0 m-auto max-h-[85vh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl border border-pine-highlight bg-pine-surface p-5 text-pine-text shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-xs"
    >
      <div class="flex items-center justify-between border-b border-pine-highlight pb-3">
        <h2 id="routineDialogTitle" class="text-base font-bold text-pine-text">
          {routine ? 'Edit Maintenance Routine' : 'New Maintenance Routine'}
        </h2>
        <button
          type="button"
          aria-label="Close dialog"
          onClick={onClose}
          class="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-lg border border-pine-highlight text-pine-subtle transition-colors hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
        >
          <Icon icon={faTimes} class="size-4" />
        </button>
      </div>

      <form onSubmit={handleSubmit} class="mt-4 flex flex-col gap-3.5 text-xs">
        <div>
          <label class="mb-1 block font-medium text-pine-subtle">Routine Title</label>
          <input
            type="text"
            required
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            placeholder="e.g. Audit dependencies and latent race conditions"
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
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label class="mb-1 block font-medium text-pine-subtle">Trigger Before Reset</label>
            <div class="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                max={24}
                value={triggerHours}
                onInput={(e) => setTriggerHours((e.target as HTMLInputElement).value)}
                class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 font-mono text-pine-text focus:border-pine-iris focus:outline-hidden"
              />
              <span class="font-medium text-pine-subtle">hours</span>
            </div>
          </div>
          <div>
            <label class="mb-1 block font-medium text-pine-subtle">Min Headroom Floor</label>
            <div class="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                max={90}
                value={minHeadroom}
                onInput={(e) => setMinHeadroom((e.target as HTMLInputElement).value)}
                class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 font-mono text-pine-text focus:border-pine-iris focus:outline-hidden"
              />
              <span class="font-medium text-pine-subtle">%</span>
            </div>
          </div>
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
        <div>
          <label class="mb-1 block font-medium text-pine-subtle">
            PR Policy Override (optional)
          </label>
          <select
            value={prPolicy}
            onChange={(e) => setPrPolicy((e.target as HTMLSelectElement).value as PrPolicy | '')}
            class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-pine-text focus:border-pine-iris focus:outline-hidden"
          >
            <option value="">Inherit global policy</option>
            <option value="docs_only">Documentation only (*.md, docs/)</option>
            <option value="all">All files (Allow code &amp; doc PRs)</option>
            <option value="none">None (Disable PRs &amp; branch pushes)</option>
          </select>
        </div>
        <div>
          <label class="mb-1 block font-medium text-pine-subtle">Prompt Template</label>
          <textarea
            required
            rows={4}
            value={prompt}
            onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
            placeholder="Audit the codebase for errors, format reproduction tests, and submit a PR..."
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
            {routine ? 'Save Changes' : 'Create Routine'}
          </button>
        </div>
      </form>
    </dialog>
  );
};
