import { faPlus, faTriangleExclamation, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useEffect, useRef, useState } from 'preact/hooks';
import { dialogBackdropClickHandler } from '../utils/dialog';
import type { ConfigData, PrPolicy, QuotaSnapshot, ReasoningEffort, ToastState } from '../types';
import { createBacklogTask, createRoutine, triggerDispatch } from '../api';
import { normalizeModelId, resolveModelEffort } from '../config/fields';
import { loadModelCatalog, useModelCatalog } from '../state/modelCatalogStore';
import { Icon } from './Icon';
import {
  DispatchFormFields,
  FALLBACK_MODELS,
  computePoolHeadroomPct,
  type RepoItem,
  type TaskCreateMode,
} from './DispatchFormFields';
import { DispatchOverageWarning } from './DispatchOverageWarning';
import { StatusBanner } from './StatusBanner';

interface DispatchModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: ConfigData;
  quota?: QuotaSnapshot[];
}

const EMPTY_REPOS: RepoItem[] = [];
const PR_POLICIES: readonly string[] = ['docs_only', 'all', 'none'];

/** `Number('')` is 0, so an empty optional number must not collapse to a real bound. */
const parseBounded = (raw: string, min: number, max: number): number | undefined => {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < min || value > max) return undefined;
  return value;
};

