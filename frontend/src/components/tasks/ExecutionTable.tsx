import type { ComponentChildren } from 'preact';
import { faExternalLinkAlt } from '@fortawesome/free-solid-svg-icons';
import type { SwarmTask } from '../../types';
import { formatDateTime, formatDuration, useTimeFormat } from '../../utils/time';
import { Icon } from '../Icon';
import { ACTIVE_TASK_STATUSES, taskBadgeClass } from './badges';

interface ExecutionTableProps {
  /** Already filtered by the page's status filter. */
  tasks: SwarmTask[];
  loadError: string | null;
  actionLoading: boolean;
  onOpen: (task: SwarmTask) => void;
  onAbort: (taskId: string) => void;
  onRetry: (taskId: string) => void;
  /** Origin links belong to the page, which owns the backlog and routine lists. */
  renderOrigin: (task: SwarmTask) => ComponentChildren;
}

/** The dense run log: a table, because the rows are scanned rather than read one at a time. */
export const ExecutionTable = ({
  tasks,
  loadError,
  actionLoading,
  onOpen,
  onAbort,
  onRetry,
  renderOrigin,
}: ExecutionTableProps) => {
  const [timeFormat] = useTimeFormat();

  return (
    <div class="overflow-x-auto rounded-xl border border-pine-highlight bg-pine-surface shadow-sm">
      <table class="w-full text-left text-xs">
        <thead>
          <tr class="border-b border-pine-highlight bg-pine-overlay/40 font-mono text-xs tracking-wider text-pine-subtle uppercase">
            <th class="p-3.5 whitespace-nowrap">Task</th>
            <th class="p-3.5 whitespace-nowrap">When</th>
            <th class="p-3.5 whitespace-nowrap">Repository</th>
            <th class="p-3.5 whitespace-nowrap">Model / Effort</th>
            <th class="p-3.5 whitespace-nowrap">By</th>
            <th class="p-3.5 whitespace-nowrap">Branch / PR</th>
            <th class="p-3.5 whitespace-nowrap">Duration</th>
            <th class="p-3.5 whitespace-nowrap">Status</th>
            <th class="p-3.5 text-right whitespace-nowrap">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-pine-highlight/40">
          {tasks.length === 0 ? (
            <tr>
              <td colSpan={9} class="p-8 text-center text-sm text-pine-subtle">
                {loadError
                  ? `Could not load executions: ${loadError}`
                  : 'No executions matching the selected filter.'}
              </td>
            </tr>
          ) : (
            tasks.map((task) => (
              <tr
                key={task.id}
                onClick={() => onOpen(task)}
                class="cursor-pointer transition-colors hover:bg-pine-overlay/30"
              >
                <td class="max-w-xs min-w-56 p-3.5 md:max-w-sm xl:max-w-md">
                  <div class="flex items-center gap-1.5">
                    <span class="shrink-0 rounded-sm bg-pine-overlay px-1.5 py-0.5 font-mono text-xs font-bold whitespace-nowrap text-pine-iris">
                      #{task.taskNumber || 0}
                    </span>
                    <span
                      class="truncate text-sm font-medium text-pine-text"
                      title={task.title || task.prompt}
                    >
                      {task.title || 'Task'}
                    </span>
                  </div>
                </td>
                <td class="p-3.5 text-sm whitespace-nowrap text-pine-subtle">
                  {formatDateTime(task.createdAt, { timeFormat })}
                </td>
                <td class="p-3.5 font-mono text-sm text-pine-text">{task.repositoryName}</td>
                <td class="p-3.5 font-mono text-sm whitespace-nowrap text-pine-iris">
                  {task.model}
                  <span class="text-pine-subtle"> · {task.effort}</span>
                </td>
                <td class="p-3.5 text-sm whitespace-nowrap">{renderOrigin(task)}</td>
                <td class="p-3.5 font-mono text-sm text-pine-subtle">
                  {task.prUrl ? (
                    <a
                      href={task.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      class="inline-flex items-center gap-1 text-pine-iris hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span>PR</span>
                      <Icon icon={faExternalLinkAlt} class="size-2.5" />
                    </a>
                  ) : task.branchName ? (
                    <span class="inline-block max-w-36 truncate" title={task.branchName}>
                      {task.branchName}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td class="p-3.5 font-mono text-sm whitespace-nowrap text-pine-subtle">
                  {formatDuration(task.durationMs)}
                </td>
                <td class="p-3.5 whitespace-nowrap">
                  <span
                    class={`inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold tracking-wide whitespace-nowrap uppercase ${taskBadgeClass(task.status)}`}
                  >
                    {task.status}
                  </span>
                </td>
                <td class="p-3.5 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  {ACTIVE_TASK_STATUSES.has(task.status) || task.status === 'claimed' ? (
                    <button
                      type="button"
                      onClick={() => onAbort(task.id)}
                      disabled={actionLoading}
                      class="cursor-pointer rounded-sm border border-pine-love/30 bg-pine-love/10 px-2.5 py-1 text-xs font-semibold text-pine-love hover:bg-pine-love hover:text-pine-base"
                    >
                      Abort
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onRetry(task.id)}
                      disabled={actionLoading}
                      class="cursor-pointer rounded-sm border border-pine-highlight bg-pine-overlay px-2.5 py-1 text-xs font-semibold text-pine-text hover:bg-pine-highlight"
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
  );
};
