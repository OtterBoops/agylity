import { faExternalLinkAlt } from '@fortawesome/free-solid-svg-icons';
import type { SwarmTask } from '../../types';
import { resolveTaskTitle } from '../../../../src/shared/titles.ts';
import { formatDuration, useTimeFormat } from '../../utils/time';
import { Icon } from '../Icon';
import { TableHeadRow, TableRow, TableShell, TH } from '../TableShell';
import { ACTIVE_TASK_STATUSES } from './badges';
import { formatCompactDateTime, statusDotTextClass, summarizeIssueLinks } from './executionRow';
import { statusLabel } from './statusLabels';
import { moveRowIndex, resolveRowKey } from './TaskKeyboardNav';

interface ExecutionTableProps {
  tasks: SwarmTask[];
  loadError: string | null;
  activeTaskId: string | null;
  onActiveTaskId: (taskId: string | null) => void;
  onOpen: (task: SwarmTask) => void;
  onAbort: (taskId: string) => void;
  activeFilterLabel: string;
  onClearFilters: () => void;
  pendingAbortId: string | null;
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  onToggleAll?: () => void;
  allSelected?: boolean;
}

const CELL = 'truncate px-2.5 align-middle';

const CHECKBOX = 'block size-3.5 cursor-pointer accent-pine-iris';

