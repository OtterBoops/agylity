import { faBolt, faTriangleExclamation, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useEffect, useState } from 'preact/hooks';
import type { ConfigData, ModelCatalogEntry, QuotaSnapshot, ToastState } from '../types';
import { getModels, triggerDispatch } from '../api';
import { Icon } from './Icon';

interface DispatchModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: ConfigData;
  quota?: QuotaSnapshot[];
}

const FALLBACK_MODELS: Array<{
  id: string;
  label: string;
  family: 'claude' | 'gemini-argon' | 'gemini-flash';
}> = [
  { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)', family: 'gemini-argon' },
  { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)', family: 'gemini-argon' },
  { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)', family: 'gemini-argon' },
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', family: 'gemini-flash' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', family: 'gemini-flash' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)', family: 'gemini-flash' },
  { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)', family: 'claude' },
  { id: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)', family: 'claude' },
  { id: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low)', family: 'claude' },
  { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)', family: 'claude' },
  { id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)', family: 'claude' },
  { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)', family: 'claude' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', family: 'claude' },
];

const computePoolHeadroomPct = (pool?: QuotaSnapshot): number | null => {
  if (!pool) return null;
  const fractions = [pool.remainingFraction];
  if (pool.weekly) fractions.push(pool.weekly.remainingFraction);
  if (pool.shortTerm) fractions.push(pool.shortTerm.remainingFraction);
  return Math.round(Math.max(0, Math.min(1, Math.min(...fractions))) * 100);
};

export const DispatchModal = ({ isOpen, onClose, config, quota = [] }: DispatchModalProps) => {
  const configuredDefaultModel = config.resolved?.defaultDispatchModel || 'gemini-4-argon-high';
  const configuredDefaultMode = config.resolved?.defaultWorkerMode || 'headless';

  const [selectedRepo, setSelectedRepo] = useState('');
  const [selectedModel, setSelectedModel] = useState(configuredDefaultModel);
  const [priority, setPriority] = useState<'P0' | 'P1' | 'P2'>('P0');
  const [workerMode, setWorkerMode] = useState<'headless' | 'visible' | 'any'>(
    configuredDefaultMode
  );
  const [taskPrompt, setTaskPrompt] = useState('');
  const [requestedBy, setRequestedBy] = useState('web-ui');
  const [allowOverage, setAllowOverage] = useState(false);
  const [isDispatching, setIsDispatching] = useState(false);
  const [status, setStatus] = useState<ToastState | null>(null);
  const [catalogModels, setCatalogModels] = useState<ModelCatalogEntry[]>([]);

  useEffect(() => {
    setSelectedModel(config.resolved?.defaultDispatchModel || 'gemini-4-argon-high');
    setWorkerMode(config.resolved?.defaultWorkerMode || 'headless');
  }, [config.resolved?.defaultDispatchModel, config.resolved?.defaultWorkerMode]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    getModels().then((res) => {
      if (!cancelled && res.models.length > 0) {
        setCatalogModels(res.models);
      }
    });
    return () => {
      cancelled = true;
    };
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

  const repos: Array<{ id?: string; name: string; path?: string; cloneUrl?: string }> =
    config.resolved?.repositories || [];

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
      priority,
      workerMode,
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
            ? `Task queued (${priority}, ${data.model || selectedModel})! Planned branch: ${data.branchName || 'antigravity/continuation'}`
            : `Task dispatched (${data.model || selectedModel})! Branch: ${data.branchName || 'antigravity/continuation'}`;
        setStatus({
          type: 'success',
          message: label,
        });
        setTaskPrompt('');
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

  if (!isOpen) {
    return (
      <dialog id="dispatchModal" class="hidden">
        <select id="repoSelect" class="hidden" />
      </dialog>
    );
  }

  return (
    <dialog
      id="dispatchModal"
      open
      class="fixed inset-0 z-50 m-0 flex h-screen max-h-none w-screen max-w-none items-center justify-center border-none bg-black/65 p-4 backdrop-blur-sm"
    >
      <div class="flex max-h-[92vh] w-full max-w-xl flex-col gap-4 overflow-y-auto rounded-xl border border-pine-highlight bg-pine-surface p-6 text-pine-text shadow-2xl">
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
                onChange={(e) => setSelectedModel((e.target as HTMLSelectElement).value)}
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
              <label for="prioritySelect" class="text-xs font-medium text-pine-subtle">
                Queue Priority
              </label>
              <select
                id="prioritySelect"
                name="priority"
                class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
                value={priority}
                onChange={(e) =>
                  setPriority((e.target as HTMLSelectElement).value as 'P0' | 'P1' | 'P2')
                }
              >
                <option value="P0">P0 — Urgent</option>
                <option value="P1">P1 — Scheduled</option>
                <option value="P2">P2 — Quota-Burn</option>
              </select>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="flex flex-col gap-1.5">
              <label for="workerModeSelect" class="text-xs font-medium text-pine-subtle">
                Worker Routing
              </label>
              <select
                id="workerModeSelect"
                name="workerMode"
                class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
                value={workerMode}
                onChange={(e) =>
                  setWorkerMode(
                    (e.target as HTMLSelectElement).value as 'headless' | 'visible' | 'any'
                  )
                }
              >
                <option value="headless">Headless Worker</option>
                <option value="visible">Visible Desktop Worker</option>
                <option value="any">Any Available Worker</option>
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
