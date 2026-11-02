import { faBolt, faTriangleExclamation, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConfigData, ModelCatalogEntry, QuotaSnapshot, ToastState } from '../types';
import { getModels, triggerDispatch } from '../api';
import {
  EFFORT_OPTIONS,
  MODEL_DEFAULT_EFFORT,
  MODEL_OPTIONS,
  MODEL_SUPPORTED_EFFORTS,
} from '../config/fields';
import { Icon } from './Icon';

interface DispatchModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: ConfigData;
  quota?: QuotaSnapshot[];
}

let cachedCatalogModels: ModelCatalogEntry[] = [];
let modelsFetchPromise: Promise<ModelCatalogEntry[]> | null = null;

export const loadModelCatalog = async (): Promise<ModelCatalogEntry[]> => {
  if (cachedCatalogModels.length > 0) return cachedCatalogModels;
  if (!modelsFetchPromise) {
    modelsFetchPromise = getModels()
      .then((res) => {
        if (res.models && res.models.length > 0) {
          cachedCatalogModels = res.models;
        }
        return cachedCatalogModels;
      })
      .finally(() => {
        modelsFetchPromise = null;
      });
  }
  return modelsFetchPromise;
};

const FALLBACK_MODELS = MODEL_OPTIONS.map((m) => {
  const family: 'claude' | 'gemini-argon' | 'gemini-flash' = m.value.includes('flash')
    ? 'gemini-flash'
    : m.value.includes('argon')
      ? 'gemini-argon'
      : 'claude';
  return { id: m.value, label: m.label, family };
});

const computePoolHeadroomPct = (pool?: QuotaSnapshot): number | null => {
  if (!pool) return null;
  const fractions = [pool.remainingFraction];
  if (pool.weekly) fractions.push(pool.weekly.remainingFraction);
  if (pool.shortTerm) fractions.push(pool.shortTerm.remainingFraction);
  return Math.round(Math.max(0, Math.min(1, Math.min(...fractions))) * 100);
};

const normalizeBaseModel = (raw?: string): string => {
  if (!raw) return 'gemini-3.8-flash';
  if (raw.startsWith('gemini-3.8-flash')) return 'gemini-3.8-flash';
  if (raw.startsWith('gemini-4-argon')) return 'gemini-4-argon';
  if (raw.startsWith('claude-sonnet-5-5')) return 'claude-sonnet-5-5';
  if (raw.startsWith('claude-opus-5-5')) return 'claude-opus-5-5';
  if (raw.startsWith('gpt-oss-120b')) return 'gpt-oss-120b';
  return raw;
};

interface RepoItem {
  id?: string;
  name: string;
  path?: string;
  cloneUrl?: string;
}

const EMPTY_REPOS: RepoItem[] = [];

