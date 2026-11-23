import type { SwarmTask } from '../../types';
import { resolveTaskTitle } from '../../../../src/shared/titles.ts';
import { formatDuration, useTimeFormat } from '../../utils/time';
import { ACTIVE_TASK_STATUSES } from './badges';
import { formatCompactDateTime, summarizeIssueLinks } from './executionRow';
import { taskDisplayDotTextClass, taskDisplayStatusLabel } from './statusLabels';

interface MobileTaskCardProps {
  task: SwarmTask;
  busy: boolean;
  abortArmed: boolean;
  onOpen: (task: SwarmTask) => void;
  onAbort: (taskId: string) => void;
  onRetry: (taskId: string) => void;
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
}

export const MobileTaskCard = ({
  task,
  busy,
  abortArmed,
  onOpen,
  onAbort,
  onRetry,
  selectable = false,
  selectedIds,
  onToggleSelected,
}: MobileTaskCardProps) => {
  const [timeFormat] = useTimeFormat();
  const stoppable = ACTIVE_TASK_STATUSES.has(task.status);
  const title = resolveTaskTitle(task.title, task.prompt);
  // Anchors cannot nest inside the card's open-task button, so issues live in the action row.
  const issues = summarizeIssueLinks(task.issueUrls);

  return (
    <article
      id={`task-row-card-${task.id}`}
      class="rounded-xl border border-pine-highlight bg-pine-surface p-3"
    >
      <div class="flex min-w-0 items-start gap-2">
        {selectable && (
          // 44px hit area in px: the box is small, the thumb target is not, and the 17.6px root must not grow it.
          <label
            class="flex min-h-[44px] min-w-[44px] shrink-0 cursor-pointer items-center justify-center"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              type="checkbox"
              aria-label={`Select task ${task.taskNumber}`}
              checked={selectedIds?.has(task.id) ?? false}
              onChange={() => onToggleSelected?.(task.id)}
              class="m-0 size-[16px] cursor-pointer accent-pine-iris"
            />
          </label>
        )}
        <button
          type="button"
          onClick={() => onOpen(task)}
          class="flex w-full min-w-0 cursor-pointer flex-col gap-1.5 text-left"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="font-mono text-xs text-pine-muted">#{task.taskNumber ?? 0}</span>
            <span class="flex min-w-0 items-center gap-1.5">
              <span class={taskDisplayDotTextClass(task)}>
                <span class="inline-block size-[6px] rounded-full bg-current" />
              </span>
              <span class="min-w-0 truncate text-xs tracking-wider text-pine-subtle uppercase">
                {taskDisplayStatusLabel(task)}
              </span>
            </span>
          </div>

          <h3 class="line-clamp-2 text-sm font-medium text-pine-text">{title}</h3>

          <div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-xs text-pine-subtle">
            <span class="max-w-full truncate">{task.repositoryName}</span>
            <span aria-hidden="true">&middot;</span>
            <span class="tabular-nums">{formatCompactDateTime(task.createdAt, timeFormat)}</span>
            <span aria-hidden="true">&middot;</span>
            <span class="truncate">
              {task.model} &middot; {formatDuration(task.durationMs)}
            </span>
          </div>
        </button>
      </div>

      <div class="mt-2.5 flex flex-wrap items-center gap-2">
        {stoppable ? (
          <button
            type="button"
            onClick={() => onAbort(task.id)}
            disabled={busy}
            class="min-h-11 min-w-11 cursor-pointer rounded-lg border border-pine-love/30 bg-pine-love/10 px-3 text-xs font-semibold text-pine-love transition-colors hover:bg-pine-love hover:text-pine-base disabled:opacity-50"
          >
            {abortArmed ? 'Confirm abort' : 'Abort'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onRetry(task.id)}
            disabled={busy}
            class="min-h-11 min-w-11 cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 text-xs font-semibold text-pine-text transition-colors hover:bg-pine-highlight disabled:opacity-50"
          >
            Retry
          </button>
        )}
        {issues.links.length > 0 && (
          <span class="flex min-w-0 flex-wrap items-center gap-1 font-mono text-xs">
            <span class="text-pine-subtle">Issues</span>
            {issues.links.map((issue) => (
              <a
                key={issue.url}
                href={issue.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open issue ${issue.label}`}
                class="inline-flex min-h-11 items-center px-2 text-pine-iris hover:bg-pine-overlay hover:text-pine-foam"
              >
                {issue.label}
              </a>
            ))}
            {issues.overflow > 0 && (
              <span
                class="text-pine-subtle"
                title={`${issues.overflow} more issue${issues.overflow === 1 ? '' : 's'}`}
              >
                +{issues.overflow}
              </span>
            )}
          </span>
        )}
      </div>
    </article>
  );
};
