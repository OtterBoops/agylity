import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { route } from 'preact-router';
import {
  faCheck,
  faCopy,
  faExternalLinkAlt,
  faTimes,
  faTriangleExclamation,
} from '@fortawesome/free-solid-svg-icons';
import type { PrPolicy, SwarmTask } from '../../types';
import { getTask } from '../../api';
import { dialogBackdropClickHandler } from '../../utils/dialog';
import { formatDateTime, formatDuration, useTimeFormat } from '../../utils/time';
import { Icon } from '../Icon';
import { isActiveTaskStatus, isLiveTaskStatus, taskBadgeClass } from './badges';

/** A live run writes output faster than the 4s list poll; the inspector has its own cadence. */
const POLL_INTERVAL_MS = 3000;

/** Within this distance of the bottom still counts as "following the tail". */
const AUTOSCROLL_SLACK_PX = 24;

const PR_POLICY_LABELS: Record<PrPolicy, string> = {
  docs_only: 'Docs only',
  all: 'All files',
  none: 'Disabled',
};

// Grouped digits, because these run to seven figures and an unseparated count is unreadable.
const formatTokenCount = (value: number): string => value.toLocaleString();

interface DetailItemProps {
  label: string;
  span?: boolean;
  children: ComponentChildren;
}

/** One label/value cell of the inspector's grids; `span` gives the long strings a whole row. */
const DetailItem = ({ label, span, children }: DetailItemProps) => (
  <div class={span ? 'sm:col-span-2' : undefined}>
    <span class="text-pine-subtle">{label}</span>
    <div class="mt-0.5 font-mono text-xs wrap-break-word text-pine-text">{children}</div>
  </div>
);

interface ExecutionInspectorModalProps {
  task: SwarmTask;
  onClose: () => void;
  /** Abort is offered only while the run can still be stopped. */
  onAbort?: (taskId: string) => void;
  /** Retry is offered only once the run has settled. */
  onRetry?: (taskId: string) => void;
  actionLoading?: boolean;
  /** A queued run nobody can claim is indistinguishable from a stalled one without this. */
  noRunnerOnline?: boolean;
  /** Origin links live in the page, which owns the backlog and routine lists they resolve against. */
  renderOrigin: (task: SwarmTask) => ComponentChildren;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'no_changes',
  'failed',
  'aborted',
]);

