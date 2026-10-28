import { faBolt, faTriangleExclamation, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useState } from 'preact/hooks';
import type { ConfigData, ToastState, QuotaSnapshot } from '../types';
import { triggerDispatch } from '../api';
import { Icon } from './Icon';

interface DispatchModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: ConfigData;
  quota?: QuotaSnapshot[];
}

export const DispatchModal = ({ isOpen, onClose, config, quota = [] }: DispatchModalProps) => {
  const [selectedRepo, setSelectedRepo] = useState('');
  const [taskPrompt, setTaskPrompt] = useState('');
  const [requestedBy, setRequestedBy] = useState('web-ui');
  const [allowOverage, setAllowOverage] = useState(false);
  const [isDispatching, setIsDispatching] = useState(false);
  const [status, setStatus] = useState<ToastState | null>(null);

  const isOrchestratorEnabled = Boolean(config.resolved?.orchestratorEnabled);
  const minHeadroom = config.resolved?.minDispatchHeadroomPercent ?? 10;
  const maxHeadroomPct =
    quota.length > 0 ? Math.max(...quota.map((q) => Math.round(q.remainingFraction * 100))) : 100;
  const isLowHeadroom = quota.length > 0 && maxHeadroomPct < minHeadroom;

  const repos: Array<{ name: string; path?: string }> = config.resolved?.repositories || [];

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

    triggerDispatch({
      repositoryName: selectedRepo,
      prompt: taskPrompt.trim(),
      requestedBy: requestedBy.trim() || 'web-ui',
      allowOverage,
    })
      .then((data: any) => {
        if (!data.success) {
          setStatus({
            type: 'error',
            message:
              data.error || 'Task orchestrator is disabled while running in alerting-only mode.',
          });
          return;
        }
        setStatus({
          type: 'success',
          message: `Task dispatched successfully! Branch: ${data.branchName || 'antigravity/continuation'}`,
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
      <div class="flex w-full max-w-lg flex-col gap-4 rounded-xl border border-pine-highlight bg-pine-surface p-6 text-pine-text shadow-2xl">
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
            <label class="text-xs font-medium text-pine-subtle">Target Repository</label>
            <select
              id="repoSelect"
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

          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium text-pine-subtle">
              Task Continuation Prompt / Instructions
            </label>
            <textarea
              class="min-h-[110px] rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
              placeholder="e.g. Continue unit test suite implementation on remote worker..."
              value={taskPrompt}
              onInput={(e) => setTaskPrompt((e.target as HTMLTextAreaElement).value)}
              required
            />
          </div>

          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium text-pine-subtle">Requested By Identifier</label>
            <input
              type="text"
              class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
              value={requestedBy}
              onInput={(e) => setRequestedBy((e.target as HTMLInputElement).value)}
            />
          </div>

          {isLowHeadroom && (
            <div class="flex flex-col gap-2 rounded-lg border border-pine-gold bg-pine-gold/20 p-3 text-xs font-medium text-pine-gold">
              <div class="flex items-start gap-2.5">
                <Icon icon={faTriangleExclamation} class="mt-0.5 size-4 shrink-0" />
                <span>
                  <strong>Low Headroom Warning:</strong> Remaining quota ({maxHeadroomPct}%) is
                  below the {minHeadroom}% safety floor. Dispatching now may incur paid AI overage
                  charges or consume paid credits.
                </span>
              </div>
              <label class="mt-1 flex cursor-pointer items-center gap-2 font-medium text-pine-text select-none">
                <input
                  type="checkbox"
                  class="cursor-pointer rounded accent-pine-gold"
                  checked={allowOverage}
                  onChange={(e) => setAllowOverage((e.target as HTMLInputElement).checked)}
                />
                <span>Allow AI overcharges / paid credit usage</span>
              </label>
            </div>
          )}

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
