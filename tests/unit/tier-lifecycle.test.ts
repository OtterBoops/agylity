import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import ky from 'ky';
import { ConfigStore } from '../../src/config/store.js';
import type { AppConfig } from '../../src/config/schema.js';
import { AppDatabase } from '../../src/storage/db.js';
import type { QuotaSnapshot } from '../../src/sentry/models.js';
import {
  Coordinator,
  TaskExecutor,
  evaluateModelDispatchEligibility,
} from '../../src/coordinator/index.js';
import { startWebServer, closeWebServer } from '../../src/web/server.js';
import { makeTempDir } from '../e2e/harness/index.js';

const poolAt = (
  poolGroup: 'gemini-hydrogen' | 'gemini-argon' | 'claude',
  fraction: number,
  hoursUntilReset: number
): QuotaSnapshot =>
  ({
    poolId: poolGroup,
    poolGroup,
    displayName: poolGroup,
    remainingFraction: fraction,
    resetTime: new Date(Date.now() + hoursUntilReset * 3600_000).toISOString(),
    hoursUntilReset,
  }) as QuotaSnapshot;

const pool = (
  poolGroup: 'gemini-hydrogen' | 'gemini-argon' | 'claude',
  fraction: number
): QuotaSnapshot => poolAt(poolGroup, fraction, 5);

const makeCoordinator = (dir: string, overrides: Partial<AppConfig> = {}) => {
  const db = new AppDatabase(path.join(dir, 'test.db'));
  const configStore = new ConfigStore(db, {
    coordinatorEnabled: true,
    repositories: [{ id: 'agylity', name: 'agylity', path: dir, defaultBranch: 'main' }],
    poolGroupPolicies: {
      claude: { alertsEnabled: true, dispatchEnabled: true },
      'gemini-argon': { alertsEnabled: true, dispatchEnabled: true },
      'gemini-hydrogen': { alertsEnabled: true, dispatchEnabled: true },
    },
    ...overrides,
  });
  const coordinator = new Coordinator({ configStore });
  return { db, configStore, coordinator };
};