export const DispatchModal = ({ isOpen, onClose, config, quota = [] }: DispatchModalProps) => {
  const repos: RepoItem[] = (config.resolved?.repositories as unknown as RepoItem[]) || EMPTY_REPOS;
  const singleRepoId = repos.length === 1 ? (repos[0]?.id ?? repos[0]?.name ?? '') : '';
  const routinesEnabled = config.resolved?.routinesEnabled !== false;
  const catalog = useModelCatalog();
  const catalogModels = catalog.models;

  const configuredDefaultModel = normalizeModelId(
    config.resolved?.defaultDispatchModel,
    catalogModels
  );
  const defaultEfforts = resolveModelEffort(catalogModels, configuredDefaultModel);
  const rawEffort = config.resolved?.defaultDispatchEffort as any;
  const configuredDefaultEffort = defaultEfforts.supported.includes(rawEffort)
    ? rawEffort
    : defaultEfforts.defaultEffort;

  const configuredPrPolicy = String(config.resolved?.prPolicy ?? '');
  const defaultPrPolicy: PrPolicy = PR_POLICIES.includes(configuredPrPolicy)
    ? (configuredPrPolicy as PrPolicy)
    : 'docs_only';
  const defaultMinHeadroom = Number(config.resolved?.minDispatchHeadroomPercent ?? 10);

  const [mode, setMode] = useState<TaskCreateMode>('run');
  const [selectedRepo, setSelectedRepo] = useState(singleRepoId);
  const [title, setTitle] = useState('');
  const [taskPrompt, setTaskPrompt] = useState('');
  const [selectedModel, setSelectedModel] = useState(configuredDefaultModel);
  const [effort, setEffort] = useState<ReasoningEffort>(configuredDefaultEffort);
  const [prPolicy, setPrPolicy] = useState<PrPolicy>(defaultPrPolicy);
  const [verifyCommand, setVerifyCommand] = useState('');
  const [priority, setPriority] = useState('0');
  const [triggerHours, setTriggerHours] = useState('4');
  const [minHeadroom, setMinHeadroom] = useState(String(defaultMinHeadroom));
  const [allowOverage, setAllowOverage] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [status, setStatus] = useState<ToastState | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  const resetModelDefaults = () => {
    const nextModel = normalizeModelId(config.resolved?.defaultDispatchModel, catalogModels);
    setSelectedModel(nextModel);
    const { supported, defaultEffort } = resolveModelEffort(catalogModels, nextModel);
    const raw = config.resolved?.defaultDispatchEffort as any;
    setEffort(supported.includes(raw) ? raw : defaultEffort);
  };

  useEffect(() => {
    if (isOpen) return;
    resetModelDefaults();
  }, [
    isOpen,
    config.resolved?.defaultDispatchModel,
    config.resolved?.defaultDispatchEffort,
    catalogModels,
  ]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen) {
      if (!dialog.open) dialog.showModal();
      setAllowOverage(false);
      if (singleRepoId) setSelectedRepo(singleRepoId);
    } else {
      if (dialog.open) dialog.close();
      setAllowOverage(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) void loadModelCatalog();
  }, [isOpen]);

  const isCoordinatorEnabled = Boolean(config.resolved?.coordinatorEnabled);

  // A model absent from the catalog has no family, so it can claim no pool's headroom.
  const activeLive = catalogModels.find((m) => m.id === selectedModel);
  const activeFamily =
    activeLive?.family ?? FALLBACK_MODELS.find((m) => m.id === selectedModel)?.family ?? null;
  const matchingPool = activeFamily
    ? quota.find((q) => q.family === activeFamily || q.poolId === activeFamily)
    : undefined;
  const knownHeadroomPct =
    activeLive?.effectiveHeadroomPercent ?? computePoolHeadroomPct(matchingPool);
  const selectedPoolHeadroomPct = knownHeadroomPct ?? 100;
  // Unknown headroom must not read as headroom below the floor; the server locks that dispatch.
  const isLowHeadroom =
    activeFamily !== null && knownHeadroomPct !== null && knownHeadroomPct < defaultMinHeadroom;

  const handleModelChange = (newModel: string) => {
    setSelectedModel(newModel);
    setAllowOverage(false);
    const { supported, defaultEffort } = resolveModelEffort(catalogModels, newModel);
    if (!supported.includes(effort)) setEffort(defaultEffort);
  };

  const parsedPriority = parseBounded(priority, 0, 9999);
  const parsedTriggerHours = parseBounded(triggerHours, 1, 24);
  const parsedMinHeadroom = parseBounded(minHeadroom, 1, 90);
  const routineBoundsValid = parsedTriggerHours !== undefined && parsedMinHeadroom !== undefined;

  const isReady = Boolean(selectedRepo) && Boolean(title.trim()) && Boolean(taskPrompt.trim());
  const submitDisabled =
    isSubmitting ||
    !isReady ||
    (mode === 'run' && !isCoordinatorEnabled) ||
    (mode === 'run' && isLowHeadroom && !allowOverage) ||
    (mode === 'routine' && !routineBoundsValid);

  const closeSoon = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      onClose();
      setMode('run');
      setStatus(null);
    }, 2500);
  };

  const submitRun = async (cleanTitle: string, cleanPrompt: string) => {
    const matchedRepo = repos.find((r) => r.id === selectedRepo || r.name === selectedRepo);
    const data = await triggerDispatch({
      repositoryId: matchedRepo?.id || selectedRepo,
      repositoryName: matchedRepo?.name,
      repositoryPath: matchedRepo?.path,
      cloneUrl: matchedRepo?.cloneUrl,
      title: cleanTitle,
      prompt: cleanPrompt,
      models: [selectedModel],
      model: selectedModel,
      effort,
      prPolicy,
      verifyCommand: verifyCommand.trim() || undefined,
      autoCreatePr: prPolicy !== 'none',
      scheduleMode: 'immediate',
      allowOverage,
    });
    if (!data.success) {
      setStatus({
        type: 'error',
        message: data.error || 'Task coordinator is disabled while running in alerting-only mode.',
      });
      return;
    }
    const branch = data.branchName ? ` · Branch: ${data.branchName}` : '';
    setStatus({
      type: 'success',
      message: `${data.status === 'queued' ? 'Run queued' : 'Run started'} (${data.model || selectedModel})${branch}`,
    });
    setTitle('');
    setTaskPrompt('');
    setAllowOverage(false);
    closeSoon();
  };

  const submitBacklog = async (cleanTitle: string, cleanPrompt: string) => {
    await createBacklogTask({
      title: cleanTitle,
      prompt: cleanPrompt,
      repositoryId: selectedRepo,
      models: [selectedModel],
      effort,
      autoCreatePr: prPolicy !== 'none',
      priorityOrder: parsedPriority ?? 0,
      verifyCommand: verifyCommand.trim() || undefined,
    });
    setStatus({ type: 'success', message: `Backlog item "${cleanTitle}" created` });
    setTitle('');
    setTaskPrompt('');
    closeSoon();
  };

  const submitRoutine = async (cleanTitle: string, cleanPrompt: string) => {
    await createRoutine({
      title: cleanTitle,
      prompt: cleanPrompt,
      repositoryId: selectedRepo,
      models: [selectedModel],
      effort,
      autoCreatePr: prPolicy !== 'none',
      prPolicy,
      verifyCommand: verifyCommand.trim() || undefined,
      enabled: true,
      triggerBeforeResetHours: parsedTriggerHours,
      minHeadroomPercent: parsedMinHeadroom,
    });
    setStatus({ type: 'success', message: `Routine "${cleanTitle}" created` });
    setTitle('');
    setTaskPrompt('');
    closeSoon();
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (submitDisabled) return;
    const cleanTitle = title.trim();
    const cleanPrompt = taskPrompt.trim();

    setIsSubmitting(true);
    setStatus(null);
    try {
      if (mode === 'run') await submitRun(cleanTitle, cleanPrompt);
      else if (mode === 'backlog') await submitBacklog(cleanTitle, cleanPrompt);
      else await submitRoutine(cleanTitle, cleanPrompt);
    } catch (err: any) {
      setStatus({
        type: 'error',
        message: err?.message || String(err) || 'Task creation failed',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitLabel = isSubmitting
    ? 'Creating...'
    : mode === 'run'
      ? 'Run Task'
      : mode === 'backlog'
        ? 'Add to Backlog'
        : 'Create Routine';

  return (
    <dialog
      id="dispatchModal"
      aria-labelledby="dispatchModalTitle"
      aria-modal="true"
      ref={dialogRef}
      onClose={onClose}
      onClick={dialogBackdropClickHandler(dialogRef, onClose)}
      class={`fixed inset-0 m-auto flex max-h-[85vh] w-[calc(100%-2rem)] max-w-xl flex-col gap-4 overflow-y-auto rounded-xl border border-pine-highlight bg-pine-surface p-4 text-pine-text shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-xs sm:p-6 ${
        !isOpen ? 'hidden' : ''
      }`}
    >
      <div class="flex flex-col gap-4">
        <div class="flex items-center justify-between border-b border-pine-highlight pb-2">
          <h2
            id="dispatchModalTitle"
            class="flex items-center gap-2 text-lg font-semibold text-pine-text"
          >
            <Icon icon={faPlus} class="size-4 text-pine-iris" />
            <span>New Task</span>
          </h2>
          <button
            type="button"
            class="inline-flex size-11 cursor-pointer items-center justify-center rounded-lg text-pine-subtle transition-colors hover:bg-pine-overlay hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
            onClick={onClose}
            aria-label="Close new task dialog"
          >
            <Icon icon={faXmark} class="size-4" />
          </button>
        </div>

        {!isCoordinatorEnabled && (
          <div class="flex items-start gap-2.5 rounded-lg border border-pine-gold bg-pine-gold/15 p-3 text-xs font-medium text-pine-gold">
            <Icon icon={faTriangleExclamation} class="mt-0.5 size-4 shrink-0" />
            <span>
              <strong>Coordinator Inactive:</strong> Task coordinator is currently disabled (Agylity
              is operating purely as a 24/7 quota sentry). Runs cannot start until you enable it
              under <strong>Settings &gt; Coordinator</strong>; backlog items and routines can still
              be saved.
            </span>
          </div>
        )}

        <form onSubmit={handleSubmit} class="flex flex-col gap-4">
          <DispatchFormFields
            mode={mode}
            onModeChange={setMode}
            routinesEnabled={routinesEnabled}
            repos={repos}
            selectedRepo={selectedRepo}
            onRepoChange={setSelectedRepo}
            title={title}
            onTitleChange={setTitle}
            taskPrompt={taskPrompt}
            onTaskPromptChange={setTaskPrompt}
            selectedModel={selectedModel}
            onModelChange={handleModelChange}
            catalogModels={catalogModels}
            quota={quota}
            effort={effort}
            onEffortChange={setEffort}
            prPolicy={prPolicy}
            onPrPolicyChange={setPrPolicy}
            verifyCommand={verifyCommand}
            onVerifyCommandChange={setVerifyCommand}
            priority={priority}
            onPriorityChange={setPriority}
            triggerHours={triggerHours}
            onTriggerHoursChange={setTriggerHours}
            minHeadroom={minHeadroom}
            onMinHeadroomChange={setMinHeadroom}
          />

          {mode === 'run' && isLowHeadroom && (
            <DispatchOverageWarning
              family={activeFamily ?? 'unknown pool'}
              headroomPct={selectedPoolHeadroomPct}
              minHeadroom={defaultMinHeadroom}
              allowOverage={allowOverage}
              onAllowOverageChange={setAllowOverage}
            />
          )}

          <div aria-live="polite">{status && <StatusBanner status={status} />}</div>

          <div class="mt-2 flex justify-end gap-3 border-t border-pine-highlight pt-2">
            <button
              type="button"
              class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-4 py-2 text-sm font-medium text-pine-text transition-colors hover:bg-pine-highlight/50"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-sm font-semibold text-pine-base shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
              disabled={submitDisabled}
            >
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
};
