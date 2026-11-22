import { faChevronDown } from '@fortawesome/free-solid-svg-icons';
import { useEffect, useState } from 'preact/hooks';
import { PR_POLICY_OPTIONS, resolveModelEffort } from '../../config/fields';
import { useModelCatalog } from '../../state/modelCatalogStore';
import type {
  BacklogTaskRecord,
  CascadeHop,
  PrPolicy,
  RoutineTaskRecord,
  SwarmTask,
} from '../../types';
import { Icon } from '../Icon';
import { ModelCascadeField } from './ModelCascadeField';

export type ComposerMode = 'run' | 'backlog' | 'routine';

/** `verifyCommand` is absent when blank; an edit that must clear it passes `null` through. */
export type ComposerPayload =
  | {
      mode: 'run';
      repositoryId: string;
      repositoryName: string;
      title: string;
      prompt: string;
      cascade: CascadeHop[];
      prPolicy: PrPolicy;
      autoCreatePr: boolean;
      verifyCommand?: string;
      scheduleMode: 'immediate';
    }
  | {
      mode: 'backlog';
      id?: string;
      repositoryId: string;
      title: string;
      prompt: string;
      cascade: CascadeHop[];
      autoCreatePr: boolean;
      verifyCommand?: string | null;
      priorityOrder: number;
    }
  | {
      mode: 'routine';
      id?: string;
      repositoryId: string;
      title: string;
      prompt: string;
      cascade: CascadeHop[];
      prPolicy: PrPolicy;
      autoCreatePr: boolean;
      verifyCommand?: string | null;
      triggerBeforeResetHours: number;
      minHeadroomPercent: number;
    };

export interface ComposerInitial {
  mode: ComposerMode;
  task?: SwarmTask;
  backlog?: BacklogTaskRecord;
  routine?: RoutineTaskRecord;
}

interface UnifiedTaskComposerProps {
  initial?: ComposerInitial;
  repositories: Array<{ id: string; name: string }>;
  defaultModel: string;
  headroomPercent?: number | null;
  submitting: boolean;
  error: string | null;
  onSubmit: (payload: ComposerPayload) => void;
  onCancel: () => void;
  /** Lets the drawer arm its discard guard: Esc must not silently drop a draft. */
  onDirtyChange?: (dirty: boolean) => void;
}

const MODE_LABELS: Record<ComposerMode, string> = {
  run: 'Run Now',
  backlog: 'Backlog',
  routine: 'Routine',
};

const MODES: ComposerMode[] = ['run', 'backlog', 'routine'];

const fieldClass =
  'w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris';
const labelClass = 'text-xs font-medium text-pine-subtle';
const hintClass = 'text-xs text-pine-subtle';

const PR_POLICY_HINTS: Record<PrPolicy, string> = {
  docs_only: 'PRs allowed for docs only — code changes ship as an issue',
  issues_only: 'issues only — no code changes or PRs; file GitHub Issues',
  all: 'all files — code and doc changes open a PR',
  none: 'none — no pull requests, no branch pushes',
};

const parseBounded = (raw: string, min: number, max: number): number | null => {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  return value;
};

