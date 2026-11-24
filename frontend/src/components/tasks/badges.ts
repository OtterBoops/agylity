import type {
  RoutineEligibilityState,
  RoutineEligibilityStatus,
  RoutineTaskRecord,
} from '../../types';
import { toneBadgeClass } from '../../utils/status';

export const ACTIVE_TASK_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'claimed',
  'executing',
]);

export const isActiveTaskStatus = (status: string): boolean => ACTIVE_TASK_STATUSES.has(status);

export const isLiveTaskStatus = (status: string): boolean =>
  status === 'claimed' || status === 'executing';

/** Card shell shared by the backlog, routine and active-run cards; `highlighted` is the jump flash. */
export const taskCardClass = (highlighted = false): string =>
  `flex cursor-pointer flex-col gap-2.5 rounded-xl border border-pine-highlight bg-pine-surface p-4 transition-colors hover:border-pine-iris/50 ${
    highlighted ? 'ring-2 ring-pine-iris/60 ring-inset' : ''
  }`;

/** Status pill in a card header; the caller supplies the tone class. */
export const STATUS_PILL_CLASS =
  'shrink-0 rounded-sm border px-2 py-0.5 text-xs font-bold tracking-wide whitespace-nowrap uppercase';

export const eligibilityBadgeClass = (state: RoutineEligibilityState): string =>
  state === 'ready' || state === 'running'
    ? toneBadgeClass('good')
    : state === 'waiting_window' || state === 'low_headroom' || state === 'no_telemetry'
      ? toneBadgeClass('busy')
      : state === 'cycle_failed'
        ? toneBadgeClass('bad')
        : toneBadgeClass('neutral');

/** Payloads cached before `eligibility` shipped fall back to the row's own enabled flag. */
export const resolveRoutineEligibility = (routine: RoutineTaskRecord): RoutineEligibilityStatus =>
  routine.eligibility ??
  (routine.enabled
    ? {
        state: 'ready',
        label: 'Ready',
        detail: 'Eligibility telemetry was not reported for this routine.',
      }
    : { state: 'disabled', label: 'Disabled', detail: 'This routine is switched off.' });
