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
