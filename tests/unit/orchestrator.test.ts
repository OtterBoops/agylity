import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import ky from 'ky';
import { ConfigStore } from '../../src/config/store.js';
import { parseRawEnv } from '../../src/config/schema.js';
import { AppDatabase } from '../../src/storage/db.js';
import { SentryStateManager } from '../../src/sentry/state.js';
import { QuotaEvaluator } from '../../src/sentry/evaluator.js';
import { ConnectRpcQuotaClient, extractCliJsonPayload } from '../../src/sentry/client.js';
import type { QuotaSnapshot } from '../../src/sentry/models.js';
import { createNotifier } from '../../src/notify/factory.js';
import {
  CANONICAL_AGY_MODELS,
  calculateEffectiveHeadroomPercent,
  evaluateModelDispatchEligibility,
  parseDiscordModelPriorityInput,
  resolveConcreteModelId,
  TaskQueue,
  TaskExecutor,
  OrchestratorCoordinator,
  RemoteSwarmWorker,
} from '../../src/orchestrator/index.js';
import { parseWorkerCliArgs } from '../../src/worker-cli.js';
import {
  DiscordNotifier,
  createDispatchModal,
  createRepoSelectMenu,
} from '../../src/notify/adapters/discord.js';
import { startWebServer, closeWebServer } from '../../src/web/server.js';
import { makeTempDir } from '../e2e/harness/index.js';