const dispatchBacklogTask = (coordinator: Coordinator, dir: string) => {
  const backlog = coordinator.queue.createBacklogTask({
    title: 'Backlog item',
    prompt: 'Do the thing',
    repositoryId: 'agylity',
    cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
  });
  const task = coordinator.queue.enqueue({
    repositoryId: 'agylity',
    repositoryName: 'agylity',
    repositoryPath: dir,
    prompt: 'Do the thing',
    cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
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
        cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
      });
      const updated = coordinator.queue.updateBacklogTask(created.id, {
        cascade: 'gemini-4-hydrogen' as any,
        attemptCount: 'nope' as any,
      } as any);
      // A single id is one hop, and a garbage value falls back to the hop a string still names.
      assert.deepEqual(updated?.cascade, [{ model: 'gemini-4-hydrogen', effort: 'medium' }]);
      assert.equal(updated?.attemptCount, 0);
      assert.equal(updated?.githubIssueNumber, undefined);

      // An unknown effort is clamped to the model's default, never persisted verbatim.
      const clamped = coordinator.queue.updateBacklogTask(created.id, {
        cascade: [{ model: 'gemini-4-hydrogen', effort: 'ultra' as any }],
      });
      assert.deepEqual(clamped?.cascade, [{ model: 'gemini-4-hydrogen', effort: 'medium' }]);

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
    assert.equal(result.poolGroup, null);
  });

  it('burns a routine cycle per pool, so another pool cannot re-arm it', async () => {
    const { dir, cleanup } = makeTempDir('tier_routine_cycles_');
    const { db, coordinator } = makeCoordinator(dir);

    try {
      const routine = coordinator.queue.createRoutineTask({
        title: 'Nightly sweep',
        prompt: 'Sweep the repo',
        repositoryId: 'agylity',
        cascade: [
          { model: 'gemini-4-hydrogen', effort: 'medium' },
          { model: 'claude-sonnet-5-5', effort: 'high' },
        ],
        triggerBeforeResetHours: 12,
        minHeadroomPercent: 10,
      });

      const flash = pool('gemini-hydrogen', 0.8);
      const claude = pool('claude', 0.8);
      const farOut = new Date(Date.now() + 48 * 3600_000).toISOString();
      const inWindow = new Date(Date.now() + 5 * 3600_000).toISOString();

      // 1. Only the flash pool is inside the window.
      flash.resetTime = inWindow;
      claude.resetTime = farOut;
      claude.hoursUntilReset = 48;

      const first = await coordinator.triggerEligibleRoutines([flash, claude]);
      assert.equal(first.length, 1);
      assert.match(first[0]?.model ?? '', /hydrogen/);

      // 2. That run fails, which burns the flash cycle.
      coordinator.queue.updateTaskStatus(first[0]!.id, {
        status: 'failed',
        durationMs: 10,
        error: 'boom',
      });

      // 3. The other pool still gets its turn in its own cycle.
      flash.resetTime = farOut;
      flash.hoursUntilReset = 48;
      claude.resetTime = inWindow;
      claude.hoursUntilReset = 5;
      const second = await coordinator.triggerEligibleRoutines([flash, claude]);
      assert.equal(second.length, 1);
      assert.match(second[0]?.model ?? '', /claude/);

      const stamped = coordinator.queue.getRoutineTask(routine.id);
      assert.equal(stamped?.lastTriggeredCycles['gemini-hydrogen'], inWindow);
      assert.equal(stamped?.lastTriggeredCycles.claude, inWindow);

      // 4. Flash is back inside its window on the same cycle: it must stay burned, even though
      // the routine's most recent run belongs to the claude pool.
      coordinator.queue.updateTaskStatus(second[0]!.id, { status: 'completed', durationMs: 10 });
      flash.resetTime = inWindow;
      flash.hoursUntilReset = 5;
      claude.resetTime = farOut;
      claude.hoursUntilReset = 48;

      const third = await coordinator.triggerEligibleRoutines([flash, claude]);
      assert.equal(third.length, 0);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('spawns a routine inside its own 24h window even when the global 4h/30% pair refuses it', async () => {
    const { dir, cleanup } = makeTempDir('tier_routine_window_');
    const { db, coordinator } = makeCoordinator(dir, {
      quotaBurnMaxHours: 4,
      quotaBurnMinHeadroomPercent: 30,
      minDispatchHeadroomPercent: 10,
    });
    try {
      coordinator.queue.createRoutineTask({
        title: 'Wide-window sweep',
        prompt: 'Sweep the repo',
        repositoryId: 'agylity',
        cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
        triggerBeforeResetHours: 24,
        minHeadroomPercent: 10,
      });

      // 20h to reset at 20%: outside the global 4h window and below its 30% floor, so the old
      // claim-time gate would have parked the task forever. The routine's own 24h/10% pair wins.
      const spawned = await coordinator.triggerEligibleAutonomousTasks([
        poolAt('gemini-hydrogen', 0.2, 20),
      ]);
      assert.equal(spawned.length, 1);
      assert.equal(spawned[0]?.tier, 'routine');
      assert.equal(spawned[0]?.scheduleMode, 'immediate');

      const claimed = await coordinator.pollForTask({ runnerId: 'runner-1', timeoutMs: 0 });
      assert.equal(claimed?.id, spawned[0]?.id);
      assert.equal(claimed?.tier, 'routine');
      assert.equal(claimed?.scheduleMode, 'immediate');
    } finally {
      db.close();
      cleanup();
    }
  });

  it("dispatches a cascade's first hop with that hop's own effort", async () => {
    const { dir, cleanup } = makeTempDir('tier_cascade_first_');
    const { db, coordinator } = makeCoordinator(dir);
    try {
      coordinator.onQuotaUpdated([pool('gemini-hydrogen', 0.8), pool('claude', 0.8)]);
      const res = await coordinator.dispatch({
        repositoryId: 'agylity',
        prompt: 'first hop wins',
        cascade: [
          { model: 'gemini-4-hydrogen', effort: 'low' },
          { model: 'claude-sonnet-5-5', effort: 'xhigh' },
        ],
      });

      assert.equal(res.success, true);
      assert.equal(res.model, 'gemini-4-hydrogen');
      assert.equal(res.poolGroup, 'gemini-hydrogen');

      const queued = coordinator.queue.getTask(res.taskId!);
      assert.equal(queued?.model, 'gemini-4-hydrogen');
      // The hop's effort, not the model's default ('medium') and not a global scalar.
      assert.equal(queued?.effort, 'low');
      // The rest of the chain stays available to the runner as ordered failover.
      assert.deepEqual(
        queued?.cascade.map((hop) => hop.model),
        ['gemini-4-hydrogen', 'claude-sonnet-5-5']
      );
    } finally {
      db.close();
      cleanup();
    }
  });

  it("picks the second hop and carries ITS effort when the first hop's pool is under the floor", async () => {
    const { dir, cleanup } = makeTempDir('tier_cascade_blocked_');
    const { db, coordinator } = makeCoordinator(dir);
    try {
      // claude is below the floor, flash is healthy: hop 0 can never run.
      coordinator.onQuotaUpdated([pool('claude', 0.05), pool('gemini-hydrogen', 0.8)]);
      const res = await coordinator.dispatch({
        repositoryId: 'agylity',
        prompt: 'second hop wins',
        cascade: [
          { model: 'claude-sonnet-5-5', effort: 'low' },
          { model: 'gemini-4-hydrogen', effort: 'xhigh' },
        ],
      });

      assert.equal(res.success, true);
      assert.equal(res.model, 'gemini-4-hydrogen');

      const queued = coordinator.queue.getTask(res.taskId!);
      assert.equal(queued?.model, 'gemini-4-hydrogen');
      // xhigh belongs to the winning hop; the blocked hop's 'low' must not travel with it.
      assert.equal(queued?.effort, 'xhigh');
      assert.ok(
        queued?.cascade.some((hop) => hop.model === 'gemini-4-hydrogen' && hop.effort === 'xhigh'),
        'the chosen hop must keep its own effort inside the stored chain'
      );
      assert.notEqual(queued?.effort, 'low');
      // The winning hop is stored first in the chain handed to the runner.
      assert.deepEqual(queued?.cascade[0], { model: 'gemini-4-hydrogen', effort: 'xhigh' });
    } finally {
      db.close();
      cleanup();
    }
  });

  it('skips a hop whose pool has dispatch disabled instead of borrowing its effort', async () => {
    const { dir, cleanup } = makeTempDir('tier_cascade_disabled_');
    const db = new AppDatabase(path.join(dir, 'test.db'));
    const configStore = new ConfigStore(db, {
      coordinatorEnabled: true,
      repositories: [{ id: 'agylity', name: 'agylity', path: dir, defaultBranch: 'main' }],
      poolGroupPolicies: {
        claude: { alertsEnabled: true, dispatchEnabled: false },
        'gemini-argon': { alertsEnabled: true, dispatchEnabled: true },
        'gemini-hydrogen': { alertsEnabled: true, dispatchEnabled: true },
      },
    });
    const coordinator = new Coordinator({ configStore });
    try {
      // Both pools are healthy, so only the dispatch switch can reject hop 0.
      coordinator.onQuotaUpdated([pool('claude', 0.9), pool('gemini-hydrogen', 0.9)]);
      const res = await coordinator.dispatch({
        repositoryId: 'agylity',
        prompt: 'disabled pool wins nothing',
        cascade: [
          { model: 'claude-sonnet-5-5', effort: 'low' },
          { model: 'gemini-4-hydrogen', effort: 'xhigh' },
        ],
      });

      assert.equal(res.success, true);
      assert.equal(res.model, 'gemini-4-hydrogen');
      const queued = coordinator.queue.getTask(res.taskId!);
      assert.equal(queued?.effort, 'xhigh');
    } finally {
      db.close();
      cleanup();
    }
  });

  it('persists the manual-dispatch quench across a restart', () => {
    const { dir, cleanup } = makeTempDir('tier_quench_');
    const { db, configStore, coordinator } = makeCoordinator(dir);
    try {
      const stamp = Date.now() - 60_000;
      coordinator.setLastManualDispatchAt(stamp);
      // A restarted coordinator reads the quench window back out of the database.
      const restarted = new Coordinator({ configStore });
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
        cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
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

  it('queues a manual pre_reset dispatch outside the window and claims it once the window opens', async () => {
    const { dir, cleanup } = makeTempDir('tier_pre_reset_http_');
    const { db, configStore, coordinator } = makeCoordinator(dir, {
      quotaBurnMaxHours: 4,
      quotaBurnMinHeadroomPercent: 30,
      minDispatchHeadroomPercent: 10,
    });
    const { server, port } = await startWebServer({
      configStore,
      coordinator,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      // 40h to reset at 90%: far outside the burn window, so the POST must park the task.
      coordinator.onQuotaUpdated([poolAt('gemini-hydrogen', 0.9, 40)]);

      const res = await ky.post(`http://127.0.0.1:${port}/api/dispatch`, {
        json: {
          repositoryId: 'agylity',
          prompt: 'Burn the rest of the weekly quota',
          scheduleMode: 'pre_reset',
        },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        success: boolean;
        status?: string;
        code?: string;
        taskId?: string;
      };
      assert.equal(body.success, true);
      assert.equal(body.status, 'queued');
      assert.equal(body.code, 'QUOTA_BURN_QUEUED');

      // Outside the window a runner must get nothing, so the queued burn cannot spend early.
      const early = await coordinator.pollForTask({ runnerId: 'runner-1', timeoutMs: 0 });
      assert.equal(early, null);

      // 2h to reset at 65%: inside the 4h window and above the 30% burn floor.
      coordinator.onQuotaUpdated([poolAt('gemini-hydrogen', 0.65, 2)]);

      const claimed = await coordinator.pollForTask({ runnerId: 'runner-1', timeoutMs: 0 });
      assert.equal(claimed?.id, body.taskId);
      assert.equal(claimed?.scheduleMode, 'pre_reset');
      assert.equal(claimed?.tier, 'immediate');
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
        cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
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