export const ExecutionInspectorModal = ({
  task,
  onClose,
  onAbort,
  onRetry,
  actionLoading,
  noRunnerOnline,
  renderOrigin,
}: ExecutionInspectorModalProps) => {
  const [timeFormat] = useTimeFormat();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  const stickToBottom = useRef(true);
  const [live, setLive] = useState<SwarmTask>(task);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  // The page mounts this only while a task is selected, so the dialog is modal from first paint
  // and every timer below dies with the unmount — no close race to guard against.
  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  // The page re-pins the inspected task off the list poll; keep whichever copy is newer.
  useEffect(() => {
    setLive((prev) => {
      if (prev.id !== task.id) return task;
      const prevAt = Date.parse(prev.updatedAt);
      const nextAt = Date.parse(task.updatedAt);
      return Number.isFinite(prevAt) && Number.isFinite(nextAt) && prevAt > nextAt ? prev : task;
    });
  }, [task]);

  const polling = isActiveTaskStatus(live.status);
  const taskId = task.id;

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    const timer = setInterval(() => {
      getTask(taskId)
        .then((fresh) => {
          if (!cancelled) setLive(fresh);
        })
        // A single dropped poll is transient; the next tick recovers and the dialog stays open.
        .catch(() => {});
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [polling, taskId]);

  // Follow the tail while output streams, but never yank the view back once the user scrolls up.
  useEffect(() => {
    const el = outputRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [live.output]);

  const liveStatus = isLiveTaskStatus(live.status);
  const canAbort = isActiveTaskStatus(live.status) || live.status === 'claimed';
  const canRetry = TERMINAL_STATUSES.has(live.status);

  return (
    <dialog
      id="execution-dialog"
      aria-labelledby="execution-dialog-title"
      aria-modal="true"
      ref={dialogRef}
      onClose={onClose}
      onClick={dialogBackdropClickHandler(dialogRef, onClose)}
      class="fixed inset-0 m-auto max-h-5/6 w-11/12 max-w-2xl overflow-y-auto rounded-xl border border-pine-highlight bg-pine-surface p-4 text-pine-text shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-xs sm:p-6"
    >
      <div class="flex items-start justify-between border-b border-pine-highlight pb-3">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h2
              id="execution-dialog-title"
              class="text-base font-bold wrap-break-word text-pine-text"
            >
              {live.title || (live.taskNumber ? `Task #${live.taskNumber}` : 'Task details')}
            </h2>
            <span
              class={`rounded-sm border px-2 py-0.5 text-xs font-bold whitespace-nowrap uppercase ${taskBadgeClass(live.status)}`}
            >
              {live.status}
            </span>
          </div>
          <p class="mt-1 font-mono text-xs text-pine-subtle">
            #{live.taskNumber ?? 0} &bull; {live.repositoryName} &bull; {live.model} ({live.effort})
          </p>
        </div>
        <div class="ml-2 flex shrink-0 items-center gap-2">
          {canAbort && onAbort && (
            <button
              type="button"
              onClick={() => onAbort(live.id)}
              disabled={actionLoading}
              class="h-9 cursor-pointer rounded-lg border border-pine-love/40 px-3 text-xs font-semibold whitespace-nowrap text-pine-love transition-colors hover:bg-pine-love/15 focus-visible:ring-2 focus-visible:ring-pine-love focus-visible:outline-hidden disabled:opacity-50"
            >
              Abort
            </button>
          )}
          {canRetry && onRetry && (
            <button
              type="button"
              onClick={() => onRetry(live.id)}
              disabled={actionLoading}
              class="h-9 cursor-pointer rounded-lg border border-pine-highlight px-3 text-xs font-semibold whitespace-nowrap text-pine-text transition-colors hover:bg-pine-overlay focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden disabled:opacity-50"
            >
              Retry
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close task details"
            class="inline-flex size-11 cursor-pointer items-center justify-center rounded-lg border border-pine-highlight text-pine-subtle hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
          >
            <Icon icon={faTimes} class="size-4" />
          </button>
        </div>
      </div>

      {live.status === 'queued' && noRunnerOnline && (
        <a
          href="/settings/coordinator"
          onClick={(e) => {
            e.preventDefault();
            void route('/settings/coordinator');
          }}
          class="mt-3 flex items-center gap-1.5 rounded-lg border border-pine-gold/40 bg-pine-gold/10 px-3 py-2 text-xs font-semibold text-pine-gold transition-colors hover:bg-pine-gold/20"
        >
          <Icon icon={faTriangleExclamation} class="size-3 shrink-0" />
          <span class="whitespace-nowrap">No active runner online</span>
        </a>
      )}

      <div class="mt-4 flex flex-col gap-4 text-xs">
        {/* Token Telemetry */}
        {(live.totalTokens !== undefined ||
          live.thinkingTokens !== undefined ||
          live.numTurns !== undefined) && (
          <div>
            <h3 class="mb-1 text-xs font-semibold text-pine-subtle uppercase">Token Usage</h3>
            <div class="grid grid-cols-1 gap-3 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-3 sm:grid-cols-3">
              <DetailItem label="Turns">
                {live.numTurns !== undefined ? live.numTurns : '\u2014'}
              </DetailItem>
              <DetailItem label="Total Tokens">
                {live.totalTokens !== undefined ? formatTokenCount(live.totalTokens) : '\u2014'}
              </DetailItem>
              <DetailItem label="Thinking Tokens">
                {live.thinkingTokens !== undefined
                  ? formatTokenCount(live.thinkingTokens)
                  : '\u2014'}
              </DetailItem>
            </div>
          </div>
        )}

        {/* Run Metadata */}
        <div>
          <h3 class="mb-1 text-xs font-semibold text-pine-subtle uppercase">Run Metadata</h3>
          {/* A full timestamp does not fit a quarter-width cell; stay at two columns. */}
          <div class="grid grid-cols-1 gap-3 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-3 sm:grid-cols-2">
            <DetailItem label="Initiated By">{renderOrigin(live)}</DetailItem>
            <DetailItem label="Created">
              {formatDateTime(live.createdAt, { timeFormat })}
            </DetailItem>
            <DetailItem label="Runner">
              {live.runnerId || live.claimedByRunnerId || '\u2014'}
            </DetailItem>
            <DetailItem label="Duration">{formatDuration(live.durationMs)}</DetailItem>
            <DetailItem label="Claimed">
              {formatDateTime(live.claimedAt, { timeFormat }) || '\u2014'}
            </DetailItem>
            {/* A finished run's last heartbeat equals its completion, so only one is shown. */}
            <DetailItem label={liveStatus ? 'Last Heartbeat' : 'Completed'}>
              {formatDateTime(liveStatus ? live.heartbeatAt : live.completedAt, { timeFormat }) ||
                '\u2014'}
            </DetailItem>
            <DetailItem label="Branch" span>
              {live.branchName || '\u2014'}
            </DetailItem>
            <DetailItem label="Pull Request">
              {live.prUrl ? (
                <a
                  href={live.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  class="inline-flex items-center gap-1 text-pine-iris hover:underline"
                >
                  <span>View PR</span>
                  <Icon icon={faExternalLinkAlt} class="size-2.5" />
                </a>
              ) : (
                <span class="text-pine-subtle">
                  {live.autoCreatePr === false ? 'Off' : '\u2014'}
                </span>
              )}
            </DetailItem>
            <DetailItem label="PR Policy">
              {live.prPolicy ? PR_POLICY_LABELS[live.prPolicy] : 'Inherited'}
            </DetailItem>
            <DetailItem label="Verify Command" span>
              {live.verifyCommand || '\u2014'}
            </DetailItem>
          </div>
        </div>

        {/* Prompt Block */}
        <div>
          <div class="mb-1 flex items-center justify-between">
            <h3 class="text-xs font-semibold text-pine-subtle uppercase">Prompt</h3>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(live.prompt);
                setCopiedPrompt(true);
                setTimeout(() => setCopiedPrompt(false), 2000);
              }}
              class="cursor-pointer rounded-sm bg-pine-overlay px-1.5 py-0.5 text-xs text-pine-subtle hover:text-pine-text"
            >
              <Icon icon={copiedPrompt ? faCheck : faCopy} class="mr-1 inline size-2.5" />
              {copiedPrompt ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div class="max-h-40 overflow-y-auto rounded-lg border border-pine-highlight bg-pine-overlay p-3 font-mono wrap-break-word break-all whitespace-pre-wrap">
            {live.prompt}
          </div>
        </div>

        {/* Model Output Block (Rendered even on failure!) */}
        {live.output && (
          <div>
            <div class="mb-1 flex items-center gap-2">
              <h3 class="text-xs font-semibold text-pine-subtle uppercase">Model Output Log</h3>
              {polling && (
                <span class="animate-pulse font-mono text-xs text-pine-gold normal-case">
                  streaming
                </span>
              )}
            </div>
            <pre
              ref={outputRef}
              onScroll={(e) => {
                const el = e.currentTarget as HTMLPreElement;
                stickToBottom.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight <= AUTOSCROLL_SLACK_PX;
              }}
              class="m-0 max-h-48 overflow-y-auto rounded-lg border border-pine-highlight bg-pine-base p-3 font-mono text-xs wrap-break-word break-all whitespace-pre-wrap text-pine-foam"
            >
              {live.output}
            </pre>
          </div>
        )}

        {/* Error Block */}
        {live.error && (
          <div>
            <h4 class="mb-1 text-xs font-semibold text-pine-love uppercase">Failure Diagnostic</h4>
            <div class="max-h-36 min-w-0 overflow-x-hidden overflow-y-auto rounded-lg border border-pine-love/40 bg-pine-love/15 p-3 font-mono text-xs wrap-break-word break-all whitespace-pre-wrap text-pine-love">
              {live.error}
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
};
