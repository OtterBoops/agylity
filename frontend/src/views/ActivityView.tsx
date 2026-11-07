import { useEffect, useRef, useState } from 'preact/hooks';
import { faCheck, faCopy, faTimes } from '@fortawesome/free-solid-svg-icons';
import type { DispatchRecord, SentryAlertState, SwarmTask } from '../types';
import { AlertsTable } from '../components/AlertsTable';
import { getDispatches, getTasks } from '../api';
import { Icon } from '../components/Icon';
import {
  dispatchOutcomeBadgeClass,
  dispatchOutcomeLabel,
  taskStatusBadgeClass,
} from '../utils/status';
import { dialogBackdropClickHandler } from '../utils/dialog';
import { formatDuration, formatDateTime, useTimeFormat } from '../utils/time';

interface ActivityViewProps {
  alerts: SentryAlertState | null;
}

export const ActivityView = ({ alerts }: ActivityViewProps) => {
  const [timeFormat] = useTimeFormat();
  const [dispatches, setDispatches] = useState<DispatchRecord[]>([]);
  const [tasks, setTasks] = useState<SwarmTask[]>([]);
  const [selectedDispatch, setSelectedDispatch] = useState<DispatchRecord | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (selectedDispatch) {
      if (!dialog.open) dialog.showModal();
    } else {
      if (dialog.open) dialog.close();
    }
  }, [selectedDispatch]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      Promise.all([getDispatches(50), getTasks(20)])
        .then(([records, taskList]) => {
          if (!cancelled) {
            setDispatches(records);
            setTasks(taskList);
          }
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 10000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const handleCopyPrompt = async () => {
    if (!selectedDispatch) return;
    try {
      await navigator.clipboard.writeText(selectedDispatch.prompt);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2000);
    } catch {
      // fallback
    }
  };

  const activeTasks = tasks.filter(
    (t) => t.status === 'queued' || t.status === 'claimed' || t.status === 'executing'
  );

  const handleDialogClick = dialogBackdropClickHandler(dialogRef, () => setSelectedDispatch(null));

  const renderOriginLink = (d: DispatchRecord) => {
    if (d.tier === 'backlog' || (d.requestedBy && d.requestedBy.startsWith('backlog:'))) {
      const originId = d.originId || d.requestedBy.replace(/^backlog:/, '');
      const label = d.originNumber
        ? `Backlog: Task #${d.originNumber}`
        : d.originTitle
          ? `Backlog: ${d.originTitle}`
          : 'Backlog: Task';
      return (
        <a
          href={`/tasks?tab=backlog&id=${encodeURIComponent(originId)}`}
          class="font-medium whitespace-nowrap text-pine-iris hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {label}
        </a>
      );
    }
    if (
      d.tier === 'routine' ||
      (d.requestedBy &&
        (d.requestedBy.startsWith('routine:') || d.requestedBy.startsWith('standing-task:')))
    ) {
      const originId = d.originId || d.requestedBy.replace(/^routine:|^standing-task:/, '');
      const label = d.originTitle
        ? `Routine: ${d.originTitle}`
        : d.originNumber
          ? `Routine #${d.originNumber}`
          : 'Routine';
      return (
        <a
          href={`/tasks?tab=routines&id=${encodeURIComponent(originId)}`}
          class="font-medium whitespace-nowrap text-pine-iris hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {label}
        </a>
      );
    }
    return <span class="text-pine-subtle">{d.requestedBy || 'web-ui'}</span>;
  };

  return (
    <div class="flex flex-col gap-2">
      {activeTasks.length > 0 && (
        <div class="mb-6">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-lg font-semibold text-pine-text sm:text-xl">Active & Queued Tasks</h2>
            <span class="text-xs text-pine-muted">
              {activeTasks.length} in-flight / queued task{activeTasks.length === 1 ? '' : 's'}
            </span>
          </div>
          <div class="overflow-hidden rounded-xl border border-pine-highlight bg-pine-surface shadow-sm">
            <div class="overflow-x-auto">
              <table class="w-full min-w-[640px] border-collapse text-left text-sm">
                <thead>
                  <tr class="border-b border-pine-highlight bg-pine-overlay text-xs font-semibold text-pine-subtle sm:text-sm">
                    <th class="px-4 py-3 whitespace-nowrap">Task ID</th>
                    <th class="px-4 py-3 whitespace-nowrap">Repository</th>
                    <th class="px-4 py-3 whitespace-nowrap">Prompt</th>
                    <th class="px-4 py-3 whitespace-nowrap">Priority / Model</th>
                    <th class="px-4 py-3 whitespace-nowrap">Status</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-pine-highlight">
                  {activeTasks.map((t) => (
                    <tr key={t.id} class="align-top">
                      <td class="px-4 py-3 font-mono text-xs whitespace-nowrap text-pine-iris">
                        {t.id.slice(0, 16)}...
                      </td>
                      <td class="px-4 py-3 font-mono text-xs text-pine-subtle">
                        {t.repositoryName}
                      </td>
                      <td class="max-w-sm truncate px-4 py-3 text-pine-text" title={t.prompt}>
                        {t.prompt}
                      </td>
                      <td class="px-4 py-3 text-xs whitespace-nowrap text-pine-subtle">
                        <span class="font-bold text-pine-gold">{t.scheduleMode}</span> • {t.model}
                      </td>
                      <td class="px-4 py-3 whitespace-nowrap">
                        <span
                          class={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold tracking-wide whitespace-nowrap uppercase ${taskStatusBadgeClass(t.status)}`}
                        >
                          {t.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <div class="mb-8 2xl:mb-12">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-xl font-semibold text-pine-text sm:text-2xl 2xl:text-3xl">
            Dispatch History
          </h2>
          <span class="text-xs text-pine-muted sm:text-sm 2xl:text-base">
            Click any row to inspect task prompt &amp; telemetry
          </span>
        </div>
        <div class="overflow-hidden rounded-xl border border-pine-highlight bg-pine-surface shadow-sm">
          <div class="overflow-x-auto">
            <table class="w-full min-w-[700px] border-collapse text-left text-sm 2xl:text-base">
              <thead>
                <tr class="border-b border-pine-highlight bg-pine-overlay text-xs font-semibold text-pine-subtle sm:text-sm 2xl:text-base">
                  <th class="px-4 py-3 whitespace-nowrap 2xl:px-5 2xl:py-4">When</th>
                  <th class="px-4 py-3 whitespace-nowrap 2xl:px-5 2xl:py-4">Repository</th>
                  <th class="px-4 py-3 whitespace-nowrap 2xl:px-5 2xl:py-4">Prompt</th>
                  <th class="px-4 py-3 whitespace-nowrap 2xl:px-5 2xl:py-4">By</th>
                  <th class="px-4 py-3 whitespace-nowrap 2xl:px-5 2xl:py-4">Result</th>
                  <th class="px-4 py-3 whitespace-nowrap 2xl:px-5 2xl:py-4">Took</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-pine-highlight">
                {dispatches.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      class="px-4 py-8 text-center text-xs text-pine-muted sm:text-sm 2xl:py-12 2xl:text-base"
                    >
                      No tasks dispatched yet
                    </td>
                  </tr>
                ) : (
                  dispatches.map((d) => (
                    <tr
                      key={d.id}
                      onClick={() => setSelectedDispatch(d)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedDispatch(d);
                        }
                      }}
                      tabIndex={0}
                      aria-label={`Open details for ${d.id}`}
                      class="cursor-pointer align-top transition-colors hover:bg-white/4"
                      title="Click to inspect task details"
                    >
                      <td class="px-4 py-3.5 text-xs whitespace-nowrap text-pine-subtle sm:text-sm 2xl:px-5 2xl:py-4 2xl:text-base">
                        {formatDateTime(d.createdAt, { timeFormat })}
                      </td>
                      <td class="px-4 py-3.5 font-mono text-xs text-pine-iris sm:text-sm 2xl:px-5 2xl:py-4 2xl:text-base">
                        {d.repository}
                      </td>
                      <td
                        class="max-w-sm truncate px-4 py-3.5 text-pine-text 2xl:max-w-md 2xl:px-5 2xl:py-4"
                        title={d.prompt}
                      >
                        {d.prompt}
                      </td>
                      <td class="px-4 py-3.5 text-xs text-pine-subtle sm:text-sm 2xl:px-5 2xl:py-4 2xl:text-base">
                        {renderOriginLink(d)}
                      </td>
                      <td class="px-4 py-3.5 2xl:px-5 2xl:py-4">
                        <span
                          class={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold tracking-wide whitespace-nowrap uppercase ${dispatchOutcomeBadgeClass(d.success)}`}
                        >
                          {dispatchOutcomeLabel(d.success)}
                        </span>
                        {d.branchName && (
                          <div class="mt-1 font-mono text-xs text-pine-muted 2xl:text-sm">
                            {d.branchName}
                          </div>
                        )}
                      </td>
                      <td class="px-4 py-3.5 text-xs whitespace-nowrap text-pine-subtle sm:text-sm 2xl:px-5 2xl:py-4 2xl:text-base">
                        {formatDuration(d.durationMs)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <AlertsTable alerts={alerts} />

      {/* Dispatch Detail Modal Inspector */}
      <dialog
        ref={dialogRef}
        onClose={() => setSelectedDispatch(null)}
        onClick={handleDialogClick}
        class="fixed inset-0 m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-xl border border-pine-highlight bg-pine-surface p-4 text-pine-text shadow-xl backdrop:bg-black/60 backdrop:backdrop-blur-xs sm:p-6"
      >
        {selectedDispatch && (
          <div class="flex flex-col">
            {/* Modal Header */}
            <div class="flex items-center justify-between border-b border-pine-highlight pb-4">
              <div class="flex min-w-0 flex-col gap-1">
                <div class="flex flex-wrap items-center gap-3">
                  <h3 class="truncate text-lg font-bold text-pine-text">
                    {selectedDispatch.title
                      ? selectedDispatch.title
                      : `Task #${selectedDispatch.taskNumber ?? selectedDispatch.id}`}
                  </h3>
                  <span
                    class={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold tracking-wide whitespace-nowrap uppercase ${dispatchOutcomeBadgeClass(selectedDispatch.success)}`}
                  >
                    {dispatchOutcomeLabel(selectedDispatch.success)}
                  </span>
                </div>
                <span class="font-mono text-xs text-pine-muted">ID: {selectedDispatch.id}</span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedDispatch(null)}
                class="cursor-pointer rounded-lg p-1.5 text-pine-muted transition-colors hover:bg-pine-overlay hover:text-pine-text"
              >
                <Icon icon={faTimes} class="size-4" />
              </button>
            </div>

            {/* Modal Content */}
            <div class="mt-4 flex flex-1 flex-col gap-4 overflow-y-auto pr-1">
              {/* Telemetry metadata */}
              <div class="grid grid-cols-2 gap-3 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-3 text-xs sm:grid-cols-4">
                <div>
                  <span class="text-pine-muted">Repository</span>
                  <div class="mt-0.5 font-mono font-medium text-pine-iris">
                    {selectedDispatch.repository}
                  </div>
                </div>
                <div>
                  <span class="text-pine-muted">Initiated By</span>
                  <div class="mt-0.5 font-medium text-pine-text">
                    {renderOriginLink(selectedDispatch)}
                  </div>
                </div>
                <div>
                  <span class="text-pine-muted">Duration</span>
                  <div class="mt-0.5 font-medium text-pine-text">
                    {formatDuration(selectedDispatch.durationMs)}
                  </div>
                </div>
                <div>
                  <span class="text-pine-muted">Timestamp</span>
                  <div class="mt-0.5 font-mono text-xs whitespace-nowrap text-pine-text">
                    {formatDateTime(selectedDispatch.createdAt, { timeFormat })}
                  </div>
                </div>
              </div>

              {selectedDispatch.branchName && (
                <div class="flex items-center gap-2 text-xs">
                  <span class="text-pine-muted">Target Branch:</span>
                  <span class="rounded-sm border border-pine-highlight bg-pine-overlay px-2 py-0.5 font-mono text-pine-foam">
                    {selectedDispatch.branchName}
                  </span>
                </div>
              )}

              {/* Prompt Block */}
              <div class="flex flex-col gap-1.5">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-semibold tracking-wider text-pine-subtle uppercase">
                    Task Prompt
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyPrompt}
                    class="inline-flex cursor-pointer items-center gap-1 text-xs text-pine-iris hover:underline"
                  >
                    <Icon icon={copiedPrompt ? faCheck : faCopy} class="size-3" />
                    <span>{copiedPrompt ? 'Copied' : 'Copy Prompt'}</span>
                  </button>
                </div>
                <div class="max-h-60 overflow-y-auto rounded-lg border border-pine-highlight bg-pine-overlay/60 p-3.5 font-mono text-xs/relaxed wrap-break-word break-all whitespace-pre-wrap text-pine-text">
                  {selectedDispatch.prompt}
                </div>
              </div>

              {/* Model Output Block */}
              {selectedDispatch.output && (
                <div class="flex flex-col gap-1.5">
                  <span class="text-xs font-semibold tracking-wider text-pine-subtle uppercase">
                    Model Output
                  </span>
                  <div class="max-h-60 overflow-y-auto rounded-lg border border-pine-highlight bg-pine-overlay/60 p-3.5 font-mono text-xs/relaxed wrap-break-word break-all whitespace-pre-wrap text-pine-text">
                    {selectedDispatch.output}
                  </div>
                </div>
              )}

              {/* Error Block if any */}
              {selectedDispatch.error && (
                <div class="flex flex-col gap-1.5">
                  <span class="text-xs font-semibold tracking-wider text-pine-love uppercase">
                    Failure Diagnostic
                  </span>
                  <div class="max-h-60 min-w-0 overflow-x-hidden overflow-y-auto rounded-lg border border-pine-love/40 bg-pine-love/10 p-3 font-mono text-xs/relaxed wrap-break-word break-all whitespace-pre-wrap text-pine-love">
                    {selectedDispatch.error}
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div class="mt-5 flex items-center justify-end border-t border-pine-highlight pt-4">
              <button
                type="button"
                onClick={() => setSelectedDispatch(null)}
                class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-4 py-2 text-xs font-medium text-pine-text transition-colors hover:bg-pine-highlight/50"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
};
