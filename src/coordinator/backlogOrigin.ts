import type { Logger } from '../logs/logger.js';
import type { BacklogStatus, BacklogTaskRecord, TaskStatus } from '../shared/contracts.js';

/** The queue operations settlement needs; `TaskQueue` satisfies this structurally. */
export interface BacklogOriginStore {
  getBacklogTask(id: string): BacklogTaskRecord | undefined;
  updateBacklogTask(
    id: string,
    patch: Partial<{
      status: BacklogStatus;
      attemptCount: number;
      lastError: string | null;
      swarmTaskId: string | null;
    }>
  ): BacklogTaskRecord | undefined;
  hasActiveTaskForOrigin(originId: string, excludeTaskId?: string): boolean;
  hasDeliveredRunForOrigin(originId: string): boolean;
  taskSpawnSpentAttempt(taskId: string): boolean;
  transferSpawnSpentAttempt(fromTaskId: string, originId: string): boolean;
}

export interface BacklogOutcome {
  originId: string;
  taskId?: string;
  status: TaskStatus;
  /** A run that was never claimed owes no attempt, so a failure must not spend one. */
  claimed: boolean;
  error?: string;
}

const TERMINAL_BACKLOG_STATUSES: ReadonlySet<BacklogStatus> = new Set<BacklogStatus>([
  'completed',
  'failed',
  'canceled',
]);

/**
 * The one settlement of a backlog origin after one of its runs ends, shared by the runner status
 * report, the reconciler and a queued run that expired unclaimed.
 */
export const settleBacklogOrigin = (
  store: BacklogOriginStore,
  outcome: BacklogOutcome,
  log?: Pick<Logger, 'info' | 'warn'>
): void => {
  const origin = store.getBacklogTask(outcome.originId);
  if (!origin || TERMINAL_BACKLOG_STATUSES.has(origin.status)) return;

  // A later run of the same origin is still live: the row closes on the last one. A cancelled run
  // hands its refundable attempt to that survivor instead of losing it.
  if (outcome.taskId && store.hasActiveTaskForOrigin(outcome.originId, outcome.taskId)) {
    if (outcome.status === 'aborted') {
      store.transferSpawnSpentAttempt(outcome.taskId, outcome.originId);
    }
    return;
  }

  const delivered = outcome.status === 'completed' || outcome.status === 'no_changes';
  const error = outcome.error || 'Execution failed';

  if (delivered) {
    store.updateBacklogTask(outcome.originId, {
      status: 'completed',
      lastError: null,
      swarmTaskId: null,
    });
    log?.info('Backlog task #%d (%s) marked completed', origin.taskNumber, origin.title);
    return;
  }

  if (outcome.status !== 'failed' && outcome.status !== 'aborted') return;

  // A pause is the operator's decision; a run failing under it records the reason and stays paused.
  if (origin.status === 'paused') {
    store.updateBacklogTask(outcome.originId, { lastError: error, swarmTaskId: null });
    log?.warn(
      'Backlog task #%d (%s) finished %s while paused; the item stays paused',
      origin.taskNumber,
      origin.title,
      outcome.status
    );
    return;
  }

  // An earlier stacked run already delivered: close the item rather than re-dispatch a duplicate PR.
  if (store.hasDeliveredRunForOrigin(outcome.originId)) {
    store.updateBacklogTask(outcome.originId, {
      status: 'completed',
      lastError: null,
      swarmTaskId: null,
    });
    log?.info(
      'Backlog task #%d (%s) marked completed; an earlier stacked run already delivered',
      origin.taskNumber,
      origin.title
    );
    return;
  }

  const spentAttempt = outcome.status === 'failed' && outcome.claimed;
  const refundable =
    !spentAttempt && outcome.taskId ? store.taskSpawnSpentAttempt(outcome.taskId) : false;
  const attemptCount = refundable ? Math.max(0, origin.attemptCount - 1) : origin.attemptCount;

  if (spentAttempt && origin.attemptCount >= origin.maxAttempts) {
    store.updateBacklogTask(outcome.originId, {
      status: 'failed',
      attemptCount,
      lastError: error,
      swarmTaskId: null,
    });
    log?.warn(
      'Backlog task #%d (%s) marked failed after exhausting %d attempts',
      origin.taskNumber,
      origin.title,
      origin.maxAttempts
    );
    return;
  }

  const settled = store.updateBacklogTask(outcome.originId, {
    status: 'pending',
    attemptCount,
    lastError: error,
    swarmTaskId: null,
  });
  if (settled?.status === 'failed') {
    log?.warn(
      'Backlog task #%d (%s) marked failed after exhausting %d attempts: %s',
      origin.taskNumber,
      origin.title,
      origin.maxAttempts,
      error
    );
    return;
  }
  log?.warn(
    refundable
      ? 'Backlog task #%d (%s) returned to pending with the attempt handed back (%d/%d): %s'
      : 'Backlog task #%d (%s) returned to pending for retry (attempt %d/%d): %s',
    origin.taskNumber,
    origin.title,
    attemptCount,
    origin.maxAttempts,
    error
  );
};
