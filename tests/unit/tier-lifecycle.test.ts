import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import ky from 'ky';
import { ConfigStore } from '../../src/config/store.js';
import { AppDatabase } from '../../src/storage/db.js';
import type { QuotaSnapshot } from '../../src/sentry/models.js';
import {
  Coordinator,
  TaskExecutor,
  evaluateModelDispatchEligibility,
} from '../../src/coordinator/index.js';
import { startWebServer, closeWebServer } from '../../src/web/server.js';
import { makeTempDir } from '../e2e/harness/index.js';

const pool = (
  family: 'gemini-flash' | 'gemini-argon' | 'claude',
  fraction: number
): QuotaSnapshot =>
  ({
    poolId: family,
    family,
    displayName: family,
    remainingFraction: fraction,
    resetTime: new Date(Date.now() + 5 * 3600_000).toISOString(),
    hoursUntilReset: 5,
  }) as QuotaSnapshot;

const makeCoordinator = (dir: string) => {
  const db = new AppDatabase(path.join(dir, 'test.db'));
  const configStore = new ConfigStore(db, {
    coordinatorEnabled: true,
    repositories: [{ id: 'agylity', name: 'agylity', path: dir, defaultBranch: 'main' }],
    poolPolicies: {
      claude: { alertsEnabled: true, dispatchEnabled: true },
      'gemini-argon': { alertsEnabled: true, dispatchEnabled: true },
      'gemini-flash': { alertsEnabled: true, dispatchEnabled: true },
    },
  });
  const coordinator = new Coordinator({ configStore });
  return { db, configStore, coordinator };
};

const dispatchBacklogTask = (coordinator: Coordinator, dir: string) => {
  const backlog = coordinator.queue.createBacklogTask({
    title: 'Backlog item',
    prompt: 'Do the thing',
    repositoryId: 'agylity',
    models: ['gemini-3.8-flash'],
  });
  const task = coordinator.queue.enqueue({
    repositoryId: 'agylity',
    repositoryName: 'agylity',
    repositoryPath: dir,
    prompt: 'Do the thing',
    model: 'gemini-3.8-flash',
    tier: 'backlog',
    originId: backlog.id,
  });
  coordinator.queue.updateBacklogTask(backlog.id, {
    status: 'dispatched',
    attemptCount: 1,
    swarmTaskId: task.id,
  });
  return { backlog, task };
};