export const UnifiedTaskComposer = ({
  initial,
  repositories,
  defaultModel,
  headroomPercent,
  submitting,
  error,
  onSubmit,
  onCancel,
  onDirtyChange,
}: UnifiedTaskComposerProps) => {
  const catalog = useModelCatalog();
  const { task, backlog, routine } = initial ?? {};
  const lockedMode: ComposerMode | null = backlog
    ? 'backlog'
    : routine
      ? 'routine'
      : task
        ? 'run'
        : null;

  const singleRepoId = repositories.length === 1 ? repositories[0].id : '';
  const seedCascade: CascadeHop[] = backlog?.cascade?.length
    ? backlog.cascade
    : routine?.cascade?.length
      ? routine.cascade
      : task?.cascade?.length
        ? task.cascade
        : task?.model
          ? [{ model: task.model, effort: task.effort }]
          : [
              {
                model: defaultModel,
                effort: resolveModelEffort(catalog.models, defaultModel).defaultEffort,
              },
            ];
  // A backlog row has no PR policy column: its stored autoCreatePr is the whole intent.
  const seedPrPolicy: PrPolicy =
    routine?.prPolicy ??
    task?.prPolicy ??
    (backlog ? (backlog.autoCreatePr === false ? 'none' : 'docs_only') : 'docs_only');
  const seedVerify = (backlog?.verifyCommand ?? routine?.verifyCommand ?? task?.verifyCommand ?? '')
    .toString()
    .trim();
  const seedPriority = backlog?.priorityOrder ?? 0;
  const seedRepo = backlog?.repositoryId ?? routine?.repositoryId ?? task?.repositoryId ?? '';
  const seedTitle = backlog?.title ?? routine?.title ?? task?.title ?? '';
  const seedPrompt = backlog?.prompt ?? routine?.prompt ?? task?.prompt ?? '';
  const seedTriggerHours = String(routine?.triggerBeforeResetHours ?? 4);
  const seedMinHeadroom = String(routine?.minHeadroomPercent ?? 10);

  const [mode, setMode] = useState<ComposerMode>(lockedMode ?? initial?.mode ?? 'run');
  const [repositoryId, setRepositoryId] = useState(seedRepo || singleRepoId);
  const [title, setTitle] = useState(seedTitle);
  const [prompt, setPrompt] = useState(seedPrompt);
  const [cascade, setCascade] = useState<CascadeHop[]>(seedCascade);
  const [prPolicy, setPrPolicy] = useState<PrPolicy>(seedPrPolicy);
  const [verifyCommand, setVerifyCommand] = useState(seedVerify);
  const [priority, setPriority] = useState(String(seedPriority));
  const [triggerHours, setTriggerHours] = useState(seedTriggerHours);
  const [minHeadroom, setMinHeadroom] = useState(seedMinHeadroom);
  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(initial && (seedVerify !== '' || seedPriority !== 0))
  );

  const isLocked = lockedMode !== null;
  const isEditing = Boolean(backlog || routine);

  // Compared as a fingerprint so a re-created cascade array does not read as an edit.
  const draftFingerprint = JSON.stringify([
    repositoryId,
    title,
    prompt,
    cascade,
    prPolicy,
    verifyCommand,
    priority,
    triggerHours,
    minHeadroom,
  ]);
  // Frozen on mount: draft state is seeded once, so late catalog/repo arrival is not an edit.
  const [seedFingerprint] = useState(() =>
    JSON.stringify([
      seedRepo || singleRepoId,
      seedTitle,
      seedPrompt,
      seedCascade,
      seedPrPolicy,
      seedVerify,
      String(seedPriority),
      seedTriggerHours,
      seedMinHeadroom,
    ])
  );
  const draftDirty = draftFingerprint !== seedFingerprint;

  useEffect(() => {
    onDirtyChange?.(draftDirty);
  }, [draftDirty, onDirtyChange]);
  const repoOptions =
    repositoryId === '' || repositories.some((repo) => repo.id === repositoryId)
      ? repositories
      : [...repositories, { id: repositoryId, name: `${repositoryId} (not in config)` }];

  const triggerHoursValue = parseBounded(triggerHours, 1, 24);
  const minHeadroomValue = parseBounded(minHeadroom, 1, 90);
  const routineBoundsValid = triggerHoursValue !== null && minHeadroomValue !== null;
  const ready = repositoryId !== '' && title.trim() !== '' && prompt.trim() !== '';
  const submitDisabled = submitting || !ready || (mode === 'routine' && !routineBoundsValid);

  const submitLabel = submitting
    ? 'Saving...'
    : isEditing
      ? 'Save Changes'
      : mode === 'run'
        ? 'Run Task'
        : mode === 'backlog'
          ? 'Add to Backlog'
          : 'Create Routine';

  const handleSubmit = (event: Event) => {
    event.preventDefault();
    if (submitDisabled) return;
    const cleanTitle = title.trim();
    const cleanPrompt = prompt.trim();
    const trimmedVerify = verifyCommand.trim();
    // undefined keeps a stored command on PATCH; null is the value that clears it.
    const cleanVerify: string | undefined = trimmedVerify || undefined;
    const verifyPatch: string | null | undefined =
      trimmedVerify === '' && isEditing && seedVerify !== '' ? null : cleanVerify;
    const chain: CascadeHop[] =
      cascade.length > 0
        ? cascade
        : [
            {
              model: defaultModel,
              effort: resolveModelEffort(catalog.models, defaultModel).defaultEffort,
            },
          ];
    const repositoryName =
      repoOptions.find((repo) => repo.id === repositoryId)?.name ?? repositoryId;

    if (mode === 'run') {
      onSubmit({
        mode: 'run',
        repositoryId,
        repositoryName,
        title: cleanTitle,
        prompt: cleanPrompt,
        cascade: chain,
        prPolicy,
        autoCreatePr: prPolicy !== 'none',
        verifyCommand: cleanVerify,
        scheduleMode: 'immediate',
      });
      return;
    }

    if (mode === 'backlog') {
      onSubmit({
        mode: 'backlog',
        id: backlog?.id,
        repositoryId,
        title: cleanTitle,
        prompt: cleanPrompt,
        cascade: chain,
        autoCreatePr: prPolicy !== 'none',
        verifyCommand: verifyPatch,
        priorityOrder: parseBounded(priority, 0, 9999) ?? 0,
      });
      return;
    }

    onSubmit({
      mode: 'routine',
      id: routine?.id,
      repositoryId,
      title: cleanTitle,
      prompt: cleanPrompt,
      cascade: chain,
      prPolicy,
      autoCreatePr: prPolicy !== 'none',
      verifyCommand: verifyPatch,
      triggerBeforeResetHours: triggerHoursValue ?? 4,
      minHeadroomPercent: minHeadroomValue ?? 10,
    });
  };

  return (
    <form class="flex min-h-full flex-col gap-4" onSubmit={handleSubmit}>
      <div class="flex flex-wrap items-center gap-3">
        <div
          role="group"
          aria-label="Task type"
          class="flex gap-1 rounded-lg border border-pine-highlight bg-pine-overlay/40 p-1"
        >
          {MODES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={mode === option}
              disabled={isLocked}
              onClick={() => setMode(option)}
              class={`flex-1 cursor-pointer rounded-md px-3 py-1.5 text-xs font-bold whitespace-nowrap uppercase transition-colors disabled:cursor-not-allowed ${
                mode === option
                  ? 'bg-pine-iris text-pine-base'
                  : 'text-pine-subtle hover:text-pine-text disabled:hover:text-pine-subtle'
              }`}
            >
              {MODE_LABELS[option]}
            </button>
          ))}
        </div>
        {isLocked && (
          <span class={hintClass}>Tier: {MODE_LABELS[mode]} — fixed for an existing record.</span>
        )}
        {!isLocked &&
          mode === 'run' &&
          headroomPercent !== null &&
          headroomPercent !== undefined && (
            <span class={`ml-auto font-mono ${hintClass}`}>Pool headroom {headroomPercent}%</span>
          )}
      </div>

      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div class="flex flex-col gap-1.5">
          <label for="composer-repository" class={labelClass}>
            Repository
          </label>
          <div class="relative">
            <select
              id="composer-repository"
              name="repositoryId"
              class={`cursor-pointer appearance-none pr-9 ${fieldClass}`}
              value={repositoryId}
              onChange={(event) => setRepositoryId((event.target as HTMLSelectElement).value)}
              required
            >
              <option value="">Select a repository</option>
              {repoOptions.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
            <Icon
              icon={faChevronDown}
              class="pointer-events-none absolute top-1/2 right-3 size-3 -translate-y-1/2 text-pine-subtle"
            />
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <label for="composer-title" class={labelClass}>
            Title
          </label>
          <input
            id="composer-title"
            name="title"
            type="text"
            autoComplete="off"
            class={fieldClass}
            placeholder="e.g. Harden quota reset detection"
            value={title}
            onInput={(event) => setTitle((event.target as HTMLInputElement).value)}
            required
          />
        </div>

        <div class="md:col-span-2">
          <ModelCascadeField
            id="composer-models"
            label="Model cascade"
            value={cascade}
            onChange={setCascade}
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <label for="composer-pr-policy" class={labelClass}>
            PR Policy
          </label>
          <div class="relative">
            <select
              id="composer-pr-policy"
              name="prPolicy"
              class={`cursor-pointer appearance-none pr-9 ${fieldClass}`}
              value={prPolicy}
              onChange={(event) =>
                setPrPolicy((event.target as HTMLSelectElement).value as PrPolicy)
              }
            >
              {PR_POLICY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <Icon
              icon={faChevronDown}
              class="pointer-events-none absolute top-1/2 right-3 size-3 -translate-y-1/2 text-pine-subtle"
            />
          </div>
          <p class={hintClass}>{PR_POLICY_HINTS[prPolicy]}</p>
        </div>

        {mode === 'routine' && (
          <>
            <div class="flex flex-col gap-1.5">
              <label for="composer-trigger-hours" class={labelClass}>
                Trigger Before Reset (hours)
              </label>
              <input
                id="composer-trigger-hours"
                name="triggerBeforeResetHours"
                type="number"
                min={1}
                max={24}
                step={1}
                class={`font-mono ${fieldClass}`}
                value={triggerHours}
                aria-invalid={triggerHoursValue === null}
                onInput={(event) => setTriggerHours((event.target as HTMLInputElement).value)}
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label for="composer-min-headroom" class={labelClass}>
                Min Headroom Floor (%)
              </label>
              <input
                id="composer-min-headroom"
                name="minHeadroomPercent"
                type="number"
                min={1}
                max={90}
                step={1}
                class={`font-mono ${fieldClass}`}
                value={minHeadroom}
                aria-invalid={minHeadroomValue === null}
                onInput={(event) => setMinHeadroom((event.target as HTMLInputElement).value)}
              />
              {!routineBoundsValid && (
                <p class="text-xs text-pine-love">
                  Trigger window is 1-24h and the floor is 1-90%.
                </p>
              )}
            </div>
          </>
        )}
      </div>

      <div class="flex flex-col gap-1.5">
        <label for="composer-prompt" class={labelClass}>
          Prompt
        </label>
        <textarea
          id="composer-prompt"
          name="prompt"
          class={`min-h-56 ${fieldClass}`}
          placeholder="Detailed instructions for the autonomous coding agent..."
          value={prompt}
          onInput={(event) => setPrompt((event.target as HTMLTextAreaElement).value)}
          required
        />
        <p class={hintClass}>
          The runner has no other context: state the objective and the check that proves it done.
        </p>
      </div>

      <details
        class="rounded-lg border border-pine-highlight bg-pine-base/40"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary class="cursor-pointer px-3 py-2 text-xs font-medium text-pine-subtle transition-colors hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden">
          Advanced Overrides
        </summary>
        <div class="grid grid-cols-1 gap-4 border-t border-pine-highlight p-3 md:grid-cols-2">
          <div class="flex flex-col gap-1.5">
            <label for="composer-verify-command" class={labelClass}>
              Verify Command
            </label>
            <input
              id="composer-verify-command"
              name="verifyCommand"
              type="text"
              autoComplete="off"
              class={`font-mono ${fieldClass}`}
              placeholder="npm test"
              value={verifyCommand}
              onInput={(event) => setVerifyCommand((event.target as HTMLInputElement).value)}
            />
            <p class={hintClass}>Runs after the agent finishes; an allowlisted command only.</p>
          </div>

          {mode === 'backlog' && (
            <div class="flex flex-col gap-1.5">
              <label for="composer-priority" class={labelClass}>
                Priority (lower runs first)
              </label>
              <input
                id="composer-priority"
                name="priorityOrder"
                type="number"
                min={0}
                max={9999}
                step={1}
                class={`font-mono ${fieldClass}`}
                value={priority}
                aria-invalid={parseBounded(priority, 0, 9999) === null}
                onInput={(event) => setPriority((event.target as HTMLInputElement).value)}
              />
            </div>
          )}
        </div>
      </details>

      {error && (
        <p
          role="alert"
          aria-live="assertive"
          class="rounded-lg border border-pine-love/40 bg-pine-love/10 px-3 py-2 text-xs text-pine-love"
        >
          {error}
        </p>
      )}

      <div class="sticky bottom-0 z-10 -mx-4 mt-auto -mb-4 flex items-center justify-end gap-3 border-t border-pine-highlight bg-pine-surface px-4 py-3">
        <button
          type="button"
          class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-4 py-2 text-sm font-medium text-pine-text transition-colors hover:bg-pine-highlight/50 disabled:opacity-50"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="submit"
          class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-sm font-semibold text-pine-base transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-pine-overlay disabled:text-pine-subtle"
          disabled={submitDisabled}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
};
