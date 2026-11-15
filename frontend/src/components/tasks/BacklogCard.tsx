import { faExternalLinkAlt } from '@fortawesome/free-solid-svg-icons';
import type { BacklogStatus, BacklogTaskRecord } from '../../types';
import { toneBadgeClass } from '../../utils/status';
import { Icon } from '../Icon';
import { CardActionButtons } from './CardActionButtons';
import { modelChainLabel } from './ModelCascadeField';

const backlogStatusBadgeClass = (status: BacklogStatus): string =>
  status === 'completed'
    ? toneBadgeClass('good')
    : status === 'failed'
      ? toneBadgeClass('bad')
      : status === 'dispatched'
        ? `animate-pulse ${toneBadgeClass('busy')}`
        : toneBadgeClass('neutral');

interface BacklogCardProps {
  item: BacklogTaskRecord;
  repositoryLabel: string;
  highlighted: boolean;
  busy: boolean;
  confirmingDelete: boolean;
  onDispatch: () => void;
  onEdit: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

/** One queued work item: what it is, where it points, and the actions that fit its status. */
export const BacklogCard = ({
  item,
  repositoryLabel,
  highlighted,
  busy,
  confirmingDelete,
  onDispatch,
  onEdit,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
}: BacklogCardProps) => {
  const dispatchable = item.status === 'pending' || item.status === 'failed';
  const editable = item.status !== 'completed';

  return (
    <article
      id={`task-row-${item.id}`}
      class={`flex flex-col gap-2.5 rounded-xl border border-pine-highlight bg-pine-surface p-4 shadow-sm transition-colors hover:border-pine-iris/50 ${
        highlighted ? 'ring-2 ring-pine-iris/60 ring-inset' : ''
      }`}
    >
      <div class="flex items-start justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          <span class="shrink-0 rounded-sm bg-pine-overlay px-1.5 py-0.5 font-mono text-xs font-bold whitespace-nowrap text-pine-iris">
            #{item.taskNumber}
          </span>
          <span class="truncate font-mono text-xs text-pine-subtle">{repositoryLabel}</span>
        </div>
        <span
          class={`shrink-0 rounded-sm border px-2 py-0.5 text-xs font-bold tracking-wide whitespace-nowrap uppercase ${backlogStatusBadgeClass(item.status)}`}
        >
          {item.status}
        </span>
      </div>

      <h3 class="text-sm font-semibold wrap-break-word text-pine-text">{item.title}</h3>
      <p class="line-clamp-2 text-xs text-pine-subtle" title={item.prompt}>
        {item.prompt}
      </p>
      {item.lastError && (
        <p class="line-clamp-1 font-mono text-xs text-pine-love" title={item.lastError}>
          Last error: {item.lastError}
        </p>
      )}

      <p class="font-mono text-xs wrap-break-word text-pine-subtle">
        <span class="text-pine-iris">{modelChainLabel(item.models)}</span>
        {' · '}
        {item.effort}
        {' · '}P{item.priorityOrder}
        {' · '}
        <span
          title="Autonomous retry budget. A manual dispatch is always allowed."
          class={item.attemptCount >= item.maxAttempts ? 'font-bold text-pine-love' : ''}
        >
          {item.attemptCount}/{item.maxAttempts}
        </span>
      </p>

      <div class="mt-auto flex items-center justify-between gap-2 border-t border-pine-highlight/40 pt-2.5">
        {item.githubIssueUrl ? (
          <a
            href={item.githubIssueUrl}
            target="_blank"
            rel="noreferrer"
            class="inline-flex min-w-0 items-center gap-1 font-mono text-xs text-pine-iris hover:underline"
          >
            <span class="truncate">#{item.githubIssueNumber}</span>
            <Icon icon={faExternalLinkAlt} class="size-2.5 shrink-0" />
          </a>
        ) : (
          <span class="font-mono text-xs text-pine-muted">—</span>
        )}
        <div class="flex shrink-0 items-center gap-1.5">
          {dispatchable && (
            <button
              type="button"
              onClick={onDispatch}
              disabled={busy}
              class="cursor-pointer rounded-sm border border-pine-iris/30 bg-pine-iris/10 px-2.5 py-1 text-xs font-semibold whitespace-nowrap text-pine-iris transition-colors hover:bg-pine-iris hover:text-pine-base disabled:opacity-50"
              title="Dispatch immediately to swarm queue"
            >
              Dispatch
            </button>
          )}
          <CardActionButtons
            entityLabel={item.title}
            busy={busy}
            confirmingDelete={confirmingDelete}
            onEdit={editable ? onEdit : undefined}
            onAskDelete={onAskDelete}
            onConfirmDelete={onConfirmDelete}
            onCancelDelete={onCancelDelete}
          />
        </div>
      </div>
    </article>
  );
};