describe('Unit & Integration Tests: Task Orchestrator, Model Routing & Pull-Worker Swarm', () => {
  /* ==================================================================== */
  /* 1. Explicit Model Selection & Pool-Targeted Quota Math               */
  /* ==================================================================== */
  describe('1. Explicit Model Selection & Pool-Targeted Quota Math', () => {
    it('resolves explicit model IDs and pool family shorthands without magic auto-routing', () => {
      assert.equal(resolveConcreteModelId(undefined, 'gemini-4-argon-high'), 'gemini-4-argon-high');
      assert.equal(resolveConcreteModelId('auto', 'gemini-4-argon-high'), 'gemini-4-argon-high');
      assert.equal(
        resolveConcreteModelId('claude-opus-5-5-high', 'gemini-4-argon-high'),
        'claude-opus-5-5-high'
      );
      assert.equal(
        resolveConcreteModelId('claude', 'gemini-4-argon-high'),
        'claude-sonnet-5-5-high'
      );
      assert.equal(
        resolveConcreteModelId('gemini-flash', 'gemini-4-argon-high'),
        'gemini-3.8-flash-high'
      );
      assert.equal(CANONICAL_AGY_MODELS.length, 13);
    });

    it('calculates effectiveHeadroomPercent as min(weekly, 5h shortTerm)', () => {
      const pool: QuotaSnapshot = {
        poolId: 'claude',
        family: 'claude',
        displayName: 'Claude 5.5 / Opus',
        remainingFraction: 0.75,
        resetTime: new Date(Date.now() + 86400000).toISOString(),
        hoursUntilReset: 24,
        models: ['Claude Sonnet 5.5'],
        weekly: {
          bucketId: '3p-weekly',
          displayName: 'Weekly',
          remainingFraction: 0.75,
          resetTime: new Date(Date.now() + 86400000).toISOString(),
          hoursUntilReset: 24,
        },
        shortTerm: {
          bucketId: '3p-5h',
          displayName: '5-Hour',
          remainingFraction: 0.06, // 6% left in 5h window!
          resetTime: new Date(Date.now() + 3600000).toISOString(),
          hoursUntilReset: 1,
        },
      };

      assert.equal(calculateEffectiveHeadroomPercent(pool), 6);
    });

    it('evaluates safety floor strictly against the selected model pool (blocking low Claude while allowing healthy Argon)', () => {
      const pools: QuotaSnapshot[] = [
        {
          poolId: 'claude',
          family: 'claude',
          displayName: 'Claude 5.5',
          remainingFraction: 0.04, // 4% remaining (below 10% floor)
          resetTime: new Date(Date.now() + 14400000).toISOString(),
          hoursUntilReset: 4,
          models: ['Claude Opus 5.5'],
        },
        {
          poolId: 'gemini-argon',
          family: 'gemini-argon',
          displayName: 'Gemini 4 Argon',
          remainingFraction: 0.85, // 85% remaining (healthy)
          resetTime: new Date(Date.now() + 86400000).toISOString(),
          hoursUntilReset: 24,
          models: ['Gemini 4 Argon'],
        },
      ];

      // 1. Dispatching Claude Opus is blocked because Claude pool is at 4%
      const claudeCheck = evaluateModelDispatchEligibility({
        requestedModel: 'claude-opus-5-5-high',
        pools,
        minDispatchHeadroomPercent: 10,
      });
      assert.equal(claudeCheck.allowed, false);
      assert.equal(claudeCheck.code, 'OVERAGE_PROTECTION_TRIGGERED');
      assert.equal(claudeCheck.family, 'claude');
      assert.equal(claudeCheck.effectiveHeadroomPercent, 4);

      // 2. Dispatching Gemini 4 Argon is allowed because Argon pool is at 85%
      const argonCheck = evaluateModelDispatchEligibility({
        requestedModel: 'gemini-4-argon-high',
        pools,
        minDispatchHeadroomPercent: 10,
      });
      assert.equal(argonCheck.allowed, true);
      assert.equal(argonCheck.family, 'gemini-argon');
      assert.equal(argonCheck.effectiveHeadroomPercent, 85);
    });

    it('enforces P2 Opportunistic Quota-Burn conditions (<2h to reset and >=30% headroom)', () => {
      const farResetPools: QuotaSnapshot[] = [
        {
          poolId: 'gemini-argon',
          family: 'gemini-argon',
          displayName: 'Gemini 4 Argon',
          remainingFraction: 0.65,
          resetTime: new Date(Date.now() + 12 * 3600000).toISOString(),
          hoursUntilReset: 12, // 12h > 2h threshold
          models: ['Gemini 4 Argon'],
        },
      ];

      const notYetCheck = evaluateModelDispatchEligibility({
        requestedModel: 'gemini-4-argon-high',
        priority: 'P2',
        pools: farResetPools,
        quotaBurnMaxHours: 2,
        quotaBurnMinHeadroomPercent: 30,
      });
      assert.equal(notYetCheck.allowed, false);
      assert.equal(notYetCheck.code, 'QUOTA_BURN_CONDITIONS_NOT_MET');

      // When reset is 1.5h away and 65% remains, P2 is released!
      const imminentPools: QuotaSnapshot[] = [
        {
          poolId: 'gemini-argon',
          family: 'gemini-argon',
          displayName: 'Gemini 4 Argon',
          remainingFraction: 0.65,
          resetTime: new Date(Date.now() + 1.5 * 3600000).toISOString(),
          hoursUntilReset: 1.5,
          models: ['Gemini 4 Argon'],
        },
      ];

      const readyCheck = evaluateModelDispatchEligibility({
        requestedModel: 'gemini-4-argon-high',
        priority: 'P2',
        pools: imminentPools,
        quotaBurnMaxHours: 2,
        quotaBurnMinHeadroomPercent: 30,
      });
      assert.equal(readyCheck.allowed, true);
    });
  });

  /* ==================================================================== */
  /* 2. SQLite Task Queue Priority, Routing & Lease Reaping               */
  /* ==================================================================== */
  describe('2. SQLite Task Queue Priority, Routing & Lease Reaping', () => {
    it('dequeues tasks in strict P0 -> P1 -> P2 priority order and respects workerMode', () => {
      const { dir, cleanup } = makeTempDir('orch_queue_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);

        const tP2 = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Low priority burn task',
          priority: 'P2',
          workerMode: 'headless',
          model: 'gemini-4-argon-high',
        });
        const tP1 = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Scheduled benchmark',
          priority: 'P1',
          workerMode: 'headless',
          model: 'gemini-3.8-flash-high',
        });
        const tP0Visible = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Desktop supervised task',
          priority: 'P0',
          workerMode: 'visible',
          model: 'claude-sonnet-5-5-high',
        });
        const tP0Headless = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Urgent headless hotfix',
          priority: 'P0',
          workerMode: 'headless',
          model: 'gemini-4-argon-high',
        });

        // Headless worker claims P0 headless first (skipping P0 visible)
        const claimed1 = queue.claimNext({
          workerId: 'runner-docker-1',
          workerMode: 'headless',
        });
        assert.equal(claimed1?.id, tP0Headless.id);
        assert.equal(claimed1?.status, 'claimed');

        // Next headless claim gets P1
        const claimed2 = queue.claimNext({
          workerId: 'runner-docker-1',
          workerMode: 'headless',
        });
        assert.equal(claimed2?.id, tP1.id);

        // Visible desktop worker claims the P0 visible task
        const claimedVisible = queue.claimNext({
          workerId: 'desktop-pc',
          workerMode: 'visible',
        });
        assert.equal(claimedVisible?.id, tP0Visible.id);

        // Next headless claim gets P2
        const claimed3 = queue.claimNext({
          workerId: 'runner-docker-1',
          workerMode: 'headless',
        });
        assert.equal(claimed3?.id, tP2.id);

        // Completing a task records it into dispatches history
        queue.updateTaskStatus(tP0Headless.id, {
          status: 'completed',
          branchName: 'antigravity/task-hotfix',
          durationMs: 1250,
        });

        const dispatches = db.listDispatches(10);
        assert.equal(dispatches.length, 1);
        assert.equal(dispatches[0]?.branch, 'antigravity/task-hotfix');
        assert.equal(dispatches[0]?.success, true);

        const workers = queue.listWorkers();
        assert.equal(workers.length, 2);
      } finally {
        db.close();
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 3. Git Branch Isolation & Official agy CLI TaskExecutor              */
  /* ==================================================================== */
  describe('3. Git Branch Isolation & Official agy CLI TaskExecutor', () => {
    it('checks out isolated continuation branch and invokes official agy binary with explicit --model and --effort', async () => {
      const { dir, cleanup } = makeTempDir('orch_exec_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);
        const task = queue.enqueue({
          repositoryName: 'agylity',
          repositoryPath: dir,
          prompt: 'Implement swarm poller unit tests',
          model: 'gemini-4-argon-high',
          effort: 'high',
          pushBranch: true,
        });

        const invocations: Array<{ file: string; args: readonly string[]; cwd?: string }> = [];
        const executor = new TaskExecutor({
          agyBinPath: 'agy',
          dirExistsFn: () => true,
          execFileFn: async (file, args, opts) => {
            invocations.push({ file, args, cwd: opts?.cwd as string | undefined });
            if (file === 'git' && args[0] === 'status') {
              return { stdout: ' M src/index.ts\n', stderr: '' };
            }
            return { stdout: 'Task completed cleanly', stderr: '' };
          },
        });

        const result = await executor.execute(task);
        assert.equal(result.success, true);
        assert.ok(result.branchName.startsWith('antigravity/task-'));
        assert.notEqual(result.branchName, 'main');

        // 1a. First switches back to default base branch ('main') and fast-forwards so sequential tasks do not stack branches
        assert.equal(invocations[0]?.file, 'git');
        assert.deepEqual(invocations[0]?.args, ['checkout', 'main']);
        assert.equal(invocations[1]?.file, 'git');
        assert.deepEqual(invocations[1]?.args, ['pull', '--ff-only']);

        // 1b. Then checks out isolated continuation branch
        assert.equal(invocations[2]?.file, 'git');
        assert.deepEqual(invocations[2]?.args, ['checkout', '-B', result.branchName]);

        // 2. Next command must be official agy CLI with explicit --model and --effort
        assert.equal(invocations[3]?.file, 'agy');
        assert.deepEqual(invocations[3]?.args, [
          '-p',
          'Implement swarm poller unit tests',
          '--mode',
          'auto',
          '--dangerously-skip-permissions',
          '--model',
          'gemini-4-argon-high',
          '--effort',
          'high',
        ]);

        // 3. Subsequent commands stage, commit, and push the isolated branch
        assert.ok(
          invocations.some(
            (inv) =>
              inv.file === 'git' && inv.args[0] === 'push' && inv.args.includes(result.branchName)
          )
        );
      } finally {
        db.close();
        cleanup();
      }
    });

    it('refuses to execute if branchName is main or master (Zero-Main-Mutation Guardrail)', async () => {
      const { dir, cleanup } = makeTempDir('orch_guard_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);
        const task = queue.enqueue({
          repositoryName: 'agylity',
          repositoryPath: dir,
          prompt: 'Attempt main mutation',
          model: 'gemini-4-argon-high',
        });
        task.branchName = 'main';

        const executor = new TaskExecutor({
          dirExistsFn: () => true,
        });
        const res = await executor.execute(task);
        assert.equal(res.success, false);
        assert.ok(res.error?.includes('Branch isolation invariant violation'));
      } finally {
        db.close();
        cleanup();
      }
    });

    it('rejects disallowed verifyCommand binaries and shell metacharacters', async () => {
      const { dir, cleanup } = makeTempDir('orch_verify_guard_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);
        const executor = new TaskExecutor({
          dirExistsFn: () => true,
          execFileFn: async () => ({ stdout: 'M file.ts\n', stderr: '' }),
        });

        // Shell metacharacter rejection
        const task1 = queue.enqueue({
          repositoryName: 'agylity',
          repositoryPath: dir,
          prompt: 'Test command injection',
          verifyCommand: 'npm test; rm -rf /',
        });
        const res1 = await executor.execute(task1);
        assert.equal(res1.success, false);
        assert.ok(res1.error?.includes('metacharacters'));

        // Non-allowlisted binary rejection
        const task2 = queue.enqueue({
          repositoryName: 'agylity',
          repositoryPath: dir,
          prompt: 'Test unauthorized binary',
          verifyCommand: 'bash -c whoami',
        });
        const res2 = await executor.execute(task2);
        assert.equal(res2.success, false);
        assert.ok(res2.error?.includes('allowlist'));
      } finally {
        db.close();
        cleanup();
      }
    });

    it('passes GITHUB_TOKEN via extraheader during clone and redacts token on failure', async () => {
      const { dir, cleanup } = makeTempDir('orch_clone_guard_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      const oldToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = 'ghp_secret_dummy_token_99999';

      try {
        const queue = new TaskQueue(db);
        const repoPath = path.join(dir, 'agylity');
        const task = queue.enqueue({
          repositoryName: 'agylity',
          repositoryPath: repoPath,
          cloneUrl: 'https://github.com/OtterBoops/agylity.git',
          prompt: 'Test remote clone',
        });

        const invocations: Array<{ file: string; args: readonly string[] }> = [];
        const executor = new TaskExecutor({
          dirExistsFn: () => false,
          execFileFn: async (file, args) => {
            invocations.push({ file, args });
            if (file === 'git' && args[0] === '-c') {
              throw new Error(
                'fatal: could not read Username for ghp_secret_dummy_token_99999@github.com'
              );
            }
            return { stdout: '', stderr: '' };
          },
        });

        const res = await executor.execute(task);
        assert.equal(res.success, false);
        // Verify extraheader format was used
        assert.equal(invocations[0]?.file, 'git');
        assert.ok(invocations[0]?.args[0] === '-c');
        assert.ok(invocations[0]?.args[1]?.includes('extraheader=AUTHORIZATION: basic'));
        // Verify URL did not embed token
        assert.ok(!invocations[0]?.args.some((a) => a.includes('ghp_secret_dummy_token_99999@')));
        // Verify token was redacted in error output
        assert.ok(!res.error?.includes('ghp_secret_dummy_token_99999'));
        assert.ok(res.error?.includes('[redacted]'));
      } finally {
        process.env.GITHUB_TOKEN = oldToken;
        db.close();
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 4. Outbound Long-Poll Swarm API & GitHub-Runner Registration Flow    */
  /* ==================================================================== */
  describe('4. Outbound Long-Poll Swarm API & GitHub-Runner Registration Flow', () => {
    it('supports fallback shared-secret long-polling, token auth, and status callbacks', async () => {
      const { dir, cleanup } = makeTempDir('orch_web_swarm_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        orchestratorEnabled: true,
        workerSharedSecret: 'swarm-secret-token-999',
        repositories: [
          {
            id: 'agylity',
            name: 'Agylity',
            path: dir,
            defaultBranch: 'main',
          },
        ],
      });

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const baseUrl = `http://127.0.0.1:${port}`;

        // 1. GET /api/models returns annotated model catalog
        const modelsRes = await ky.get(`${baseUrl}/api/models`).json<any>();
        assert.equal(modelsRes.defaultModel, 'gemini-4-argon-high');
        assert.equal(modelsRes.models.length, 13);

        // 2. Unauthenticated poll is rejected with 401
        await assert.rejects(
          async () => {
            await ky.post(`${baseUrl}/api/tasks/poll`, {
              json: { workerId: 'rogue-worker' },
              retry: 0,
            });
          },
          (err: any) => err.response?.status === 401
        );

        // 3. Dispatch a task via POST /api/dispatch (queues for remote runner)
        const dispRes = await ky
          .post(`${baseUrl}/api/dispatch`, {
            json: {
              repositoryName: 'Agylity',
              prompt: 'Refactor Connect-RPC discovery',
              model: 'gemini-3.8-flash-high',
              priority: 'P0',
              workerMode: 'headless',
            },
          })
          .json<any>();

        assert.equal(dispRes.success, true);
        assert.equal(dispRes.status, 'queued');
        assert.equal(dispRes.model, 'gemini-3.8-flash-high');
        assert.ok(dispRes.taskId);

        // 4. RemoteSwarmWorker polls, claims, executes via mock executor, and reports completion
        const executedTasks: string[] = [];
        const mockExecutor = new TaskExecutor({
          dirExistsFn: () => true,
          execFileFn: async (file, _args) => {
            if (file === 'agy') executedTasks.push(file);
            return { stdout: '', stderr: '' };
          },
        });

        const worker = new RemoteSwarmWorker({
          coordinatorUrl: baseUrl,
          workerId: 'runner-worker-1',
          workerMode: 'headless',
          sharedSecret: 'swarm-secret-token-999',
          executor: mockExecutor,
        });

        const claimedTask = await worker.pollOnce();
        assert.ok(claimedTask);
        assert.equal(claimedTask?.id, dispRes.taskId);
        assert.equal(claimedTask?.model, 'gemini-3.8-flash-high');
        assert.equal(executedTasks.length, 1);

        // 5. Verify task is marked completed in GET /api/tasks and GET /api/dispatches
        const tasks = await ky.get(`${baseUrl}/api/tasks`).json<any[]>();
        assert.equal(tasks[0]?.status, 'completed');
        assert.ok(tasks[0]?.branchName?.startsWith('antigravity/task-'));

        const dispatches = await ky.get(`${baseUrl}/api/dispatches`).json<any[]>();
        assert.equal(dispatches.length, 1);
        assert.equal(dispatches[0]?.success, true);

        const workers = await ky.get(`${baseUrl}/api/workers`).json<any[]>();
        assert.equal(workers.length, 1);
        assert.equal(workers[0]?.workerId, 'runner-worker-1');
        assert.equal(workers[0]?.status, 'idle');
        assert.equal(workers[0]?.activeTaskId, undefined);
        assert.equal(workers[0]?.systemInfo?.nodeVersion, undefined);
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('completes full GitHub-Runner registration flow (one-time agyr_reg_ exchange -> persistent agyr_run_ state -> label routing -> pause/resume -> revoke requeue)', async () => {
      const { dir, cleanup } = makeTempDir('orch_gh_runners_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        orchestratorEnabled: true,
        repositories: [
          {
            id: 'agylity',
            name: 'Agylity',
            path: dir,
            defaultBranch: 'main',
          },
        ],
      });

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const runner1StatePath = path.join(dir, 'runner1.json');
        const runner2StatePath = path.join(dir, 'runner2.json');

        // 1. Generate one-time registration tokens for two distinct runners (linux-runner-1 & desktop-gpu)
        const reg1 = await ky
          .post(`${baseUrl}/api/workers/registration-token`, {
            json: {
              nameHint: 'linux-runner-1',
              workerMode: 'headless',
              labels: ['docker', 'linux'],
            },
          })
          .json<any>();
        assert.ok(reg1.registrationToken.startsWith('agyr_reg_'));

        const reg2 = await ky
          .post(`${baseUrl}/api/workers/registration-token`, {
            json: {
              nameHint: 'desktop-gpu',
              workerMode: 'visible',
              labels: ['windows', 'gpu'],
            },
          })
          .json<any>();
        assert.ok(reg2.registrationToken.startsWith('agyr_reg_'));

        const mockExecutor = new TaskExecutor({
          dirExistsFn: () => true,
          execFileFn: async () => ({ stdout: 'done', stderr: '' }),
        });

        // 2. Runner 1 boots with registrationToken -> exchanges for persistent agyr_run_... and saves runner1.json
        const worker1 = new RemoteSwarmWorker({
          coordinatorUrl: baseUrl,
          registrationToken: reg1.registrationToken,
          runnerStatePath: runner1StatePath,
          executor: mockExecutor,
        });
        const regRecord1 = await worker1.registerIfNeeded();
        assert.ok(regRecord1);
        assert.equal(regRecord1?.name, 'linux-runner-1');
        assert.deepEqual(regRecord1?.labels, ['docker', 'linux']);
        assert.ok(worker1.getRunnerToken()?.startsWith('agyr_run_'));

        // 3. Attempting to reuse the consumed one-time registration token is rejected with 401
        await assert.rejects(
          async () => {
            await ky.post(`${baseUrl}/api/workers/register`, {
              json: { registrationToken: reg1.registrationToken },
              retry: 0,
            });
          },
          (err: any) => err.response?.status === 401
        );

        // 4. Restarting Runner 1 from persisted runner1.json works without registrationToken
        const worker1Restarted = new RemoteSwarmWorker({
          coordinatorUrl: baseUrl,
          runnerStatePath: runner1StatePath,
          executor: mockExecutor,
        });
        assert.equal(worker1Restarted.getWorkerId(), worker1.getWorkerId());
        assert.equal(worker1Restarted.getRunnerToken(), worker1.getRunnerToken());

        // 5. Register Runner 2
        const worker2 = new RemoteSwarmWorker({
          coordinatorUrl: baseUrl,
          registrationToken: reg2.registrationToken,
          runnerStatePath: runner2StatePath,
          executor: mockExecutor,
        });
        await worker2.registerIfNeeded();
        assert.ok(worker2.getRunnerToken()?.startsWith('agyr_run_'));

        // 6. Dispatch a task requiring ['gpu'] label in 'visible' mode -> Runner 1 cannot claim it, Runner 2 claims it!
        const gpuDispatch = await ky
          .post(`${baseUrl}/api/dispatch`, {
            json: {
              repositoryName: 'Agylity',
              prompt: 'Run GPU shader compilation benchmark',
              workerMode: 'visible',
              requiredLabels: ['gpu'],
            },
          })
          .json<any>();
        assert.equal(gpuDispatch.success, true);

        const claimAttemptByRunner1 = await worker1Restarted.pollOnce();
        assert.equal(claimAttemptByRunner1, null);

        const claimedByRunner2 = await worker2.pollOnce();
        assert.equal(claimedByRunner2?.id, gpuDispatch.taskId);

        // 7. Pause Runner 1 via PATCH /api/workers/:id -> Runner 1 cannot claim headless docker tasks while paused
        const headlessDispatch = await ky
          .post(`${baseUrl}/api/dispatch`, {
            json: {
              repositoryName: 'Agylity',
              prompt: 'Headless container task',
              workerMode: 'headless',
              requiredLabels: ['docker'],
            },
          })
          .json<any>();

        const pauseRes = await ky
          .patch(`${baseUrl}/api/workers/${encodeURIComponent(worker1.getWorkerId())}`, {
            json: { enabled: false },
          })
          .json<any>();
        assert.equal(pauseRes.worker.enabled, false);

        const claimWhilePaused = await worker1Restarted.pollOnce();
        assert.equal(claimWhilePaused, null);

        // Resume Runner 1 -> now claims and completes the task
        await ky.patch(`${baseUrl}/api/workers/${encodeURIComponent(worker1.getWorkerId())}`, {
          json: { enabled: true },
        });
        const claimAfterResume = await worker1Restarted.pollOnce();
        assert.equal(claimAfterResume?.id, headlessDispatch.taskId);

        // 8. Revoke Runner 1 via DELETE /api/workers/:id -> invalidates token (401 on subsequent poll)
        const delRes = await ky
          .delete(`${baseUrl}/api/workers/${encodeURIComponent(worker1.getWorkerId())}`)
          .json<any>();
        assert.equal(delRes.revoked, true);

        await assert.rejects(
          async () => {
            await worker1Restarted.pollOnce();
          },
          (err: any) => err.response?.status === 401
        );
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('parses worker-cli flags and environment variables accurately', () => {
      const opts = parseWorkerCliArgs(
        [
          '--url',
          'http://coordinator.example.internal:8484',
          '--token',
          'agyr_reg_123456',
          '--name',
          'runner-node-1',
          '--mode',
          'headless',
          '--labels',
          'docker,linux,swarm',
        ],
        {}
      );
      assert.equal(opts.coordinatorUrl, 'http://coordinator.example.internal:8484');
      assert.equal(opts.registrationToken, 'agyr_reg_123456');
      assert.equal(opts.runnerToken, undefined);
      assert.equal(opts.workerName, 'runner-node-1');
      assert.equal(opts.workerMode, 'headless');
      assert.deepEqual(opts.labels, ['docker', 'linux', 'swarm']);
    });
  });

  /* ==================================================================== */
  /* 5. Discord Modal Model/Priority Parsing & Pool Alert Inheritance     */
  /* ==================================================================== */
  describe('5. Discord Modal Model/Priority Parsing & Pool Alert Inheritance', () => {
    it('parses Discord model & priority input strings accurately', () => {
      assert.deepEqual(
        parseDiscordModelPriorityInput('claude-opus-5-5-high P2', 'gemini-4-argon-high'),
        {
          model: 'claude-opus-5-5-high',
          priority: 'P2',
          effort: 'high',
        }
      );

      assert.deepEqual(parseDiscordModelPriorityInput('P1', 'gemini-4-argon-high', 'claude'), {
        model: 'claude-sonnet-5-5-high',
        priority: 'P1',
        effort: 'high',
      });
    });

    it('builds 2-row Discord modal with pre-filled model when includeModelInput is enabled', () => {
      const selectRow = createRepoSelectMenu(
        [{ id: 'agylity', name: 'Agylity', path: '/repos/agylity' }],
        'gemini-argon'
      );
      const menuJson = selectRow.components[0]?.toJSON() as any;
      assert.equal(menuJson.custom_id, 'repo_select:gemini-argon');

      const modal = createDispatchModal('agylity', 'Agylity', {
        includeModelInput: true,
        defaultModel: 'gemini-4-argon-high',
        poolFamily: 'claude',
      });
      const data = modal.toJSON() as any;
      assert.equal(data.custom_id, 'modal_dispatch:agylity:claude');
      assert.equal(data.components.length, 2);
      assert.equal(data.components[1].components[0].custom_id, 'task_model_priority');
      assert.equal(data.components[1].components[0].value, 'claude-sonnet-5-5-high P0');
    });
  });

  /* ==================================================================== */
  /* 6. Strict Single-User Binding (Explicit Owner & TOFU Pinning)        */
  /* ==================================================================== */
  describe('6. Strict Single-User Binding (Explicit Owner & TOFU Pinning)', () => {
    it('parses DISCORD_OWNER_USER_ID from environment and resolves in ConfigStore', () => {
      const parsed = parseRawEnv({ DISCORD_OWNER_USER_ID: '  998877665544332211  ' });
      assert.equal(parsed.discordOwnerUserId, '998877665544332211');

      const { dir, cleanup } = makeTempDir('owner_cfg_');
      const store = new ConfigStore(path.join(dir, 'test.db'), parsed);
      assert.equal(store.resolveConfig().discordOwnerUserId, '998877665544332211');

      store.setOverride('discordOwnerUserId', '112233445566778899');
      assert.equal(store.resolveConfig().discordOwnerUserId, '112233445566778899');
      assert.equal(store.resolveConfig().discordPingOwner, true);

      store.setOverride('discordPingOwner', false);
      assert.equal(store.resolveConfig().discordPingOwner, false);

      store.close();
      cleanup();
    });

    it('pings the owner in Discord alert embeds by default and respects the discordPingOwner toggle', async () => {
      const sentPayloads: any[] = [];
      const mockClient: any = {
        on: () => {},
        channels: {
          fetch: async () => ({
            isTextBased: () => true,
            send: async (payload: any) => {
              sentPayloads.push(payload);
            },
          }),
        },
      };

      const notifier = new DiscordNotifier(
        {
          discordNotificationChannelId: 'chan-1',
          discordOwnerUserId: '334455667788990011',
        },
        { client: mockClient }
      );
      await notifier.initialize();

      const sampleAlert: any = {
        pool: {
          poolId: 'claude',
          family: 'claude',
          displayName: 'Claude 5.5 Sonnet',
          remainingFraction: 0.2,
          resetTime: new Date(Date.now() + 3600_000).toISOString(),
          hoursUntilReset: 1,
          models: ['claude-sonnet-5-5-high'],
        },
        milestoneHours: 3,
        remainingPercentage: 20,
        triggeredAt: new Date().toISOString(),
      };

      // 1. Default (discordPingOwner = true): pings owner in both message content and embed description
      await notifier.notifyQuotaAlert(sampleAlert);
      assert.equal(sentPayloads.length, 1);
      assert.equal(sentPayloads[0].content, '<@334455667788990011>');
      assert.ok(sentPayloads[0].embeds[0].description.startsWith('<@334455667788990011> '));

      // 2. Toggle off (discordPingOwner = false): omits owner mention from content and embed description
      await notifier.updateConfig({ discordPingOwner: false });
      await notifier.notifyQuotaAlert(sampleAlert);
      assert.equal(sentPayloads.length, 2);
      assert.equal(sentPayloads[1].content, undefined);
      assert.ok(!sentPayloads[1].embeds[0].description.includes('<@334455667788990011>'));
    });

    it('strictly blocks non-owner Discord users on /quota, repo_select, and modal_dispatch when discordOwnerUserId is set', async () => {
      let dispatchCount = 0;
      const notifier = new DiscordNotifier(
        {
          discordOwnerUserId: 'owner-user-1',
          repositories: [{ id: 'agylity', name: 'Agylity', path: '/repos/agylity' }],
        },
        {
          onQuotaRequested: async () => [],
          onDispatchRequested: async () => {
            dispatchCount++;
            return { success: true, branchName: 'antigravity/task-1', durationMs: 10 };
          },
        }
      );

      // 1. Intruder attempts /quota
      let quotaReply: any = null;
      await notifier.handleInteraction({
        user: { id: 'intruder-999', username: 'intruder' },
        commandName: 'quota',
        isChatInputCommand: () => true,
        reply: async (payload: any) => {
          quotaReply = payload;
        },
      });
      assert.equal(quotaReply?.ephemeral, true);
      assert.ok(quotaReply?.content.includes('[Blocked] Single-User Binding'));

      // 2. Intruder attempts repo_select
      let selectReply: any = null;
      let modalShown = false;
      await notifier.handleInteraction({
        user: { id: 'intruder-999', username: 'intruder' },
        customId: 'repo_select',
        values: ['agylity'],
        isChatInputCommand: () => false,
        isStringSelectMenu: () => true,
        reply: async (payload: any) => {
          selectReply = payload;
        },
        showModal: async () => {
          modalShown = true;
        },
      });
      assert.equal(modalShown, false);
      assert.equal(selectReply?.ephemeral, true);
      assert.ok(selectReply?.content.includes('[Blocked] Single-User Binding'));

      // 3. Intruder attempts modal_dispatch
      let modalEdit: any = null;
      await notifier.handleInteraction({
        user: { id: 'intruder-999', username: 'intruder' },
        customId: 'modal_dispatch:agylity',
        fields: { getTextInputValue: () => 'Malicious prompt' },
        isChatInputCommand: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        deferReply: async () => {},
        editReply: async (payload: any) => {
          modalEdit = payload;
        },
      });
      assert.equal(dispatchCount, 0);
      assert.ok(modalEdit?.content.includes('[Blocked] Single-User Binding'));

      // 4. Configured owner succeeds
      let ownerEdit: any = null;
      await notifier.handleInteraction({
        user: { id: 'owner-user-1', username: 'otter' },
        customId: 'modal_dispatch:agylity',
        fields: { getTextInputValue: (id: string) => (id === 'task_prompt' ? 'Valid prompt' : '') },
        isChatInputCommand: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        deferReply: async () => {},
        editReply: async (payload: any) => {
          ownerEdit = payload;
        },
      });
      assert.equal(dispatchCount, 1);
      assert.ok(ownerEdit?.content.includes('[Success]'));
    });

    it('enforces TOFU session pinning when discordOwnerUserId is unset and blocks secondary users', async () => {
      const notifier = new DiscordNotifier(
        {
          repositories: [{ id: 'agylity', name: 'Agylity', path: '/repos/agylity' }],
        },
        {
          onQuotaRequested: async () => [],
        }
      );

      // First user interacts and gets pinned as session owner
      let firstReply: any = null;
      await notifier.handleInteraction({
        user: { id: 'first-user-1', username: 'otter' },
        commandName: 'quota',
        isChatInputCommand: () => true,
        reply: async (payload: any) => {
          firstReply = payload;
        },
      });
      assert.ok(firstReply?.embeds);
      assert.equal(notifier.getBoundOwnerUserId(), 'first-user-1');

      // Second distinct user in the same server is blocked
      let secondReply: any = null;
      await notifier.handleInteraction({
        user: { id: 'second-user-2', username: 'other' },
        commandName: 'quota',
        isChatInputCommand: () => true,
        reply: async (payload: any) => {
          secondReply = payload;
        },
      });
      assert.equal(secondReply?.ephemeral, true);
      assert.ok(secondReply?.content.includes('[Blocked] Single-User Binding'));
    });

    it('OrchestratorCoordinator.dispatch rejects mismatched requestedByUserId when discordOwnerUserId is configured', async () => {
      const { dir, cleanup } = makeTempDir('coord_owner_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        orchestratorEnabled: true,
        discordOwnerUserId: 'owner-123',
      });
      const coordinator = new OrchestratorCoordinator({ configStore: store });

      const blocked = await coordinator.dispatch({
        repositoryName: 'Agylity',
        prompt: 'Unauthorized task',
        requestedByUserId: 'intruder-456',
      });
      assert.equal(blocked.success, false);
      assert.ok(blocked.error?.includes('Single-User Binding'));

      store.close();
      cleanup();
    });
  });

  /* ==================================================================== */
  /* 7. CLI JSON Preamble Extraction & Dynamic Config Updates             */
  /* ==================================================================== */
  describe('7. CLI JSON Preamble Extraction & Dynamic Config Updates', () => {
    it('extractCliJsonPayload parses agy --output-format json models output with leading status line', async () => {
      const realAgyStdout = `Fetching available models...\n{\n  "conversation_id": null,\n  "status": "completed",\n  "command": {\n    "name": "models",\n    "data": {\n      "models": [\n        { "id": "gemini-4-argon-high", "label": "Gemini 4 Argon (High)" },\n        { "id": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5" }\n      ]\n    }\n  }\n}\n`;

      const extracted = extractCliJsonPayload(realAgyStdout) as any;
      assert.equal(extracted.status, 'completed');
      assert.equal(extracted.command.data.models.length, 2);

      const client = new ConnectRpcQuotaClient({
        enableProcessDiscovery: false,
        enableCliFallback: true,
        execFileFn: async () => ({ stdout: realAgyStdout, stderr: '' }),
      });

      const snapshots = await client.fallbackToCli();
      assert.equal(snapshots.length, 2);
    });

    it('CompositeNotifier preserves NotifierOptions when dynamically activating channels via updateConfig', async () => {
      let quotaCallbackInvoked = false;
      const composite = await createNotifier('none', {
        onQuotaRequested: async () => {
          quotaCallbackInvoked = true;
          return [];
        },
      });

      await composite.initialize();
      await composite.updateConfig?.({
        notificationChannels: ['discord'],
        notificationChannel: 'discord',
      });

      const discordChild = (composite as any).getNotifier('discord') as DiscordNotifier | undefined;
      assert.ok(discordChild, 'DiscordNotifier should be dynamically instantiated');

      await discordChild.handleInteraction({
        user: { id: 'owner-1', username: 'otter' },
        commandName: 'quota',
        isChatInputCommand: () => true,
        reply: async () => {},
      });
      assert.equal(
        quotaCallbackInvoked,
        true,
        'Dynamically activated DiscordNotifier must retain onQuotaRequested callback'
      );

      await composite.shutdown();
    });

    it('QuotaEvaluator.updateConfig dynamically updates milestoneHours and alertThresholdPercent', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });
      assert.deepEqual(evaluator.milestoneHours, [24, 12, 3]);
      assert.equal(evaluator.alertThresholdPercent, 25);

      evaluator.updateConfig({
        milestoneHours: [6, 48, 1],
        alertThresholdPercent: 40,
      });
      assert.deepEqual(evaluator.milestoneHours, [48, 6, 1]);
      assert.equal(evaluator.alertThresholdPercent, 40);
    });
  });
});