export const ExecutionTable = ({
  tasks,
  loadError,
  activeTaskId,
  onActiveTaskId,
  onOpen,
  onAbort,
  activeFilterLabel,
  onClearFilters,
  pendingAbortId,
  selectable = false,
  selectedIds,
  onToggleSelected,
  onToggleAll,
  allSelected = false,
}: ExecutionTableProps) => {
  const [timeFormat] = useTimeFormat();

  // Rows are keyed by data-task-id so the focus target survives the re-render the move triggers.
  const focusRow = (taskId: string): void => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`)?.focus();
    });
  };

  const handleRowKeyDown = (event: KeyboardEvent, task: SwarmTask, index: number): void => {
    if ((event.target as HTMLElement | null)?.tagName === 'INPUT') return;
    const action = resolveRowKey(event);
    if (!action) return;
    event.preventDefault();
    if (action === 'open') {
      onOpen(task);
      return;
    }
    if (action === 'abort') {
      if (ACTIVE_TASK_STATUSES.has(task.status)) onAbort(task.id);
      return;
    }
    if (action === 'filter') {
      document.getElementById('task-filter-input')?.focus();
      return;
    }
    const next = tasks[moveRowIndex(index, tasks.length, action)];
    if (!next) return;
    onActiveTaskId(next.id);
    focusRow(next.id);
  };

  return (
    <TableShell>
      <table class="w-full table-fixed text-left">
        <caption class="sr-only">Execution history</caption>
        <colgroup>
          {selectable && <col class="w-[36px]" />}
          <col class="w-[64px]" />
          <col />
          <col class="w-[131px]" />
          <col class="w-[128px]" />
          <col class="w-[150px]" />
          <col class="w-[230px]" />
        </colgroup>
        <thead>
          <TableHeadRow>
            {selectable && (
              <TH>
                <input
                  type="checkbox"
                  aria-label="Select all visible tasks"
                  checked={allSelected}
                  onChange={onToggleAll}
                  class={CHECKBOX}
                />
              </TH>
            )}
            <TH>#ID</TH>
            <TH>Task</TH>
            <TH>Status</TH>
            <TH>When</TH>
            <TH>Repo</TH>
            <TH>Model &middot; Duration</TH>
          </TableHeadRow>
        </thead>
        <tbody>
          {tasks.length === 0 ? (
            <tr>
              <td
                colSpan={selectable ? 7 : 6}
                class="px-2.5 py-[32px] text-center text-sm text-pine-subtle"
              >
                {loadError ? (
                  `Could not load executions: ${loadError}`
                ) : (
                  <span class="inline-flex flex-wrap items-center justify-center gap-2.5">
                    <span>
                      No executions match <span class="text-pine-text">{activeFilterLabel}</span>.
                    </span>
                    <button
                      type="button"
                      onClick={onClearFilters}
                      class="cursor-pointer rounded-[4px] border border-pine-highlight bg-pine-overlay px-[8px] py-[3px] text-xs font-semibold text-pine-text hover:bg-pine-highlight"
                    >
                      Clear filters
                    </button>
                  </span>
                )}
              </td>
            </tr>
          ) : (
            tasks.map((task, index) => {
              const isActive = task.id === activeTaskId;
              const tabbable = isActive || (activeTaskId === null && index === 0);
              const issues = summarizeIssueLinks(task.issueUrls);
              const title = resolveTaskTitle(task.title, task.prompt);
              return (
                <TableRow
                  key={task.id}
                  id={`task-row-${task.id}`}
                  data-task-id={task.id}
                  role="row"
                  aria-selected={isActive}
                  tabIndex={tabbable ? 0 : -1}
                  onClick={() => {
                    onActiveTaskId(task.id);
                    onOpen(task);
                  }}
                  onKeyDown={(event) => handleRowKeyDown(event, task, index)}
                  class={`cursor-pointer transition-colors focus-visible:bg-pine-overlay/60 focus-visible:outline-hidden ${
                    isActive ? 'bg-pine-overlay/40' : ''
                  }`}
                >
                  {selectable && (
                    <td class={CELL}>
                      <input
                        type="checkbox"
                        aria-label={`Select task ${task.taskNumber}`}
                        checked={selectedIds?.has(task.id) ?? false}
                        onClick={(event) => event.stopPropagation()}
                        onChange={() => onToggleSelected?.(task.id)}
                        class={CHECKBOX}
                      />
                    </td>
                  )}
                  <td class={`${CELL} font-mono text-xs text-pine-muted`}>
                    #{task.taskNumber ?? 0}
                  </td>
                  <td class={`${CELL} text-sm text-pine-text`} title={title}>
                    {title}
                  </td>
                  <td class={CELL}>
                    <span class="flex items-center gap-1.5">
                      <span class={statusDotTextClass(task.status)}>
                        <span class="inline-block size-1.5 rounded-full bg-current" />
                      </span>
                      <span
                        class="min-w-0 truncate text-xs tracking-wider text-pine-subtle uppercase"
                        title={task.status}
                      >
                        {statusLabel(task.status)}
                      </span>
                    </span>
                  </td>
                  <td class={`${CELL} font-mono text-xs text-pine-subtle tabular-nums`}>
                    {formatCompactDateTime(task.createdAt, timeFormat)}
                  </td>
                  <td class={`${CELL} font-mono text-xs text-pine-subtle`}>
                    {task.repositoryName}
                  </td>
                  <td class={CELL}>
                    {pendingAbortId === task.id ? (
                      <span class="font-mono text-xs whitespace-nowrap text-pine-love">
                        press x again to abort
                      </span>
                    ) : (
                      <span class="flex min-w-0 items-center gap-1.5">
                        <span class="min-w-0 flex-1 truncate font-mono text-xs text-pine-text">
                          {task.model}
                        </span>
                        <span class="shrink-0 font-mono text-xs text-pine-subtle tabular-nums">
                          {formatDuration(task.durationMs)}
                        </span>
                        {task.prUrl && (
                          <a
                            href={task.prUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(event) => event.stopPropagation()}
                            aria-label="Open pull request"
                            class="inline-flex shrink-0 items-center text-pine-iris hover:text-pine-foam"
                          >
                            <Icon icon={faExternalLinkAlt} class="size-4" />
                          </a>
                        )}
                        {issues.links.map((issue) => (
                          <a
                            key={issue.url}
                            href={issue.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(event) => event.stopPropagation()}
                            aria-label={`Open issue ${issue.label}`}
                            title={`Open issue ${issue.label}`}
                            class="inline-flex shrink-0 items-center font-mono text-xs text-pine-iris hover:text-pine-foam"
                          >
                            {issue.label}
                          </a>
                        ))}
                        {issues.overflow > 0 && (
                          <span
                            class="shrink-0 font-mono text-xs text-pine-subtle"
                            title={`${issues.overflow} more issue${issues.overflow === 1 ? '' : 's'}`}
                          >
                            +{issues.overflow}
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                </TableRow>
              );
            })
          )}
        </tbody>
      </table>
    </TableShell>
  );
};
