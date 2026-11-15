import { useCallback, useEffect, useState } from 'preact/hooks';
import { route } from 'preact-router';
import type { SentryAlertState, SwarmRunnerRecord, SwarmTask } from '../types';
import { AlertsTable } from '../components/AlertsTable';
import { ACTIVE_TASK_STATUSES } from '../components/tasks/badges';
import { ExecutionInspectorModal } from '../components/tasks/ExecutionInspectorModal';
import { runnerCoversRepo } from '../components/tasks/runners';
import { TaskOriginLabel, UNRESOLVED_ORIGINS } from '../components/tasks/TaskOrigin';
import { cancelTask, getRunners, getTasks } from '../api';
import { taskStatusBadgeClass } from '../utils/status';

interface ActivityViewProps {
  alerts: SentryAlertState | null;
}

const POLL_INTERVAL_MS = 10000;

export const ActivityView = ({ alerts }: ActivityViewProps) => {
  const [tasks, setTasks] = useState<SwarmTask[]>([]);
  const [runners, setRunners] = useState<SwarmRunnerRecord[]>([]);
  const [selectedTask, setSelectedTask] = useState<SwarmTask | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([getTasks(20), getRunners()])
      .then(([taskList, runnerList]) => {
        setTasks(taskList);
        setRunners(runnerList);
      })
      // A dropped poll is transient; the next tick recovers.
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // The poll replaces every task object; without re-pinning, an open inspector freezes at open.
  useEffect(() => {
    if (!selectedTask) return;
    const fresh = tasks.find((t) => t.id === selectedTask.id);
    if (fresh && fresh.updatedAt !== selectedTask.updatedAt) setSelectedTask(fresh);
  }, [tasks, selectedTask]);

  const handleAbort = async (taskId: string) => {
    setActionLoading(true);
    setActionError(null);
    try {
      await cancelTask(taskId);
      await load();
      setSelectedTask(null);
    } catch (err: any) {
      setActionError(err?.message || String(err));
    } finally {
      setActionLoading(false);
    }
  };

  const activeTasks = tasks.filter((t) => ACTIVE_TASK_STATUSES.has(t.status));

  return (
    <div class="flex flex-col gap-6">
      <div>
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-pine-text sm:text-xl">Active & Queued Tasks</h2>
          <a href="/tasks" class="text-xs font-medium text-pine-iris hover:underline sm:text-sm">
            View in Tasks ({activeTasks.length} in-flight) &rarr;
          </a>
        </div>

        {actionError && (
          <p role="alert" class="mb-2 text-xs text-pine-love sm:text-sm">
            Abort failed: {actionError}
          </p>
        )}

        <div class="overflow-x-auto rounded-xl border border-pine-highlight bg-pine-surface shadow-sm">
          <table class="w-full text-left text-sm">
            <thead>
              <tr class="border-b border-pine-highlight bg-pine-overlay/40 font-mono text-xs tracking-wider text-pine-muted uppercase">
                <th class="p-3.5 whitespace-nowrap">Task</th>
                <th class="p-3.5 whitespace-nowrap">Repository</th>
                <th class="p-3.5 whitespace-nowrap">Priority / Model</th>
                <th class="p-3.5 whitespace-nowrap">Status</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-pine-highlight/40">
              {activeTasks.length === 0 ? (
                <tr>
                  <td colspan={4} class="p-3.5 text-center text-xs text-pine-subtle sm:text-sm">
                    No tasks currently active or queued
                  </td>
                </tr>
              ) : (
                activeTasks.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => setSelectedTask(t)}
                    class="cursor-pointer transition-colors hover:bg-pine-overlay/30"
                  >
                    <td class="max-w-md p-3.5">
                      {/* The href is the deep link for middle-click; a plain click opens in place. */}
                      <a
                        href={`/tasks?tab=schedules&id=${t.id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSelectedTask(t);
                        }}
                        class="flex min-w-0 items-center gap-2 hover:underline"
                        title={t.title || t.prompt}
                      >
                        <span class="shrink-0 rounded-sm bg-pine-overlay px-1.5 py-0.5 font-mono text-xs font-bold whitespace-nowrap text-pine-iris">
                          #{t.taskNumber || 0}
                        </span>
                        <span class="truncate text-xs font-medium text-pine-text">
                          {t.title || t.prompt}
                        </span>
                      </a>
                    </td>
                    <td class="p-3.5 font-mono text-xs text-pine-subtle">{t.repositoryName}</td>
                    <td class="p-3.5 font-mono text-xs whitespace-nowrap text-pine-subtle">
                      <span class="font-bold text-pine-gold">{t.scheduleMode}</span> · {t.model}
                    </td>
                    <td class="p-3.5 whitespace-nowrap">
                      <span
                        class={`inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold tracking-wide whitespace-nowrap uppercase ${taskStatusBadgeClass(t.status)}`}
                      >
                        {t.status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedTask && (
        <ExecutionInspectorModal
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onAbort={handleAbort}
          actionLoading={actionLoading}
          noRunnerOnline={!runnerCoversRepo(runners, selectedTask.repositoryId)}
          renderOrigin={(task) => (
            <TaskOriginLabel
              task={task}
              lists={UNRESOLVED_ORIGINS}
              onOpen={(originId) => void route(`/tasks?tab=schedules&id=${originId}`)}
            />
          )}
        />
      )}

      <AlertsTable alerts={alerts} />
    </div>
  );
};
