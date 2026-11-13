import { faBolt, faTriangleExclamation, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useEffect, useRef, useState } from 'preact/hooks';
import { dialogBackdropClickHandler } from '../utils/dialog';
import type { ConfigData, QuotaSnapshot, ReasoningEffort, ToastState } from '../types';
import { triggerDispatch } from '../api';
import { normalizeModelId, resolveModelEffort } from '../config/fields';
import { loadModelCatalog, useModelCatalog } from '../state/modelCatalogStore';
import { Icon } from './Icon';
import {
  DispatchFormFields,
  FALLBACK_MODELS,
  computePoolHeadroomPct,
  type RepoItem,
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

export const DispatchModal = ({ isOpen, onClose, config, quota = [] }: DispatchModalProps) => {
  const repos: RepoItem[] = (config.resolved?.repositories as unknown as RepoItem[]) || EMPTY_REPOS;
  const defaultRepo = repos.length === 1 ? repos[0]!.name : '';
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

  const [selectedRepo, setSelectedRepo] = useState(defaultRepo);
  const [selectedModel, setSelectedModel] = useState(configuredDefaultModel);
  const [scheduleMode, setScheduleMode] = useState<'immediate' | 'pre_reset'>('immediate');
  const [effort, setEffort] = useState<ReasoningEffort>(configuredDefaultEffort);
  const [autoCreatePr, setAutoCreatePr] = useState(true);
  const [taskPrompt, setTaskPrompt] = useState('');
  const [requestedBy, setRequestedBy] = useState('web-ui');
  const [allowOverage, setAllowOverage] = useState(false);
  const [isDispatching, setIsDispatching] = useState(false);
  const [status, setStatus] = useState<ToastState | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  const handleModelChange = (newModel: string) => {
    setSelectedModel(newModel);
    setAllowOverage(false);
    const { supported, defaultEffort } = resolveModelEffort(catalogModels, newModel);
    if (!supported.includes(effort)) {
      setEffort(defaultEffort);
    }
  };

  useEffect(() => {
    if (isOpen) return;
    const nextModel = normalizeModelId(config.resolved?.defaultDispatchModel, catalogModels);
    setSelectedModel(nextModel);
    const { supported, defaultEffort } = resolveModelEffort(catalogModels, nextModel);
    const raw = config.resolved?.defaultDispatchEffort as any;
    setEffort(supported.includes(raw) ? raw : defaultEffort);
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
      if (repos.length === 1 && repos[0]) {
        setSelectedRepo(repos[0].id || repos[0].name || '');
      }
    } else {
      if (dialog.open) dialog.close();
      setAllowOverage(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) void loadModelCatalog();
  }, [isOpen]);

  const isCoordinatorEnabled = Boolean(config.resolved?.coordinatorEnabled);
  const minHeadroom = config.resolved?.minDispatchHeadroomPercent ?? 10;

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
    activeFamily !== null && knownHeadroomPct !== null && knownHeadroomPct < minHeadroom;

  const handleDispatch = (e: Event) => {
    e.preventDefault();
    if (!isCoordinatorEnabled) {
      setStatus({
        type: 'error',
        message:
          'Task coordinator is disabled. Enable it in Settings > Coordinator or set COORDINATOR_ENABLED=true.',
      });
      return;
    }
    if (!selectedRepo || !taskPrompt.trim()) return;
    if (isLowHeadroom && !allowOverage) return;

    setIsDispatching(true);
    setStatus(null);

    const matchedRepo = repos.find((r) => r.name === selectedRepo || r.id === selectedRepo);

    triggerDispatch({
      repositoryId: matchedRepo?.id || selectedRepo,
      repositoryName: matchedRepo?.name,
      repositoryPath: matchedRepo?.path,
      cloneUrl: matchedRepo?.cloneUrl,
      prompt: taskPrompt.trim(),
      requestedBy: requestedBy.trim() || 'web-ui',
      model: selectedModel,
      scheduleMode,
      effort,
      autoCreatePr,
      allowOverage,
    })
      .then((data) => {
        if (!data.success) {
          setStatus({
            type: 'error',
            message:
              data.error || 'Task coordinator is disabled while running in alerting-only mode.',
          });
          return;
        }
        const label =
          data.status === 'queued'
            ? `Task queued (${scheduleMode}, ${data.model || selectedModel})! Planned branch: ${data.branchName || 'antigravity/continuation'}`
            : `Task dispatched (${data.model || selectedModel})! Branch: ${data.branchName || 'antigravity/continuation'}`;
        setStatus({
          type: 'success',
          message: label,
        });
        setTaskPrompt('');
        setAllowOverage(false);
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        closeTimerRef.current = setTimeout(() => {
          onClose();
          setStatus(null);
        }, 2500);
      })
      .catch((err) => {
        setStatus({ type: 'error', message: err.message || 'Dispatch failed' });
      })
      .finally(() => {
        setIsDispatching(false);
      });
  };

  const handleDialogClick = dialogBackdropClickHandler(dialogRef, onClose);

  return (
    <dialog
      id="dispatchModal"
      aria-labelledby="dispatchModalTitle"
      aria-modal="true"
      ref={dialogRef}
      onClose={onClose}
      onClick={handleDialogClick}
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
            <Icon icon={faBolt} class="size-4 text-pine-iris" />
            <span>Dispatch Continuation Task</span>
          </h2>
          <button
            type="button"
            class="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-lg text-pine-subtle transition-colors hover:bg-pine-overlay hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
            onClick={onClose}
            aria-label="Close dispatch modal"
          >
            <Icon icon={faXmark} class="size-4" />
          </button>
        </div>

        {!isCoordinatorEnabled && (
          <div class="flex items-start gap-2.5 rounded-lg border border-pine-gold bg-pine-gold/15 p-3 text-xs font-medium text-pine-gold">
            <Icon icon={faTriangleExclamation} class="mt-0.5 size-4 shrink-0" />
            <span>
              <strong>Coordinator Inactive:</strong> Task coordinator is currently disabled (Agylity
              is operating purely as a 24/7 quota sentry). You can enable it anytime under{' '}
              <strong>Settings &gt; Coordinator</strong>.
            </span>
          </div>
        )}

        <form onSubmit={handleDispatch} class="flex flex-col gap-4">
          <DispatchFormFields
            repos={repos}
            selectedRepo={selectedRepo}
            onRepoChange={setSelectedRepo}
            selectedModel={selectedModel}
            onModelChange={handleModelChange}
            catalogModels={catalogModels}
            quota={quota}
            scheduleMode={scheduleMode}
            onScheduleModeChange={setScheduleMode}
            effort={effort}
            onEffortChange={setEffort}
            requestedBy={requestedBy}
            onRequestedByChange={setRequestedBy}
            autoCreatePr={autoCreatePr}
            onAutoCreatePrChange={setAutoCreatePr}
            taskPrompt={taskPrompt}
            onTaskPromptChange={setTaskPrompt}
          />

          {isLowHeadroom && (
            <DispatchOverageWarning
              family={activeFamily ?? 'unknown pool'}
              headroomPct={selectedPoolHeadroomPct}
              minHeadroom={minHeadroom}
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
              disabled={isDispatching}
            >
              Cancel
            </button>
            <button
              type="submit"
              class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-sm font-semibold text-pine-base shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
              disabled={
                !isCoordinatorEnabled ||
                isDispatching ||
                !selectedRepo ||
                !taskPrompt.trim() ||
                (isLowHeadroom && !allowOverage)
              }
            >
              {isDispatching ? 'Dispatching...' : 'Dispatch Task'}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
};