describe('Tier lifecycle: backlog origins are never stranded', () => {
  it('settles the backlog origin whose runner lease was reaped', () => {
    const { dir, cleanup } = makeTempDir('tier_reap_');
    const { db, coordinator } = makeCoordinator(dir);
    try {
      const { backlog, task } = dispatchBacklogTask(coordinator, dir);
      coordinator.queue.claimNext({
        runnerId: 'r1',
        runnerName: 'r1',
        labels: [],
        repositories: [],
      });
      const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      db.getRawDb()
        .prepare('UPDATE swarm_tasks SET claimed_at = ?, heartbeat_at = ? WHERE id = ?')
        .run(stale, stale, task.id);

      coordinator.reapStaleClaims();

      assert.equal(coordinator.queue.getTask(task.id)?.status, 'failed');
      // attemptCount 1 < maxAttempts 2, so it must be retryable rather than stuck on 'dispatched'
      assert.equal(coordinator.queue.getBacklogTask(backlog.id)?.status, 'pending');
      assert.equal(coordinator.queue.getNextEligibleBacklogTask()?.id, backlog.id);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('settles the backlog origin when the task is cancelled through the coordinator', async () => {
    const { dir, cleanup } = makeTempDir('tier_cancel_');
    const { db, coordinator } = makeCoordinator(dir);
    try {
      const { backlog, task } = dispatchBacklogTask(coordinator, dir);
      const cancelled = await coordinator.cancelTask(task.id);
      assert.equal(cancelled?.applied, true);
      assert.equal(coordinator.queue.getBacklogTask(backlog.id)?.status, 'pending');

      // A second cancel is refused, and a refusal must be observable to the caller.
      const again = await coordinator.cancelTask(task.id);
      assert.equal(again?.applied, false);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('fails the origin once the retry budget is spent', () => {
    const { dir, cleanup } = makeTempDir('tier_exhaust_');
    const { db, coordinator } = makeCoordinator(dir);
    try {
      const { backlog, task } = dispatchBacklogTask(coordinator, dir);
      coordinator.queue.updateBacklogTask(backlog.id, { attemptCount: 2 });
      coordinator.queue.updateTaskStatus(task.id, { status: 'failed', error: 'agy exploded' });
      coordinator.reconcileBacklogOrigins();
      assert.equal(coordinator.queue.getBacklogTask(backlog.id)?.status, 'failed');
    } finally {
      db.close();
      cleanup();
    }
  });
});

describe('Tier lifecycle: untyped patches and unknown models', () => {
  it('refuses to persist a malformed patch value', () => {
    const { dir, cleanup } = makeTempDir('tier_patch_');
    const { db, coordinator } = makeCoordinator(dir);
    try {
      const created = coordinator.queue.createBacklogTask({
        title: 'B',
        prompt: 'P',
        repositoryId: 'agylity',
        models: ['gemini-3.8-flash'],
      });
      const updated = coordinator.queue.updateBacklogTask(created.id, {
        models: 'gemini-3.8-flash' as any,
        attemptCount: 'nope' as any,
        effort: 'ultra' as any,
      });
      assert.deepEqual(updated?.models, ['gemini-3.8-flash']);
      assert.equal(updated?.attemptCount, 0);
      assert.equal(updated?.effort, 'high');
      assert.equal(updated?.githubIssueNumber, undefined);

      const withIssue = coordinator.queue.updateBacklogTask(created.id, { githubIssueNumber: 42 });
      assert.equal(withIssue?.githubIssueNumber, 42);

      const clearedIssue = coordinator.queue.updateBacklogTask(created.id, {
        githubIssueNumber: null,
      });
      assert.equal(clearedIssue?.githubIssueNumber, undefined);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('locks dispatch for a model that maps to no pool', () => {
    const result = evaluateModelDispatchEligibility({
      requestedModel: 'gemini-9-turbo',
      pools: [pool('gemini-argon', 0.9)],
      minDispatchHeadroomPercent: 10,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'TELEMETRY_UNAVAILABLE');
    assert.equal(result.family, null);
  });

  it('falls through to the next model when the first pool is under the floor', async () => {
    const { dir, cleanup } = makeTempDir('tier_chain_');
    const { db, coordinator } = makeCoordinator(dir);
    try {
      coordinator.onQuotaUpdated([pool('claude', 0.05), pool('gemini-flash', 0.8)]);
      const res = await coordinator.dispatch({
        repositoryId: 'agylity',
        prompt: 'chain test',
        models: ['claude-sonnet-5-5', 'gemini-3.8-flash'],
      });
      assert.equal(res.success, true);
      assert.equal(res.model, 'gemini-3.8-flash');
    } finally {
      db.close();
      cleanup();
    }
  });

  it('persists the manual-dispatch quench across a restart', () => {
    const { dir, cleanup } = makeTempDir('tier_quench_');
    const { db, coordinator } = makeCoordinator(dir);
    try {
      const stamp = Date.now() - 60_000;
      coordinator.setLastManualDispatchAt(stamp);
      const restarted = new Coordinator({ configStore: coordinator['configStore'] as any });
      assert.equal(restarted.getLastManualDispatchAt(), stamp);
    } finally {
      db.close();
      cleanup();
    }
  });
});

describe('Tier lifecycle: HTTP contracts', () => {
  it('answers 400 for a blocked backlog dispatch and 409 for a refused cancel', async () => {
    const { dir, cleanup } = makeTempDir('tier_http_');
    const { db, configStore, coordinator } = makeCoordinator(dir);
    // No telemetry: every dispatch must be refused as OVERAGE-adjacent rather than queued.
    const { server, port } = await startWebServer({
      configStore,
      coordinator,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const created = await ky
        .post(`http://127.0.0.1:${port}/api/backlog`, {
          json: { title: 'B', prompt: 'P', repositoryId: 'agylity' },
          throwHttpErrors: false,
        })
        .json<{ id: string }>();

      const blocked = await ky.post(
        `http://127.0.0.1:${port}/api/backlog/${encodeURIComponent(created.id)}/dispatch`,
        { throwHttpErrors: false }
      );
      assert.equal(blocked.status, 400);
      const body = (await blocked.json()) as { success: boolean; code?: string };
      assert.equal(body.success, false);
      assert.equal(body.code, 'TELEMETRY_UNAVAILABLE');

      const finished = coordinator.queue.enqueue({
        repositoryId: 'agylity',
        repositoryName: 'agylity',
        repositoryPath: dir,
        prompt: 'already done',
        model: 'gemini-3.8-flash',
      });
      coordinator.queue.updateTaskStatus(finished.id, { status: 'completed' });

      const refused = await ky.post(
        `http://127.0.0.1:${port}/api/tasks/${encodeURIComponent(finished.id)}/cancel`,
        { throwHttpErrors: false }
      );
      assert.equal(refused.status, 409);
    } finally {
      await closeWebServer(server);
      db.close();
      cleanup();
    }
  });
});

describe('Runner: a mounted working copy is never destroyed', () => {
  it('stashes uncommitted work instead of cleaning and hard-resetting', async () => {
    const { dir, cleanup } = makeTempDir('runner_stash_');
    const { db, coordinator } = makeCoordinator(dir);
    try {
      const task = coordinator.queue.enqueue({
        repositoryName: 'agylity',
        repositoryPath: dir,
        prompt: 'Stash test',
        model: 'gemini-3.8-flash',
      });

      const calls: string[][] = [];
      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        prPolicy: 'all',
        execFileFn: async (file, args) => {
          calls.push([file, ...args]);
          if (file === 'git' && args[0] === 'status') {
            return { stdout: ' M src/index.ts\n?? scratch.txt\n', stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      });

      const res = await executor.execute(task);
      const gitCalls = calls.filter((c) => c[0] === 'git').map((c) => c.slice(1));
      assert.equal(
        gitCalls.some((args) => args[0] === 'stash' && args.includes('--include-untracked')),
        true
      );
      assert.equal(
        gitCalls.some((args) => args[0] === 'clean' || args[0] === 'reset'),
        false
      );
      assert.equal(res.success, true);
    } finally {
      db.close();
      cleanup();
    }
  });
});
