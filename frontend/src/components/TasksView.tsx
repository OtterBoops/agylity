import { useEffect, useRef, useState } from 'preact/hooks';
import { faCheck, faCopy, faPlus } from '@fortawesome/free-solid-svg-icons';
import type { SwarmTask } from '../types';
import { getTasks } from '../api';
import { Icon } from './Icon';

interface TasksViewProps {
  onRefresh?: () => void;
  onOpenDispatch?: () => void;
}

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

export const TasksView = ({ onRefresh, onOpenDispatch }: TasksViewProps = {}) => {
  const [tasks, setTasks] = useState<SwarmTask[]>([]);
  const [filter, setFilter] = useState<
    'all' | 'queued' | 'executing' | 'completed' | 'failed' | 'aborted'
  >('all');
  const [selectedTask, setSelectedTask] = useState<SwarmTask | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const loadTasks = () => {
    getTasks(100)
      .then((res) => {
        setTasks(res);
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadTasks();
    const timer = setInterval(loadTasks, 4000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (selectedTask) {
      if (!dialog.open) dialog.showModal();
    } else {
      if (dialog.open) dialog.close();
    }
  }, [selectedTask]);

  const handleCancelTask = async (taskId: string) => {
    setActionLoading(true);
    try {
      await fetch(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' });
      loadTasks();
      onRefresh?.();
      setSelectedTask(null);
    } catch {
    } finally {
      setActionLoading(false);
    }
  };

  const handleRetryTask = async (taskId: string) => {
    setActionLoading(true);
    try {
      await fetch(`/api/tasks/${encodeURIComponent(taskId)}/retry`, { method: 'POST' });
      loadTasks();
      onRefresh?.();
      setSelectedTask(null);
    } catch {
    } finally {
      setActionLoading(false);
    }
  };

  const visibleTasks = tasks.filter((t) => {
    if (filter === 'all') return true;
    return t.status === filter;
  });

  return (
    <div class="flex flex-col gap-6 2xl:gap-8">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 class="text-xl font-bold text-pine-text sm:text-2xl 2xl:text-3xl">Tasks Queue</h2>
          <p class="mt-0.5 text-xs text-pine-subtle sm:text-sm 2xl:text-base">
            Real-time Swarm tasks, worker assignments, execution telemetry, and lifecycle controls.
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <div class="flex flex-wrap gap-1.5 rounded-lg border border-pine-highlight bg-pine-surface p-1 2xl:p-1.5">
            {(['all', 'queued', 'executing', 'completed', 'failed', 'aborted'] as const).map(
              (f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  class={`cursor-pointer rounded-md px-3 py-1 text-xs font-semibold uppercase transition-colors 2xl:px-3.5 2xl:py-1.5 2xl:text-sm ${
                    filter === f
                      ? 'bg-pine-iris text-pine-base shadow-xs'
                      : 'text-pine-subtle hover:bg-pine-overlay/60 hover:text-pine-text'
                  }`}
                >
                  {f}
                </button>
              )
            )}
          </div>

          {onOpenDispatch && (
            <button
              type="button"
              onClick={onOpenDispatch}
              class="flex cursor-pointer items-center gap-2 rounded-lg bg-pine-iris px-3.5 py-2 text-xs font-semibold text-pine-base shadow-xs transition-opacity hover:opacity-90 2xl:px-4 2xl:py-2.5 2xl:text-sm"
              title="Dispatch continuation task to worker"
            >
              <Icon icon={faPlus} class="size-3.5" />
              <span>New Task</span>
            </button>
          )}
        </div>
      </div>

      <div class="overflow-hidden rounded-xl border border-pine-highlight bg-pine-surface shadow-sm">
        <table class="w-full text-left text-sm 2xl:text-base">
          <thead>
            <tr class="border-b border-pine-highlight bg-pine-overlay/40 font-mono text-xs tracking-wider text-pine-muted uppercase 2xl:text-sm">
              <th class="p-3.5 2xl:p-4.5">Status</th>
              <th class="p-3.5 2xl:p-4.5">Task ID</th>
              <th class="p-3.5 2xl:p-4.5">Repository</th>
              <th class="p-3.5 2xl:p-4.5">Model</th>
              <th class="p-3.5 2xl:p-4.5">Schedule</th>
              <th class="p-3.5 2xl:p-4.5">Branch / PR</th>
              <th class="p-3.5 2xl:p-4.5">Duration</th>
              <th class="p-3.5 text-right 2xl:p-4.5">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-pine-highlight/40">
            {visibleTasks.length === 0 ? (
              <tr>
                <td colSpan={8} class="p-8 text-center text-sm text-pine-muted 2xl:text-base">
                  No tasks matching the selected filter.
                </td>
              </tr>
            ) : (
              visibleTasks.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => setSelectedTask(t)}
                  class="cursor-pointer transition-colors hover:bg-pine-overlay/30"
                >
                  <td class="p-3.5 2xl:p-4.5">
                    <span
                      class={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold tracking-wide whitespace-nowrap uppercase ${
                        t.status === 'completed'
                          ? 'border-pine-pine/40 bg-pine-pine/15 text-pine-foam'
                          : t.status === 'failed' || t.status === 'aborted'
                            ? 'border-pine-love/40 bg-pine-love/15 text-pine-love'
                            : t.status === 'executing'
                              ? 'animate-pulse border-pine-gold/40 bg-pine-gold/15 text-pine-gold'
                              : 'border-pine-highlight bg-pine-overlay/60 text-pine-subtle'
                      }`}
                    >
                      {t.status}
                    </span>
                  </td>
                  <td class="p-3.5 font-mono text-pine-text 2xl:p-4.5">{t.id}</td>
                  <td class="p-3.5 font-medium text-pine-text 2xl:p-4.5">{t.repositoryName}</td>
                  <td class="p-3.5 font-mono text-pine-iris 2xl:p-4.5">{t.model}</td>
                  <td class="p-3.5 font-mono text-pine-muted 2xl:p-4.5">{t.scheduleMode}</td>
                  <td class="p-3.5 font-mono text-pine-subtle 2xl:p-4.5">
                    {t.prUrl ? (
                      <a
                        href={t.prUrl}
                        target="_blank"
                        rel="noreferrer"
                        class="text-pine-iris hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        PR
                      </a>
                    ) : t.branchName ? (
                      <span class="inline-block max-w-[140px] truncate">{t.branchName}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td class="p-3.5 font-mono text-pine-muted 2xl:p-4.5">
                    {formatDuration(t.durationMs)}
                  </td>
                  <td class="p-3.5 text-right 2xl:p-4.5" onClick={(e) => e.stopPropagation()}>
                    {t.status === 'queued' || t.status === 'claimed' || t.status === 'executing' ? (
                      <button
                        type="button"
                        onClick={() => handleCancelTask(t.id)}
                        disabled={actionLoading}
                        class="cursor-pointer rounded-sm border border-pine-love/30 bg-pine-love/10 px-2.5 py-1 text-xs font-semibold text-pine-love hover:bg-pine-love hover:text-white 2xl:text-sm"
                      >
                        Abort
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleRetryTask(t.id)}
                        disabled={actionLoading}
                        class="cursor-pointer rounded-sm border border-pine-highlight bg-pine-overlay px-2.5 py-1 text-xs font-semibold text-pine-text hover:bg-pine-highlight 2xl:text-sm"
                      >
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Task Details Modal */}
      {selectedTask && (
        <dialog
          ref={dialogRef}
          onClose={() => setSelectedTask(null)}
          onClick={(e) => {
            if (!dialogRef.current) return;
            const rect = dialogRef.current.getBoundingClientRect();
            const isInDialog =
              rect.top <= e.clientY &&
              e.clientY <= rect.top + rect.height &&
              rect.left <= e.clientX &&
              e.clientX <= rect.left + rect.width;
            if (!isInDialog) {
              setSelectedTask(null);
            }
          }}
          class="fixed inset-0 m-auto w-full max-w-2xl rounded-xl border border-pine-highlight bg-pine-surface p-6 text-pine-text shadow-2xl backdrop:bg-black/60"
        >
          <div class="flex items-start justify-between border-b border-pine-highlight pb-3">
            <div>
              <div class="flex items-center gap-2">
                <h3 class="text-base font-bold text-pine-text">Task {selectedTask.id}</h3>
                <span
                  class={`rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase ${
                    selectedTask.status === 'completed'
                      ? 'border border-pine-pine bg-pine-pine/20 text-pine-foam'
                      : selectedTask.status === 'failed' || selectedTask.status === 'aborted'
                        ? 'border border-pine-love bg-pine-love/20 text-pine-love'
                        : selectedTask.status === 'executing'
                          ? 'border border-pine-gold bg-pine-gold/20 text-pine-gold'
                          : 'border border-pine-highlight bg-pine-overlay text-pine-subtle'
                  }`}
                >
                  {selectedTask.status}
                </span>
              </div>
              <p class="mt-1 text-xs text-pine-subtle">
                {selectedTask.repositoryName} &bull; Model: {selectedTask.model} &bull; Effort:{' '}
                {selectedTask.effort}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedTask(null)}
              class="cursor-pointer rounded-lg border border-pine-highlight px-2 py-1 text-xs text-pine-subtle hover:text-pine-text"
            >
              Close
            </button>
          </div>

          <div class="mt-4 flex flex-col gap-4 text-xs">
            <div>
              <h4 class="text-[10px] font-semibold text-pine-muted uppercase">Prompt</h4>
              <div class="relative mt-1 max-h-40 overflow-y-auto rounded-lg border border-pine-highlight bg-pine-overlay p-3 font-mono whitespace-pre-wrap">
                {selectedTask.prompt}
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(selectedTask.prompt);
                    setCopiedPrompt(true);
                    setTimeout(() => setCopiedPrompt(false), 2000);
                  }}
                  class="absolute top-2 right-2 cursor-pointer rounded-sm bg-pine-surface px-1.5 py-0.5 text-[10px] text-pine-subtle hover:text-pine-text"
                >
                  <Icon icon={copiedPrompt ? faCheck : faCopy} class="mr-1 inline size-2.5" />
                  {copiedPrompt ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>

            {selectedTask.output && (
              <div>
                <h4 class="text-[10px] font-semibold text-pine-muted uppercase">Output Log</h4>
                <div class="mt-1 max-h-48 overflow-y-auto rounded-lg border border-pine-highlight bg-pine-base p-3 font-mono text-[11px] whitespace-pre-wrap text-pine-foam">
                  {selectedTask.output}
                </div>
              </div>
            )}

            {selectedTask.error && (
              <div>
                <h4 class="text-[10px] font-semibold text-pine-muted uppercase">Error</h4>
                <div class="mt-1 max-h-32 overflow-y-auto rounded-lg border border-pine-love/40 bg-pine-love/15 p-3 font-mono whitespace-pre-wrap text-pine-love">
                  {selectedTask.error}
                </div>
              </div>
            )}

            <div class="grid grid-cols-2 gap-2 border-t border-pine-highlight pt-3 font-mono text-[11px] text-pine-muted">
              <div>Created: {new Date(selectedTask.createdAt).toLocaleString()}</div>
              <div>Duration: {formatDuration(selectedTask.durationMs)}</div>
              {selectedTask.branchName && <div>Branch: {selectedTask.branchName}</div>}
              {selectedTask.prUrl && (
                <div>
                  PR:{' '}
                  <a
                    href={selectedTask.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    class="text-pine-iris hover:underline"
                  >
                    {selectedTask.prUrl}
                  </a>
                </div>
              )}
            </div>
          </div>
        </dialog>
      )}
    </div>
  );
};
