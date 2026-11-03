import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  assertWorkerGitCredentials,
  buildContinuationBranchName,
  calculateEffectiveHeadroomPercent,
  evaluateModelDispatchEligibility,
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
      assert.equal(resolveConcreteModelId(undefined, 'gemini-4-argon'), 'gemini-4-argon');
      assert.equal(resolveConcreteModelId('auto', 'gemini-4-argon'), 'gemini-4-argon');
      assert.equal(resolveConcreteModelId('claude-opus-5-5', 'gemini-4-argon'), 'claude-opus-5-5');
      assert.equal(resolveConcreteModelId('claude', 'gemini-4-argon'), 'claude-sonnet-5-5');
      assert.equal(resolveConcreteModelId('gemini-flash', 'gemini-4-argon'), 'gemini-3.8-flash');
      assert.equal(CANONICAL_AGY_MODELS.length, 5);
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
        scheduleMode: 'pre_reset',
        pools: farResetPools,
        quotaBurnMaxHours: 2,
      });
      assert.equal(notYetCheck.allowed, false);
      assert.equal(notYetCheck.code, 'QUOTA_BURN_CONDITIONS_NOT_MET');

      // When reset is 1.5h away and 65% remains, pre_reset is released!
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
        scheduleMode: 'pre_reset',
        pools: imminentPools,
        quotaBurnMaxHours: 2,
      });
      assert.equal(readyCheck.allowed, true);
    });
  });

  /* ==================================================================== */
  /* 2. SQLite Task Queue Routing & Lease Reaping                         */
  /* ==================================================================== */
  describe('2. SQLite Task Queue Routing & Lease Reaping', () => {
    it('enqueues and claims tasks in FIFO order and updates status cleanly', () => {
      const { dir, cleanup } = makeTempDir('orch_queue_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);

        const t1 = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'First task',
          scheduleMode: 'immediate',
          model: 'gemini-3.8-flash-high',
        });
        const t2 = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Second task',
          scheduleMode: 'immediate',
          model: 'gemini-4-argon-high',
        });

        // Worker claims first task
        const claimed1 = queue.claimNext({
          workerId: 'runner-docker-1',
        });
        assert.equal(claimed1?.id, t1.id);
        assert.equal(claimed1?.status, 'claimed');

        // Next claim gets second task
        const claimed2 = queue.claimNext({
          workerId: 'runner-docker-1',
        });
        assert.equal(claimed2?.id, t2.id);

        // Completing a task updates task record
        queue.updateTaskStatus(t1.id, {
          status: 'completed',
          branchName: 'antigravity/task-hotfix',
          durationMs: 1250,
        });

        const finalTask = queue.getTask(t1.id);
        assert.equal(finalTask?.branchName, 'antigravity/task-hotfix');
        assert.equal(finalTask?.status, 'completed');

        const workers = queue.listWorkers();
        assert.equal(workers.length, 1);
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
          model: 'gemini-4-argon',
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
          model: 'gemini-4-argon',
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
          model: 'gemini-4-argon',
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

    it('builds whole-word continuation branch names that never end on a hyphen', () => {
      const branch = buildContinuationBranchName(
        'task-1793630699721-a4eb1c',
        'Tasks table is fucked on mobile. Possibly others too.'
      );
      assert.equal(branch, 'antigravity/task-a4eb1c-tasks-table-is-fucked-on-mobile');
      assert.ok(!branch.endsWith('-'));

      // A word too long for the budget is dropped rather than sliced mid-word.
      assert.equal(
        buildContinuationBranchName('task-1-abc', 'x'.repeat(80)),
        'antigravity/task-abc-work'
      );
    });

    it('reports a run that produced no commits as no_changes, not a failure or a success on main', async () => {
      const { dir, cleanup } = makeTempDir('orch_zerodiff_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);
        const task = queue.enqueue({
          repositoryName: 'agylity',
          repositoryPath: dir,
          prompt: 'Review the current discord bot modals',
          model: 'gemini-4-argon',
          pushBranch: true,
        });

        const executor = new TaskExecutor({
          agyBinPath: 'agy',
          dirExistsFn: () => true,
          execFileFn: async (file, args) => {
            // Clean tree and zero commits ahead of base: the agent answered without editing anything.
            if (file === 'git' && args[0] === 'status') return { stdout: '', stderr: '' };
            if (file === 'git' && args[0] === 'rev-list') return { stdout: '0\n', stderr: '' };
            return {
              stdout: 'Executive Summary: the bot provides continuation dispatches',
              stderr: '',
            };
          },
        });

        const res = await executor.execute(task);
        assert.equal(res.noChanges, true);
        assert.equal(res.success, true);
        assert.notEqual(res.branchName, 'main');
      } finally {
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

      // Provide live quota telemetry so the queued task passes the safety-floor eligibility check
      const sentryState = new SentryStateManager(path.join(dir, 'state.json'));
      sentryState.setState({
        version: 1,
        lastProbeAt: new Date().toISOString(),
        lastProbeSource: 'connect_rpc',
        pools: {
          'gemini-flash': {
            resetTime: new Date(Date.now() + 3600000).toISOString(),
            remainingFraction: 0.8,
            firedMilestones: [],
            lastAlertSentAt: null,
          },
        },
      });

      const { server, port } = await startWebServer({
        configStore: store,
        sentryState,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const baseUrl = `http://127.0.0.1:${port}`;

        // 1. GET /api/models returns annotated model catalog
        const modelsRes = await ky.get(`${baseUrl}/api/models`).json<any>();
        assert.equal(modelsRes.defaultModel, 'gemini-3.8-flash');
        assert.equal(modelsRes.models.length, 5);

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
              workerMode: 'headless',
            },
          })
          .json<any>();

        assert.equal(dispRes.success, true);
        assert.equal(dispRes.status, 'queued');
        assert.equal(dispRes.model, 'gemini-3.8-flash');
        assert.ok(dispRes.taskId);

        // 4. RemoteSwarmWorker polls, claims, executes via mock executor, and reports completion
        const executedTasks: string[] = [];
        const mockExecutor = new TaskExecutor({
          dirExistsFn: () => true,
          execFileFn: async (file, args) => {
            if (file === 'agy') executedTasks.push(file);
            if (file === 'git' && args[0] === 'status') {
              return { stdout: ' M src/index.ts\n', stderr: '' };
            }
            return { stdout: '', stderr: '' };
          },
        });

        const worker = new RemoteSwarmWorker({
          coordinatorUrl: baseUrl,
          workerId: 'runner-worker-1',
          sharedSecret: 'swarm-secret-token-999',
          executor: mockExecutor,
        });

        const claimedTask = await worker.pollOnce();
        assert.ok(claimedTask);
        assert.equal(claimedTask?.id, dispRes.taskId);
        assert.equal(claimedTask?.model, 'gemini-3.8-flash');
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

      // Provide live quota telemetry so dispatched tasks pass the safety-floor eligibility check
      const sentryState = new SentryStateManager(path.join(dir, 'state.json'));
      sentryState.setState({
        version: 1,
        lastProbeAt: new Date().toISOString(),
        lastProbeSource: 'connect_rpc',
        pools: {
          'gemini-flash': {
            resetTime: new Date(Date.now() + 3600000).toISOString(),
            remainingFraction: 0.8,
            firedMilestones: [],
            lastAlertSentAt: null,
          },
        },
      });

      const { server, port } = await startWebServer({
        configStore: store,
        sentryState,
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
              labels: ['docker', 'linux'],
            },
          })
          .json<any>();
        assert.ok(reg1.registrationToken.startsWith('agyr_reg_'));

        const reg2 = await ky
          .post(`${baseUrl}/api/workers/registration-token`, {
            json: {
              nameHint: 'desktop-gpu',
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
      assert.deepEqual(opts.labels, ['docker', 'linux', 'swarm']);
    });
  });

  /* ==================================================================== */
  /* 5. Discord Modal Model/Priority Parsing & Pool Alert Inheritance     */
  /* ==================================================================== */
  describe('5. Discord Modal Shape & Pool Alert Inheritance', () => {
    it('builds a Components V2 modal whose model and effort are selects scoped to the pool', () => {
      const selectRow = createRepoSelectMenu(
        [{ id: 'agylity', name: 'Agylity', path: '/repos/agylity' }],
        'gemini-argon'
      );
      const menuJson = selectRow.components[0]?.toJSON() as any;
      assert.equal(menuJson.custom_id, 'repo_select:gemini-argon');

      const modal = createDispatchModal('agylity', 'Agylity', {
        includeModelInput: true,
        defaultModel: 'gemini-4-argon',
        poolFamily: 'claude',
      });
      const data = modal.toJSON() as any;
      assert.equal(data.custom_id, 'modal_dispatch:agylity:claude');

      // Labels (type 18) only: mixing labels with legacy action rows is an invalid modal.
      assert.deepEqual(
        data.components.map((c: any) => c.type),
        [18, 18, 18]
      );
      assert.equal(data.components[0].component.custom_id, 'task_prompt');

      const modelSelect = data.components[1].component;
      assert.equal(modelSelect.custom_id, 'task_model');
      assert.ok(modelSelect.options.length > 0);
      // A claude pool must not offer gemini models.
      assert.ok(modelSelect.options.every((o: any) => !o.value.startsWith('gemini-')));
      assert.equal(modelSelect.options.find((o: any) => o.default)?.value, 'claude-sonnet-5-5');

      const effortSelect = data.components[2].component;
      assert.equal(effortSelect.custom_id, 'task_effort');
      assert.deepEqual(
        effortSelect.options.map((o: any) => o.value),
        ['low', 'medium', 'high']
      );
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

      // 1. Default (discordPingOwner = true): pings owner in message content
      await notifier.notifyQuotaAlert(sampleAlert);
      assert.equal(sentPayloads.length, 1);
      assert.equal(sentPayloads[0].content, '<@334455667788990011>');
      assert.ok(!sentPayloads[0].embeds[0].description.includes('<@334455667788990011>'));

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
          repositories: [
            { id: 'agylity', name: 'Agylity', path: '/repos/agylity', defaultBranch: 'main' },
          ],
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
          repositories: [
            { id: 'agylity', name: 'Agylity', path: '/repos/agylity', defaultBranch: 'main' },
          ],
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
      // Detected pools are reported as unknown rather than invented at 100% headroom.
      assert.equal(snapshots.length, 0);
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

      // An empty list would disable every milestone alert, so it is ignored.
      evaluator.updateConfig({ milestoneHours: [] });
      assert.deepEqual(evaluator.milestoneHours, [48, 6, 1]);
      assert.equal(evaluator.alertThresholdPercent, 40);
    });

    it('parseAgyTelemetry extracts NDJSON and JSON tokens, turns, and conversationId while gracefully falling back to plain text', async () => {
      const { parseAgyTelemetry } = await import('../../src/orchestrator/worker.js');

      // 1. Plain text returns empty telemetry object
      assert.deepEqual(parseAgyTelemetry('Task completed cleanly'), {});
      assert.deepEqual(parseAgyTelemetry(''), {});
      assert.deepEqual(parseAgyTelemetry(undefined), {});

      // 2. NDJSON stream parses usage and turns
      const ndjson = [
        'Starting task run...',
        '{"type":"init","conversation_id":"conv-abc-123"}',
        'Working on branch...',
        '{"type":"turn","num_turns":4,"usage":{"input_tokens":1200,"output_tokens":350,"thinking_tokens":120,"total_tokens":1670}}',
        'Done!',
      ].join('\n');

      const parsed = parseAgyTelemetry(ndjson);
      assert.equal(parsed.conversationId, 'conv-abc-123');
      assert.equal(parsed.numTurns, 4);
      assert.equal(parsed.inputTokens, 1200);
      assert.equal(parsed.outputTokens, 350);
      assert.equal(parsed.thinkingTokens, 120);
      assert.equal(parsed.totalTokens, 1670);
    });

    it('RemoteSwarmWorker pre-claim auth guard pauses polling without claiming or failing tasks when unauthenticated', async () => {
      let execCalls = 0;
      const worker = new RemoteSwarmWorker({
        coordinatorUrl: 'http://127.0.0.1:8484',
        workerId: 'guard-test-worker',
        execFileFn: async (file, args) => {
          execCalls++;
          if (file === 'agy' && args.includes('models')) {
            throw new Error('Error: Please sign in to view available models.');
          }
          return { stdout: '', stderr: '' };
        },
      });

      // 1. Pre-claim check detects auth failure
      const isAuthed = await worker.checkAuthPreClaim();
      assert.equal(isAuthed, false);
      assert.equal(execCalls, 1);

      // 2. Immediate second call is throttled by cooldown without executing CLI again
      const isAuthedSecond = await worker.checkAuthPreClaim();
      assert.equal(isAuthedSecond, false);
      assert.equal(execCalls, 1, 'Should not re-spawn CLI command during cooldown');

      // 3. pollOnce returns null immediately without attempting network poll
      const task = await worker.pollOnce();
      assert.equal(task, null);
    });
  });

  /* ==================================================================== */
  /* 8. Dispatch Policy Resolution, Telemetry Failsafe & Repo Id Sanitise  */
  /* ==================================================================== */
  describe('8. Dispatch Policy Resolution, Telemetry Failsafe & Repo Id Sanitise', () => {
    it('derives the per-pool policy from the resolved model, not raw substring matching', () => {
      const { dir, cleanup } = makeTempDir('coord_policy_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        defaultDispatchModel: 'claude-sonnet-5-5',
      });
      const coordinator = new OrchestratorCoordinator({ configStore: store });

      // An omitted model must use the default model's pool (claude), whose built-in policy disables dispatch
      const omitted = coordinator.evaluateEligibility({});
      assert.equal(omitted.allowed, false);
      assert.equal(omitted.family, 'claude');
      assert.equal(omitted.code, 'OVERAGE_PROTECTION_TRIGGERED');

      // Aliases without a literal 'claude' must still be governed by the claude policy
      for (const alias of ['sonnet', 'opus', 'gpt-oss', 'gpt-oss-120b']) {
        const check = coordinator.evaluateEligibility({ model: alias });
        assert.equal(check.allowed, false, `alias ${alias} should be blocked`);
        assert.equal(check.family, 'claude', `alias ${alias} should map to the claude pool`);
        assert.equal(check.code, 'OVERAGE_PROTECTION_TRIGGERED');
      }

      store.close();
      cleanup();
    });

    it('applies the default model pool policy (not gemini-argon) when model is omitted', () => {
      const { dir, cleanup } = makeTempDir('coord_policy_default_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        defaultDispatchModel: 'gemini-3.8-flash',
        poolPolicies: {
          claude: { alertsEnabled: true, dispatchEnabled: true },
          'gemini-argon': { alertsEnabled: true, dispatchEnabled: false },
          'gemini-flash': { alertsEnabled: true, dispatchEnabled: true },
        },
      });
      const coordinator = new OrchestratorCoordinator({ configStore: store });
      coordinator.onQuotaUpdated([
        {
          poolId: 'gemini-flash',
          family: 'gemini-flash',
          displayName: 'Gemini Flash',
          remainingFraction: 0.8,
          resetTime: new Date(Date.now() + 3600000).toISOString(),
          hoursUntilReset: 1,
          models: ['gemini-3.8-flash'],
        },
      ]);

      // The disabled gemini-argon policy must not be consulted for the flash default model
      const omitted = coordinator.evaluateEligibility({});
      assert.equal(omitted.allowed, true);
      assert.equal(omitted.family, 'gemini-flash');

      store.close();
      cleanup();
    });

    it('fails closed with TELEMETRY_UNAVAILABLE when no quota pools are available', () => {
      const immediate = evaluateModelDispatchEligibility({
        requestedModel: 'gemini-4-argon',
        pools: [],
        scheduleMode: 'immediate',
      });
      assert.equal(immediate.allowed, false);
      assert.equal(immediate.code, 'TELEMETRY_UNAVAILABLE');
      assert.ok(immediate.reason?.includes('could not be read'));

      // allowOverage still overrides the failsafe
      const overridden = evaluateModelDispatchEligibility({
        requestedModel: 'gemini-4-argon',
        pools: [],
        allowOverage: true,
      });
      assert.equal(overridden.allowed, true);

      // pre_reset keeps its existing queued behaviour when telemetry is missing
      const preReset = evaluateModelDispatchEligibility({
        requestedModel: 'gemini-4-argon',
        pools: [],
        scheduleMode: 'pre_reset',
      });
      assert.equal(preReset.allowed, false);
      assert.equal(preReset.code, 'QUOTA_BURN_CONDITIONS_NOT_MET');
    });

    it('fails closed when the family has no pool, or its fractions are unusable', () => {
      const pool = (over: Record<string, unknown>) => ({
        poolId: 'gemini-argon',
        family: 'gemini-argon',
        displayName: 'Gemini Argon',
        remainingFraction: 0.9,
        resetTime: new Date(Date.now() + 3600000).toISOString(),
        hoursUntilReset: 1,
        models: ['Gemini 4 Argon'],
        ...over,
      });

      // A healthy pool for a DIFFERENT family must not lend its headroom to this dispatch.
      const otherFamily = evaluateModelDispatchEligibility({
        requestedModel: 'claude-sonnet-5-5',
        pools: [pool({})] as any,
      });
      assert.equal(otherFamily.allowed, false);
      assert.equal(otherFamily.code, 'TELEMETRY_UNAVAILABLE');

      // A pool whose fractions are unusable is unknown, not full headroom.
      const noFraction = evaluateModelDispatchEligibility({
        requestedModel: 'gemini-4-argon',
        pools: [pool({ remainingFraction: Number.NaN, weekly: undefined }) as any],
      });
      assert.equal(noFraction.allowed, false);
      assert.equal(noFraction.code, 'TELEMETRY_UNAVAILABLE');
    });

    it('does not let a fraction just below the floor round up over it', () => {
      const justUnder = evaluateModelDispatchEligibility({
        requestedModel: 'gemini-4-argon',
        minDispatchHeadroomPercent: 10,
        pools: [
          {
            poolId: 'gemini-argon',
            family: 'gemini-argon',
            displayName: 'Gemini Argon',
            remainingFraction: 0.095, // 9.5% must not round to 10 and clear a 10% floor
            resetTime: new Date(Date.now() + 3600000).toISOString(),
            hoursUntilReset: 1,
            models: ['Gemini 4 Argon'],
          } as any,
        ],
      });
      assert.equal(justUnder.allowed, false);
      assert.equal(justUnder.code, 'OVERAGE_PROTECTION_TRIGGERED');
    });

    it('ignores telemetry older than twice the probe interval', () => {
      const { dir, cleanup } = makeTempDir('coord_stale_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        quotaCheckIntervalSeconds: 60,
      });
      const sentryState = new SentryStateManager(path.join(dir, 'state.json'));

      try {
        sentryState.setState({
          version: 1,
          lastProbeAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
          lastProbeSource: 'connect_rpc',
          pools: {
            'gemini-flash': {
              resetTime: new Date(Date.now() + 3600000).toISOString(),
              remainingFraction: 0.8,
              firedMilestones: [],
              lastAlertSentAt: null,
            },
          },
        });

        const coordinator = new OrchestratorCoordinator({ configStore: store, sentryState });

        // A stale 80% is most wrong right after a reset, so it must not authorise dispatch.
        assert.equal(coordinator.getActivePools().length, 0);
      } finally {
        store.close();
        cleanup();
      }
    });

    it('sanitises a repository name containing a colon or at-sign into the derived repository id', async () => {
      const { dir, cleanup } = makeTempDir('coord_repo_id_');
      const store = new ConfigStore(path.join(dir, 'test.db'), { orchestratorEnabled: true });
      const coordinator = new OrchestratorCoordinator({ configStore: store });
      coordinator.onQuotaUpdated([
        {
          poolId: 'gemini-flash',
          family: 'gemini-flash',
          displayName: 'Gemini Flash',
          remainingFraction: 0.8,
          resetTime: new Date(Date.now() + 3600000).toISOString(),
          hoursUntilReset: 1,
          models: ['gemini-3.8-flash'],
        },
      ]);

      const res = await coordinator.dispatch({
        repositoryName: 'my:repo@v1',
        prompt: 'Sanitise the derived repository id',
      });
      assert.equal(res.success, true);
      const task = res.taskId ? coordinator.queue.getTask(res.taskId) : null;
      assert.equal(task?.repositoryId, 'my-repo-v1');

      store.close();
      cleanup();
    });
  });

  /* ==================================================================== */
  /* 9. Task Queue Ownership Guards, Lease Reaping & Schema Migration     */
  /* ==================================================================== */
  describe('9. Task Queue Ownership Guards, Lease Reaping & Schema Migration', () => {
    it('will not let a poll payload widen a registered worker scope', () => {
      const { dir, cleanup } = makeTempDir('orch_scope_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);

        // Registered with a docker-only scope.
        queue.registerWorkerHeartbeat({
          workerId: 'runner-scoped',
          name: 'scoped',
          labels: ['docker'],
          repositories: [],
          status: 'idle',
        });

        const task = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Needs linux',
          model: 'gemini-4-argon',
          requiredLabels: ['linux'],
        });

        // Declaring the extra label at poll time must not widen the registration.
        const claimed = queue.claimNext({ workerId: 'runner-scoped', labels: ['linux'] });
        assert.equal(claimed, null);
        assert.equal(queue.getTask(task.id)?.status, 'queued');
        assert.deepEqual(queue.getWorker('runner-scoped')?.labels, ['docker']);
      } finally {
        db.close();
        cleanup();
      }
    });

    it('refuses a revoked worker heartbeat so it cannot re-claim a requeued task', () => {
      const { dir, cleanup } = makeTempDir('orch_owner_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);
        const task = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Ownership guard',
          model: 'gemini-4-argon',
        });

        const claimed = queue.claimNext({ workerId: 'runner-1' });
        assert.equal(claimed?.id, task.id);
        assert.equal(claimed?.status, 'claimed');

        // Revoking the runner mid-flight returns the task to the queue.
        assert.equal(queue.revokeWorker('runner-1'), true);
        assert.equal(queue.getTask(task.id)?.status, 'queued');
        assert.equal(queue.getTask(task.id)?.workerId, undefined);

        // The still-running runner's heartbeat must not flip the task back to executing.
        const result = queue.updateTaskStatus(task.id, {
          status: 'executing',
          workerId: 'runner-1',
        });
        assert.equal(result?.applied, false);
        assert.equal(queue.getTask(task.id)?.status, 'queued');
        assert.equal(queue.getTask(task.id)?.workerId, undefined);
      } finally {
        db.close();
        cleanup();
      }
    });

    it('treats no_changes as a terminal success: recorded, stamped, then closed to further patches', () => {
      const { dir, cleanup } = makeTempDir('orch_nochanges_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);
        const task = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Review the current discord bot modals',
          model: 'claude-sonnet-5-5',
        });
        queue.claimNext({ workerId: 'runner-1' });

        const result = queue.updateTaskStatus(task.id, {
          status: 'no_changes',
          workerId: 'runner-1',
          branchName: 'antigravity/task-abc-review-the-modals',
        });
        assert.equal(result?.applied, true);

        const stored = queue.getTask(task.id);
        assert.equal(stored?.status, 'no_changes');
        assert.ok(stored?.completedAt, 'a terminal status must stamp completedAt');
        assert.notEqual(stored?.branchName, 'main');

        // Terminal means closed: a later patch must be refused.
        const later = queue.updateTaskStatus(task.id, {
          status: 'completed',
          workerId: 'runner-1',
        });
        assert.equal(later?.applied, false);
        assert.equal(queue.getTask(task.id)?.status, 'no_changes');
      } finally {
        db.close();
        cleanup();
      }
    });

    it('rejects cross-worker and queued-to-active status patches from a foreign runner', () => {
      const { dir, cleanup } = makeTempDir('orch_foreign_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);
        const task = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Foreign runner guard',
          model: 'gemini-4-argon',
        });
        const claimed = queue.claimNext({ workerId: 'runner-owner' });
        assert.equal(claimed?.status, 'claimed');

        // A foreign runner cannot transition a task owned by another runner.
        const foreign = queue.updateTaskStatus(task.id, {
          status: 'executing',
          workerId: 'runner-intruder',
        });
        assert.equal(foreign?.applied, false);
        assert.equal(queue.getTask(task.id)?.status, 'claimed');
        assert.equal(queue.getTask(task.id)?.workerId, 'runner-owner');

        // A queued task may never be taken straight to an active state.
        const queued = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Queued takeover guard',
          model: 'gemini-4-argon',
        });
        const takeover = queue.updateTaskStatus(queued.id, {
          status: 'executing',
          workerId: 'runner-intruder',
        });
        assert.equal(takeover?.applied, false);
        assert.equal(queue.getTask(queued.id)?.status, 'queued');
        assert.equal(queue.getTask(queued.id)?.workerId, undefined);

        // The owning runner may still advance its own task.
        const owned = queue.updateTaskStatus(task.id, {
          status: 'executing',
          workerId: 'runner-owner',
        });
        assert.equal(owned?.applied, true);
        assert.equal(owned?.task.status, 'executing');
      } finally {
        db.close();
        cleanup();
      }
    });

    it('records real elapsed work time (claimed_at to now) when reaping a stale claim', () => {
      const { dir, cleanup } = makeTempDir('orch_reap_duration_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);
        const task = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Reap duration',
          model: 'gemini-4-argon',
        });
        queue.claimNext({ workerId: 'runner-dead' });

        const nowMs = Date.now();
        db.getRawDb()
          .prepare('UPDATE swarm_tasks SET claimed_at = ?, heartbeat_at = ? WHERE id = ?')
          .run(
            new Date(nowMs - 45_000).toISOString(),
            new Date(nowMs - 20_000).toISOString(),
            task.id
          );

        const reaped = queue.reapStaleClaims(5_000, nowMs);
        assert.equal(reaped.length, 1);
        // Must reflect claimed_at -> now (45000ms), not the 20000ms lease age.
        assert.equal(reaped[0]!.durationMs, 45_000);
        assert.equal(reaped[0]!.status, 'failed');

        // Falls back to the lease age only when claimed_at is missing.
        const fallback = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Reap fallback',
          model: 'gemini-4-argon',
        });
        queue.claimNext({ workerId: 'runner-dead-2' });
        db.getRawDb()
          .prepare('UPDATE swarm_tasks SET claimed_at = NULL, heartbeat_at = ? WHERE id = ?')
          .run(new Date(nowMs - 20_000).toISOString(), fallback.id);

        const reapedFallback = queue.reapStaleClaims(5_000, nowMs);
        assert.equal(reapedFallback.length, 1);
        assert.equal(reapedFallback[0]!.durationMs, 20_000);
      } finally {
        db.close();
        cleanup();
      }
    });

    it('marks a reaped dead worker offline in the same cycle instead of refreshing its last_seen_at', () => {
      const { dir, cleanup } = makeTempDir('orch_reap_offline_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);
        const task = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Reap offline',
          model: 'gemini-4-argon',
        });
        queue.claimNext({ workerId: 'runner-dead' });
        assert.equal(queue.getWorker('runner-dead')?.status, 'busy');

        const nowMs = Date.now();
        const staleBeat = new Date(nowMs - 20_000).toISOString();
        db.getRawDb()
          .prepare('UPDATE swarm_tasks SET claimed_at = ?, heartbeat_at = ? WHERE id = ?')
          .run(staleBeat, staleBeat, task.id);
        db.getRawDb()
          .prepare('UPDATE swarm_workers SET last_seen_at = ? WHERE worker_id = ?')
          .run(staleBeat, 'runner-dead');

        const reaped = queue.reapStaleClaims(5_000, nowMs);
        assert.equal(reaped.length, 1);
        assert.equal(queue.getWorker('runner-dead')?.status, 'offline');
      } finally {
        db.close();
        cleanup();
      }
    });

    it('prunes consumed registration tokens so repeated creation stays bounded', () => {
      const { dir, cleanup } = makeTempDir('orch_reg_prune_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);
        const total = 60;
        for (let i = 0; i < total; i++) {
          const reg = queue.createRegistrationToken({ nameHint: `runner-${i}` });
          queue.exchangeRegistrationToken({
            registrationToken: reg.registrationToken,
            workerId: `worker-${i}`,
          });
        }

        const count = (
          db.getRawDb().prepare('SELECT COUNT(*) AS c FROM swarm_runner_registrations').get() as {
            c: number;
          }
        ).c;
        assert.ok(count < total, `expected pruning below ${total}, got ${count}`);
        assert.ok(count <= 51, `expected a bounded count, got ${count}`);
      } finally {
        db.close();
        cleanup();
      }
    });

    it('migrates a legacy swarm_tasks schema additively and can enqueue afterwards', () => {
      const { dir, cleanup } = makeTempDir('orch_migrate_');
      const db = new AppDatabase(path.join(dir, 'legacy.db'));

      try {
        const raw = db.getRawDb();
        raw.exec(`
          CREATE TABLE swarm_tasks (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            repository_id TEXT NOT NULL,
            repository_name TEXT NOT NULL,
            repository_path TEXT NOT NULL,
            prompt TEXT NOT NULL,
            model TEXT NOT NULL,
            pool_family TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued',
            duration_ms INTEGER NOT NULL DEFAULT 0
          );
        `);
        // A vestigial column from an older schema must survive the migration.
        raw.exec('ALTER TABLE swarm_tasks ADD COLUMN dispatch_id TEXT');

        const queue = new TaskQueue(db);

        const columns = new Set(
          (raw.prepare('PRAGMA table_info(swarm_tasks)').all() as Array<{ name: string }>).map(
            (column) => column.name
          )
        );
        for (const expected of [
          'schedule_mode',
          'auto_create_pr',
          'pr_url',
          'expires_at',
          'standing_task_id',
          'num_turns',
          'total_tokens',
          'thinking_tokens',
        ]) {
          assert.ok(columns.has(expected), `migrated swarm_tasks should have ${expected}`);
        }
        assert.ok(columns.has('dispatch_id'), 'legacy column must not be dropped');

        const task = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Post-migration enqueue',
          model: 'gemini-4-argon',
        });
        assert.equal(task.status, 'queued');
        assert.equal(task.scheduleMode, 'immediate');
      } finally {
        db.close();
        cleanup();
      }
    });

    it('migrates a legacy settings table additively through the shared schema helper', () => {
      const { dir, cleanup } = makeTempDir('orch_settings_migrate_');
      const dbPath = path.join(dir, 'legacy_settings.db');

      // Seed a settings table that predates updated_at; AppDatabase must upgrade it on open.
      const seed = new DatabaseSync(dbPath);
      seed.exec(`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      seed.close();

      const db = new AppDatabase(dbPath);
      try {
        const columns = new Set(
          (
            db.getRawDb().prepare('PRAGMA table_info(settings)').all() as Array<{ name: string }>
          ).map((column) => column.name)
        );
        assert.ok(columns.has('updated_at'), 'legacy settings should gain updated_at');

        db.set('probe', 'value');
        assert.equal(db.get('probe'), 'value');
      } finally {
        db.close();
        cleanup();
      }
    });
  });
  describe('6. Worker GitHub Credential Preflight', () => {
    it('refuses to start when GITHUB_TOKEN is absent', () => {
      assert.throws(() => assertWorkerGitCredentials([], {}), /GITHUB_TOKEN is not set/);
    });

    it('treats a blank token as absent -- compose sets an empty string when the var is unset', () => {
      assert.throws(() => assertWorkerGitCredentials([], { GITHUB_TOKEN: '   ' }), /not set/);
    });

    it('names the compose environment: trap, which is how a token gets lost', () => {
      assert.throws(
        () => assertWorkerGitCredentials(['OtterBoops/agylity'], {}),
        /environment: in compose\.yaml/
      );
    });

    it('accepts a real token', () => {
      assert.doesNotThrow(() => assertWorkerGitCredentials([], { GITHUB_TOKEN: 'ghp_abc123' }));
    });

    it('allows an explicit opt-out for non-GitHub remotes', () => {
      assert.doesNotThrow(() => assertWorkerGitCredentials([], { ALLOW_TOKENLESS_WORKER: 'true' }));
    });

    it('does not let the opt-out be enabled by a truthy-but-wrong value', () => {
      assert.throws(() => assertWorkerGitCredentials([], { ALLOW_TOKENLESS_WORKER: 'yes' }));
    });

    it('blocks start() before any registration or poll happens', async () => {
      const savedToken = process.env.GITHUB_TOKEN;
      const savedOptOut = process.env.ALLOW_TOKENLESS_WORKER;
      delete process.env.GITHUB_TOKEN;
      delete process.env.ALLOW_TOKENLESS_WORKER;
      try {
        const worker = new RemoteSwarmWorker({
          coordinatorUrl: 'http://127.0.0.1:1',
          workerId: 'runner-no-token',
          sharedSecret: 'swarm-secret-token-999',
        });
        await assert.rejects(() => worker.start(), /GITHUB_TOKEN is not set/);
      } finally {
        if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = savedToken;
        if (savedOptOut === undefined) delete process.env.ALLOW_TOKENLESS_WORKER;
        else process.env.ALLOW_TOKENLESS_WORKER = savedOptOut;
      }
    });
  });
});
