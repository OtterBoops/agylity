import type { RoutineEligibility, RoutineEligibilityState, RoutineTaskRecord } from '../../types';
import { taskStatusBadgeClass, toneBadgeClass } from '../../utils/status';

/** Notification tone shared by the task modals and the page that owns the toast. */
export type NotifyTone = 'success' | 'error';

/**
 * A run that has not settled yet. `queued`/`claimed` have no output to stream, so the inspector
 * polls them too — the moment a runner starts, the log has to appear without reopening the dialog.
 */
export const ACTIVE_TASK_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'claimed',
  'running',
  'executing',
]);

export const isActiveTaskStatus = (status: string): boolean => ACTIVE_TASK_STATUSES.has(status);

/** A claimed run has a runner attached but nothing written yet; the heartbeat label still matters. */
export const isLiveTaskStatus = (status: string): boolean =>
  status === 'claimed' || status === 'running' || status === 'executing';

/** `running` streams output, so it earns the same pulsing tone `executing` already had. */
export const taskBadgeClass = (status: string): string =>
  status === 'running' ? `animate-pulse ${toneBadgeClass('busy')}` : taskStatusBadgeClass(status);

/**
 * Tone per eligibility state: dispatchable reads positive, blocked-for-now reads caution,
 * and a state that needs a human decision reads negative or muted.
 */
export const eligibilityBadgeClass = (state: RoutineEligibilityState): string =>
  state === 'ready' || state === 'running'
    ? toneBadgeClass('good')
    : state === 'waiting_window' || state === 'low_headroom' || state === 'no_telemetry'
      ? toneBadgeClass('busy')
      : state === 'cycle_failed'
        ? toneBadgeClass('bad')
        : toneBadgeClass('neutral');

/**
 * A payload cached before the eligibility field shipped still has to render: fall back to the one
 * signal such a row carries (its own enabled flag) instead of throwing on `eligibility.detail`.
 */
export const resolveRoutineEligibility = (routine: RoutineTaskRecord): RoutineEligibility =>
  routine.eligibility ??
  (routine.enabled
    ? {
        state: 'ready',
        label: 'Ready',
        detail: 'Eligibility telemetry was not reported for this routine.',
      }
    : { state: 'disabled', label: 'Disabled', detail: 'This routine is switched off.' });
