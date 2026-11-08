import { useEffect, useState } from 'preact/hooks';
import type { SentryAlertState, SwarmTask } from '../types';
import { AlertsTable } from '../components/AlertsTable';
import { getTasks } from '../api';
import { taskStatusBadgeClass } from '../utils/status';

interface ActivityViewProps {
  alerts: SentryAlertState | null;
}

export const ActivityView = ({ alerts }: ActivityViewProps) => {
  const [tasks, setTasks] = useState<SwarmTask[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getTasks(20)
        .then((taskList) => {
          if (!cancelled) {
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

  const activeTasks = tasks.filter(
    (t) => t.status === 'queued' || t.status === 'claimed' || t.status === 'executing'
  );

  return (
    <div class="flex flex-col gap-6">
      {activeTasks.length > 0 && (
        <div>
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-lg font-semibold text-pine-text sm:text-xl">Active & Queued Tasks</h2>
            <a href="/tasks" class="text-xs font-medium text-pine-iris hover:underline sm:text-sm">
              View in Tasks ({activeTasks.length} in-flight) &rarr;
            </a>
          </div>
          <div class="overflow-x-auto rounded-xl border border-pine-highlight bg-pine-surface shadow-sm">
            <table class="w-full min-w-[858px] text-left text-sm">
              <thead>
                <tr class="border-b border-pine-highlight bg-pine-overlay/40 font-mono text-xs tracking-wider text-pine-muted uppercase sm:text-[14.3px]">
                  <th class="p-3.5 whitespace-nowrap">Task ID</th>
                  <th class="p-3.5 whitespace-nowrap">Repository</th>
                  <th class="p-3.5 whitespace-nowrap">Prompt</th>
                  <th class="p-3.5 whitespace-nowrap">Priority / Model</th>
                  <th class="p-3.5 whitespace-nowrap">Status</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-pine-highlight/40">
                {activeTasks.map((t) => (
                  <tr key={t.id} class="transition-colors hover:bg-pine-overlay/30">
                    <td class="p-3.5 font-mono text-sm whitespace-nowrap text-pine-iris">
                      <a href={`/tasks?tab=executions&id=${t.id}`} class="hover:underline">
                        {t.id.slice(0, 16)}...
                      </a>
                    </td>
                    <td class="p-3.5 font-mono text-sm text-pine-subtle">{t.repositoryName}</td>
                    <td class="max-w-md truncate p-3.5 text-sm text-pine-text" title={t.prompt}>
                      {t.prompt}
                    </td>
                    <td class="p-3.5 font-mono text-sm whitespace-nowrap text-pine-subtle">
                      <span class="font-bold text-pine-gold">{t.scheduleMode}</span> • {t.model}
                    </td>
                    <td class="p-3.5 whitespace-nowrap">
                      <span
                        class={`inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold tracking-wide whitespace-nowrap uppercase ${taskStatusBadgeClass(t.status)}`}
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
      )}

      <AlertsTable alerts={alerts} />
    </div>
  );
};
