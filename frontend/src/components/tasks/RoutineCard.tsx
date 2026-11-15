import type { RoutineTaskRecord, SwarmTask } from '../../types';
import { formatDateTime, useTimeFormat } from '../../utils/time';
import { ToggleSwitch } from '../ToggleSwitch';
import { eligibilityBadgeClass, resolveRoutineEligibility } from './badges';
import { modelChainLabel } from './ModelCascadeField';
import { CardActionButtons } from './CardActionButtons';

interface RoutineCardProps {
  routine: RoutineTaskRecord;
  repositoryLabel: string;
  /** The routine's newest run, when this page still holds it. */
  lastTask?: SwarmTask;
  highlighted: boolean;
  busy: boolean;
  confirmingDelete: boolean;
  onOpenTask: (task: SwarmTask) => void;
  onToggle: () => void;
  onTrigger: () => void;
  onEdit: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

/**
 * One routine. Dispatch state is the server's eligibility verdict, so the card shows that badge
 * plus a single metadata line instead of restating every stored setting as its own pill.
 */
export const RoutineCard = ({
  routine,
  repositoryLabel,
  lastTask,
  highlighted,
  busy,
  confirmingDelete,
  onOpenTask,
  onToggle,
  onTrigger,
  onEdit,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
}: RoutineCardProps) => {
  const [timeFormat] = useTimeFormat();
  const eligibility = resolveRoutineEligibility(routine);

  return (
    <article
      id={`task-row-${routine.id}`}
      class={`flex flex-col gap-2.5 rounded-xl border border-pine-highlight bg-pine-surface p-4 shadow-sm transition-colors hover:border-pine-iris/50 ${
        highlighted ? 'ring-2 ring-pine-iris/60 ring-inset' : ''
      }`}
    >
      <div class="flex items-start justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          <span class="shrink-0 rounded-sm bg-pine-overlay px-1.5 py-0.5 font-mono text-xs font-bold whitespace-nowrap text-pine-iris">
            #{routine.taskNumber}
          </span>
          <span class="truncate font-mono text-xs text-pine-subtle">{repositoryLabel}</span>
        </div>
        <span
          title={eligibility.detail}
          class={`shrink-0 rounded-sm border px-2 py-0.5 text-xs font-bold tracking-wide whitespace-nowrap uppercase ${eligibilityBadgeClass(eligibility.state)}`}
        >
          {eligibility.label}
        </span>
      </div>

      <h3 class="text-sm font-semibold wrap-break-word text-pine-text">{routine.title}</h3>
      <p class="line-clamp-2 text-xs text-pine-subtle" title={routine.prompt}>
        {routine.prompt}
      </p>

      <p class="font-mono text-xs wrap-break-word text-pine-subtle">
        <span class="text-pine-iris">{modelChainLabel(routine.models)}</span>
        {' · '}&le;{routine.triggerBeforeResetHours}h{' · '}&ge;{routine.minHeadroomPercent}%
      </p>

      <div class="mt-auto flex items-center justify-between gap-2 border-t border-pine-highlight/40 pt-2.5">
        <div class="flex min-w-0 items-center gap-2">
          <ToggleSwitch
            size="sm"
            checked={routine.enabled}
            label={`Toggle ${routine.title}`}
            onChange={onToggle}
            disabled={busy}
          />
          {lastTask ? (
            <button
              type="button"
              onClick={() => onOpenTask(lastTask)}
              aria-label={`Open run #${lastTask.taskNumber ?? 0} of ${routine.title}`}
              class="min-w-0 cursor-pointer truncate rounded-sm font-mono text-xs text-pine-subtle hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
            >
              Last #{lastTask.taskNumber ?? 0} &middot;{' '}
              {formatDateTime(lastTask.createdAt, { timeFormat })}
            </button>
          ) : routine.lastTriggeredResetTime ? (
            // The reset deadline is a future cycle lock, so it can never label the last run.
            <span
              class="truncate font-mono text-xs text-pine-muted"
              title="Quota cycle already burned for this pool"
            >
              Cycle lock: {formatDateTime(routine.lastTriggeredResetTime, { timeFormat })}
            </span>
          ) : (
            <span class="truncate font-mono text-xs text-pine-muted">Never run</span>
          )}
        </div>
        <CardActionButtons
          entityLabel={routine.title}
          busy={busy}
          confirmingDelete={confirmingDelete}
          onTrigger={onTrigger}
          onEdit={onEdit}
          onAskDelete={onAskDelete}
          onConfirmDelete={onConfirmDelete}
          onCancelDelete={onCancelDelete}
        />
      </div>
    </article>
  );
};
