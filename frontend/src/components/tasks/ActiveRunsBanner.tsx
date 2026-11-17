import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import { route } from 'preact-router';
import type { SwarmTask } from '../../types';
import { formatDateTime, useTimeFormat } from '../../utils/time';
import { Icon } from '../Icon';
import { taskBadgeClass } from './badges';

interface ActiveRunCardProps {
  run: SwarmTask;
  busy: boolean;
  noRunnerOnline?: boolean;
  onOpen: (task: SwarmTask) => void;
  onAbort: (taskId: string) => void;
}

export const ActiveRunCard = ({
  run,
  busy,
  noRunnerOnline,
  onOpen,
  onAbort,
}: ActiveRunCardProps) => {
  const [timeFormat] = useTimeFormat();
  const cleanTitle = (run.title ?? '').trim();
  const hasDistinctPrompt = cleanTitle !== '' && cleanTitle !== run.prompt.trim();

  return (
    <article
      id={`task-row-${run.id}`}
      onClick={() => onOpen(run)}
      class="flex cursor-pointer flex-col gap-2.5 rounded-xl border border-pine-highlight bg-pine-surface p-4 transition-colors hover:border-pine-iris/50"
    >
      <div class="flex items-start justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          <span class="shrink-0 rounded-sm bg-pine-overlay px-1.5 py-0.5 font-mono text-xs font-bold whitespace-nowrap text-pine-iris">
            #{run.taskNumber || 0}
          </span>
          <span class="truncate font-mono text-xs text-pine-subtle">{run.repositoryName}</span>
        </div>
        <span
          class={`shrink-0 rounded-sm border px-2 py-0.5 text-xs font-bold tracking-wide whitespace-nowrap uppercase ${taskBadgeClass(run.status)}`}
        >
          {run.status}
        </span>
      </div>

      {run.status === 'queued' && noRunnerOnline && (
        <a
          href="/settings/coordinator"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void route('/settings/coordinator');
          }}
          class="flex items-center gap-1.5 rounded-lg border border-pine-gold/40 bg-pine-gold/10 px-2 py-1 text-xs font-semibold text-pine-gold transition-colors hover:bg-pine-gold/20"
        >
          <Icon icon={faTriangleExclamation} class="size-3 shrink-0" />
          <span class="whitespace-nowrap">No active runner online</span>
        </a>
      )}

      <h3 class="text-sm font-semibold wrap-break-word text-pine-text">
        {run.title || `Task #${run.taskNumber || run.id}`}
      </h3>
      {hasDistinctPrompt && (
        <p class="line-clamp-2 text-xs text-pine-subtle" title={run.prompt}>
          {run.prompt}
        </p>
      )}

      <p class="font-mono text-xs wrap-break-word text-pine-subtle">
        <span class="text-pine-iris">{run.model}</span>
        {run.effort ? ` · ${run.effort}` : ''}
        {run.scheduleMode ? ` · ${run.scheduleMode}` : ''}
      </p>

      <div class="mt-auto flex items-center justify-between gap-2 border-t border-pine-highlight/40 pt-2.5">
        <span class="truncate font-mono text-xs text-pine-muted">
          Started {formatDateTime(run.claimedAt || run.createdAt, { timeFormat })}
        </span>
        <div class="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => onAbort(run.id)}
            disabled={busy}
            class="cursor-pointer rounded-sm border border-pine-love/30 bg-pine-love/10 px-2.5 py-1 text-xs font-semibold whitespace-nowrap text-pine-love transition-colors hover:bg-pine-love hover:text-pine-base disabled:opacity-50"
          >
            Abort
          </button>
        </div>
      </div>
    </article>
  );
};
