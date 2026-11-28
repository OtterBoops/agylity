import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  settleBacklogOrigin,
  type BacklogOriginStore,
} from '../../src/coordinator/backlogOrigin.js';
import type { BacklogStatus, BacklogTaskRecord } from '../../src/shared/contracts.js';

const origin = (overrides: Partial<BacklogTaskRecord> = {}): BacklogTaskRecord => ({
  id: 'backlog-1',
  taskNumber: 7,
  title: 'Ship the thing',
  prompt: 'Ship it',
  repositoryId: 'OtterBoops/agylity',
  cascade: [{ model: 'gemini-4-hydrogen', effort: 'high' }],
  autoCreatePr: true,
  priorityOrder: 0,
  status: 'dispatched',
  attemptCount: 1,
  maxAttempts: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

interface Recorder {
  store: BacklogOriginStore;
  patches: Array<Record<string, unknown>>;
  transferred: string[];
}

const makeStore = (
  current: BacklogTaskRecord | undefined,
  options: { active?: boolean; delivered?: boolean; spawnSpent?: boolean } = {}
): Recorder => {
  const patches: Array<Record<string, unknown>> = [];
  const transferred: string[] = [];
  let state = current;
  const store: BacklogOriginStore = {
    getBacklogTask: () => state,
    updateBacklogTask: (_id, patch) => {
      patches.push(patch as Record<string, unknown>);
      if (!state) return undefined;
      state = { ...state, ...(patch as Partial<BacklogTaskRecord>) };
      return state;
    },
    hasActiveTaskForOrigin: () => options.active ?? false,
    hasDeliveredRunForOrigin: () => options.delivered ?? false,
    taskSpawnSpentAttempt: () => options.spawnSpent ?? false,
    transferSpawnSpentAttempt: (fromTaskId) => {
      transferred.push(fromTaskId);
      return true;
    },
  };
  return { store, patches, transferred };
};

const status = (recorder: Recorder): BacklogStatus | undefined =>
  recorder.patches.at(-1)?.status as BacklogStatus | undefined;

describe('Backlog origin settlement', () => {
  it('closes the origin when the run delivered', () => {
    const recorder = makeStore(origin());
    settleBacklogOrigin(recorder.store, {
      originId: 'backlog-1',
      taskId: 'task-1',
      status: 'completed',
      claimed: true,
    });
    assert.equal(status(recorder), 'completed');
    assert.equal(recorder.patches.at(-1)?.swarmTaskId, null);
  });

  it('keeps an operator pause even when a stacked run delivered', () => {
    // Pinning the branch order: the paused row records the reason and is not silently completed.
    const recorder = makeStore(origin({ status: 'paused' }), { delivered: true });
    settleBacklogOrigin(recorder.store, {
      originId: 'backlog-1',
      taskId: 'task-1',
      status: 'failed',
      claimed: true,
      error: 'boom',
    });
    assert.equal(recorder.patches.length, 1);
    assert.equal(recorder.patches[0]?.status, undefined);
    assert.equal(recorder.patches[0]?.lastError, 'boom');
  });

  it('leaves the origin alone while a sibling run is still live and hands the attempt over', () => {
    const recorder = makeStore(origin(), { active: true });
    settleBacklogOrigin(recorder.store, {
      originId: 'backlog-1',
      taskId: 'task-1',
      status: 'aborted',
      claimed: false,
    });
    assert.deepEqual(recorder.patches, []);
    assert.deepEqual(recorder.transferred, ['task-1']);
  });

  it('fails the origin when a claimed run exhausts its attempts', () => {
    const recorder = makeStore(origin({ attemptCount: 2, maxAttempts: 2 }));
    settleBacklogOrigin(recorder.store, {
      originId: 'backlog-1',
      taskId: 'task-1',
      status: 'failed',
      claimed: true,
      error: 'boom',
    });
    assert.equal(status(recorder), 'failed');
  });

  it('returns an unclaimed run to pending and refunds the attempt it spent', () => {
    const recorder = makeStore(origin({ attemptCount: 1, maxAttempts: 2 }), { spawnSpent: true });
    settleBacklogOrigin(recorder.store, {
      originId: 'backlog-1',
      taskId: 'task-1',
      status: 'aborted',
      claimed: false,
      error: 'Expired: no runner claimed the task within its queue window',
    });
    assert.equal(status(recorder), 'pending');
    assert.equal(recorder.patches.at(-1)?.attemptCount, 0);
  });

  it('never rewrites a terminal origin', () => {
    const recorder = makeStore(origin({ status: 'completed' }));
    settleBacklogOrigin(recorder.store, {
      originId: 'backlog-1',
      taskId: 'task-1',
      status: 'failed',
      claimed: true,
    });
    assert.deepEqual(recorder.patches, []);
  });
});