export const DispatchModal = ({ isOpen, onClose, config, quota = [] }: DispatchModalProps) => {
  const repos: RepoItem[] = (config.resolved?.repositories as unknown as RepoItem[]) || EMPTY_REPOS;
  const defaultRepo = repos.length === 1 ? repos[0]!.name : '';

  const configuredDefaultModel = normalizeBaseModel(config.resolved?.defaultDispatchModel);
  const supportedEffortsForDefault =
    MODEL_SUPPORTED_EFFORTS[configuredDefaultModel] || (['low', 'medium', 'high'] as const);
  const rawEffort = config.resolved?.defaultDispatchEffort as any;
  const configuredDefaultEffort = supportedEffortsForDefault.includes(rawEffort)
    ? rawEffort
    : MODEL_DEFAULT_EFFORT[configuredDefaultModel] || 'medium';

  const [selectedRepo, setSelectedRepo] = useState(defaultRepo);
  const [selectedModel, setSelectedModel] = useState(configuredDefaultModel);
  const [scheduleMode, setScheduleMode] = useState<'immediate' | 'pre_reset'>('immediate');
  const [effort, setEffort] = useState<'low' | 'medium' | 'high'>(configuredDefaultEffort);
  const [autoCreatePr, setAutoCreatePr] = useState(true);
  const [taskPrompt, setTaskPrompt] = useState('');
  const [requestedBy, setRequestedBy] = useState('web-ui');
  const [allowOverage, setAllowOverage] = useState(false);
  const [isDispatching, setIsDispatching] = useState(false);
  const [status, setStatus] = useState<ToastState | null>(null);
  const [catalogModels, setCatalogModels] = useState<ModelCatalogEntry[]>(cachedCatalogModels);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const handleModelChange = (newModel: string) => {
    setSelectedModel(newModel);
    setAllowOverage(false);
    const supported = MODEL_SUPPORTED_EFFORTS[newModel] || (['low', 'medium', 'high'] as const);
    if (!supported.includes(effort)) {
      setEffort(MODEL_DEFAULT_EFFORT[newModel] || 'medium');
    }
  };

  useEffect(() => {
    if (isOpen) return;
    const nextModel = normalizeBaseModel(config.resolved?.defaultDispatchModel);
    setSelectedModel(nextModel);
    const supported = MODEL_SUPPORTED_EFFORTS[nextModel] || (['low', 'medium', 'high'] as const);
    const raw = config.resolved?.defaultDispatchEffort as any;
    setEffort(supported.includes(raw) ? raw : MODEL_DEFAULT_EFFORT[nextModel] || 'medium');
  }, [isOpen, config.resolved?.defaultDispatchModel, config.resolved?.defaultDispatchEffort]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen) {
      if (!dialog.open) dialog.showModal();
      setAllowOverage(false);
      if (repos.length === 1 && repos[0]) {
        setSelectedRepo(repos[0].name);
      }
    } else {
      if (dialog.open) dialog.close();
      setAllowOverage(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (cachedCatalogModels.length === 0) {
      loadModelCatalog().then((models) => {
        if (models.length > 0) {
          setCatalogModels(models);
        }
      });
    }
  }, [isOpen]);

  const isOrchestratorEnabled = Boolean(config.resolved?.orchestratorEnabled);
  const minHeadroom = config.resolved?.minDispatchHeadroomPercent ?? 10;

  // Determine the selected model's pool family and effective headroom
  const activeModelMeta =
    catalogModels.find((m) => m.id === selectedModel) ||
    FALLBACK_MODELS.find((m) => m.id === selectedModel) ||
    FALLBACK_MODELS[0]!;
  const matchingPool = quota.find(
    (q) => q.family === activeModelMeta.family || q.poolId === activeModelMeta.family
  );
  const selectedPoolHeadroomPct =
    (activeModelMeta as ModelCatalogEntry).effectiveHeadroomPercent ??
    computePoolHeadroomPct(matchingPool) ??
    100;
  const isLowHeadroom =
    (matchingPool !== undefined ||
      (activeModelMeta as ModelCatalogEntry).effectiveHeadroomPercent !== undefined) &&
    selectedPoolHeadroomPct !== null &&
    selectedPoolHeadroomPct < minHeadroom;

  const handleDispatch = (e: Event) => {
    e.preventDefault();
    if (!isOrchestratorEnabled) {
      setStatus({
        type: 'error',
        message:
          'Task orchestrator is disabled. Enable it in Settings > Orchestrator or set ORCHESTRATOR_ENABLED=true.',
      });
      return;
    }
    if (!selectedRepo || !taskPrompt.trim()) return;
    if (isLowHeadroom && !allowOverage) return;

    setIsDispatching(true);
    setStatus(null);

    const matchedRepo = repos.find((r) => r.name === selectedRepo || r.id === selectedRepo);

    triggerDispatch({
      repositoryName: matchedRepo?.name || selectedRepo,
      repositoryId: matchedRepo?.id,
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
              data.error || 'Task orchestrator is disabled while running in alerting-only mode.',
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
        setTimeout(() => {
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

  const handleDialogClick = (e: MouseEvent) => {
    if (!dialogRef.current) return;
    const rect = dialogRef.current.getBoundingClientRect();
    const isInDialog =
      rect.top <= e.clientY &&
      e.clientY <= rect.top + rect.height &&
      rect.left <= e.clientX &&
      e.clientX <= rect.left + rect.width;
    if (!isInDialog) {
      onClose();
    }
  };

  return (
    <dialog
      id="dispatchModal"
      ref={dialogRef}
      onClose={onClose}
      onClick={handleDialogClick}
      class={`fixed inset-0 m-auto flex max-h-[92vh] w-full max-w-xl flex-col gap-4 overflow-y-auto rounded-xl border border-pine-highlight bg-pine-surface p-6 text-pine-text shadow-2xl backdrop:bg-black/65 backdrop:backdrop-blur-sm ${
        !isOpen ? 'hidden' : ''
      }`}
    >
      <div class="flex flex-col gap-4">
        <div class="flex items-center justify-between border-b border-pine-highlight pb-2">
          <h3 class="flex items-center gap-2 text-lg font-semibold text-pine-text">
            <Icon icon={faBolt} class="size-4 text-pine-iris" />
            <span>Dispatch Continuation Task</span>
          </h3>
          <button
            type="button"
            class="cursor-pointer text-pine-subtle transition-colors hover:text-pine-text"
            onClick={onClose}
            aria-label="Close modal"
          >
            <Icon icon={faXmark} class="size-4" />
          </button>
        </div>

        {!isOrchestratorEnabled && (
          <div class="flex items-start gap-2.5 rounded-lg border border-pine-gold bg-pine-gold/15 p-3 text-xs font-medium text-pine-gold">
            <Icon icon={faTriangleExclamation} class="mt-0.5 size-4 shrink-0" />
            <span>
              <strong>Orchestrator Inactive:</strong> Task orchestrator is currently disabled
              (Agylity is operating purely as a 24/7 quota sentry). You can enable it anytime under{' '}
              <strong>Settings &gt; Orchestrator</strong>.
            </span>
          </div>
        )}

        <form onSubmit={handleDispatch} class="flex flex-col gap-4">
          <div class="flex flex-col gap-1.5">
            <label for="repoSelect" class="text-xs font-medium text-pine-subtle">
              Target Repository
            </label>
            <select
              id="repoSelect"
              name="repositoryName"
              class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
              value={selectedRepo}
              onChange={(e) => setSelectedRepo((e.target as HTMLSelectElement).value)}
              required
            >
              <option value="">-- Select Pre-Configured Repository --</option>
              {repos.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name} ({r.path || 'default'})
                </option>
              ))}
            </select>
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div class="flex flex-col gap-1.5 sm:col-span-2">
              <label for="modelSelect" class="text-xs font-medium text-pine-subtle">
                Target Model (--model)
              </label>
              <select
                id="modelSelect"
                name="model"
                class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
                value={selectedModel}
                onChange={(e) => handleModelChange((e.target as HTMLSelectElement).value)}
              >
                {FALLBACK_MODELS.map((m) => {
                  const live = catalogModels.find((c) => c.id === m.id);
                  const pool = quota.find((q) => q.family === m.family || q.poolId === m.family);
                  const pct = live?.effectiveHeadroomPercent ?? computePoolHeadroomPct(pool);
                  const suffix = pct !== null ? ` (${pct}% left)` : '';
                  return (
                    <option key={m.id} value={m.id}>
                      {m.label}
                      {suffix}
                    </option>
                  );
                })}
              </select>
            </div>

            <div class="flex flex-col gap-1.5">
              <label for="scheduleModeSelect" class="text-xs font-medium text-pine-subtle">
                Schedule Mode
              </label>
              <select
                id="scheduleModeSelect"
                name="scheduleMode"
                class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
                value={scheduleMode}
                onChange={(e) =>
                  setScheduleMode(
                    (e.target as HTMLSelectElement).value as 'immediate' | 'pre_reset'
                  )
                }
              >
                <option value="immediate">Run Immediately</option>
                <option value="pre_reset">Pre-Reset Quota Burn</option>
              </select>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="flex flex-col gap-1.5">
              <label for="effortSelect" class="text-xs font-medium text-pine-subtle">
                Reasoning Effort (--effort)
              </label>
              <select
                id="effortSelect"
                name="effort"
                class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
                value={effort}
                onChange={(e) =>
                  setEffort((e.target as HTMLSelectElement).value as 'low' | 'medium' | 'high')
                }
              >
                {EFFORT_OPTIONS.filter((o) =>
                  (MODEL_SUPPORTED_EFFORTS[selectedModel] || ['low', 'medium', 'high']).includes(
                    o.value
                  )
                ).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div class="flex flex-col gap-1.5">
              <label for="requestedByInput" class="text-xs font-medium text-pine-subtle">
                Requested By Identifier
              </label>
              <input
                id="requestedByInput"
                name="requestedBy"
                type="text"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellcheck={false}
                class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
                value={requestedBy}
                onInput={(e) => setRequestedBy((e.target as HTMLInputElement).value)}
              />
            </div>
          </div>

          <div class="mt-2 flex items-center gap-2">
            <input
              id="autoCreatePrCheck"
              type="checkbox"
              class="size-4 cursor-pointer rounded-sm border-pine-highlight text-pine-iris focus:ring-pine-iris"
              checked={autoCreatePr}
              onChange={(e) => setAutoCreatePr((e.target as HTMLInputElement).checked)}
            />
            <label for="autoCreatePrCheck" class="cursor-pointer text-xs text-pine-text">
              Automatically create Pull Request via{' '}
              <code class="font-mono text-pine-foam">gh pr create</code> on branch push
            </label>
          </div>

          <div class="flex flex-col gap-1.5">
            <label for="taskPromptInput" class="text-xs font-medium text-pine-subtle">
              Task Continuation Prompt / Instructions
            </label>
            <textarea
              id="taskPromptInput"
              name="prompt"
              class="min-h-[110px] rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
              placeholder="e.g. Continue unit test suite implementation on isolated branch..."
              value={taskPrompt}
              onInput={(e) => setTaskPrompt((e.target as HTMLTextAreaElement).value)}
              required
            />
          </div>

          {isLowHeadroom && (
            <div class="flex flex-col gap-2 rounded-lg border border-pine-gold bg-pine-gold/20 p-3 text-xs font-medium text-pine-gold">
              <div class="flex items-start gap-2.5">
                <Icon icon={faTriangleExclamation} class="mt-0.5 size-4 shrink-0" />
                <span>
                  <strong>Low Pool Headroom Warning ({activeModelMeta.family}):</strong> Remaining
                  quota ({selectedPoolHeadroomPct}%) is below the {minHeadroom}% safety floor.
                  Dispatching now may incur paid AI overage charges or consume flex credits.
                </span>
              </div>
              <label
                for="allowOverageInput"
                class="mt-1 flex cursor-pointer items-center gap-2 font-medium text-pine-text select-none"
              >
                <input
                  id="allowOverageInput"
                  name="allowOverage"
                  type="checkbox"
                  class="cursor-pointer rounded-sm accent-pine-gold"
                  checked={allowOverage}
                  onChange={(e) => setAllowOverage((e.target as HTMLInputElement).checked)}
                />
                <span>Allow AI overcharges / paid credit usage</span>
              </label>
            </div>
          )}

          <div aria-live="polite">
            {status && (
              <div
                class={`rounded-lg border p-3 text-xs font-medium ${
                  status.type === 'success'
                    ? 'border-pine-pine bg-pine-pine/20 text-pine-foam'
                    : 'border-pine-love bg-pine-love/20 text-pine-love'
                }`}
              >
                {status.message}
              </div>
            )}
          </div>

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
                !isOrchestratorEnabled ||
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
