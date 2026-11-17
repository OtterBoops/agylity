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
import type { InfoNotice } from '../../src/notify/types.js';
import {
  CANONICAL_AGY_MODELS,
  assertRunnerGitCredentials,
  buildContinuationBranchName,
  calculateEffectiveHeadroomPercent,
  evaluateModelDispatchEligibility,
  isDocumentationFile,
  resolveConcreteModelId,
  TaskQueue,
  TaskExecutor,
  Coordinator,
  RemoteSwarmRunner,
} from '../../src/coordinator/index.js';
import { parseRunnerCliArgs } from '../../src/runner-cli.js';
import {
  DiscordNotifier,
  createDispatchModal,
  createRepoSelectMenu,
} from '../../src/notify/adapters/discord.js';
import { startWebServer, closeWebServer } from '../../src/web/server.js';
import { makeTempDir } from '../e2e/harness/index.js';

describe('Unit & Integration Tests: Task Coordinator, Model Routing & Pull-Runner Swarm', () => {
  /* ==================================================================== */
  /* 1. Explicit Model Selection & Pool-Targeted Quota Math               */
  /* ==================================================================== */
  describe('1. Explicit Model Selection & Pool-Targeted Quota Math', () => {
    it('resolves explicit model IDs and pool family shorthands without magic auto-routing', () => {
      assert.equal(resolveConcreteModelId(undefined, 'gemini-4-argon'), 'gemini-4-argon');
      assert.equal(resolveConcreteModelId('auto', 'gemini-4-argon'), 'gemini-4-argon');
      assert.equal(resolveConcreteModelId('claude-opus-5-5', 'gemini-4-argon'), 'claude-opus-5-5');
      assert.equal(resolveConcreteModelId('claude', 'gemini-4-argon'), 'claude-sonnet-5-5');
      assert.equal(resolveConcreteModelId('gemini-flash', 'gemini-4-argon'), 'gemini-4-hydrogen');
      // Hydrogen is now the flash pool default; its xhigh suffix still collapses to the base id.
      assert.equal(
        resolveConcreteModelId('gemini-4-hydrogen-xhigh', 'gemini-4-argon'),
        'gemini-4-hydrogen'
      );
      assert.equal(CANONICAL_AGY_MODELS.length, 6);
    });

    it('resolves a shorthand configured default to a concrete model instead of passing it through', () => {
      // The configured default is user input too: `agy --model claude` is not a model id.
      assert.equal(resolveConcreteModelId(undefined, 'gemini-flash'), 'gemini-4-hydrogen');
      assert.equal(resolveConcreteModelId(undefined, 'claude'), 'claude-sonnet-5-5');
      assert.equal(resolveConcreteModelId('3p'), 'claude-sonnet-5-5');
      assert.equal(resolveConcreteModelId('gemini-4-hydrogen-xhigh'), 'gemini-4-hydrogen');
    });

    it('ignores a disabled short-term bucket and floors the effective headroom', () => {
      assert.equal(
        calculateEffectiveHeadroomPercent({
          remainingFraction: 0.8,
          shortTerm: {
            bucketId: '3p-5h',
            displayName: '5-Hour',
            remainingFraction: 0,
            disabled: true,
          },
        }),
        80
      );
      // 0.29 * 100 is 28.999… in floating point and must still read 29.
      assert.equal(calculateEffectiveHeadroomPercent({ remainingFraction: 0.29 }), 29);
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

    it('enforces P2 Opportunistic Quota-Burn conditions (inside the 4h default window, >=30%)', () => {
      const buildPools = (hoursUntilReset: number): QuotaSnapshot[] => [
        {
          poolId: 'gemini-argon',
          family: 'gemini-argon',
          displayName: 'Gemini 4 Argon',
          remainingFraction: 0.65,
          resetTime: new Date(Date.now() + hoursUntilReset * 3600000).toISOString(),
          hoursUntilReset,
          models: ['Gemini 4 Argon'],
        },
      ];

      // 12h out is still outside the built-in 4h window, so the task stays queued.
      const notYetCheck = evaluateModelDispatchEligibility({
        requestedModel: 'gemini-4-argon-high',
        scheduleMode: 'pre_reset',
        pools: buildPools(12),
      });
      assert.equal(notYetCheck.allowed, false);
      assert.equal(notYetCheck.code, 'QUOTA_BURN_CONDITIONS_NOT_MET');

      // At 3h the default 4h window has opened, and 65% clears the 30% burn floor.
      const readyCheck = evaluateModelDispatchEligibility({
        requestedModel: 'gemini-4-argon-high',
        scheduleMode: 'pre_reset',
        pools: buildPools(3),
      });
      assert.equal(readyCheck.allowed, true);

      // An explicit quotaBurnMaxHours still narrows the window.
      const narrowedCheck = evaluateModelDispatchEligibility({
        requestedModel: 'gemini-4-argon-high',
        scheduleMode: 'pre_reset',
        pools: buildPools(3),
        quotaBurnMaxHours: 2,
      });
      assert.equal(narrowedCheck.allowed, false);
      assert.equal(narrowedCheck.code, 'QUOTA_BURN_CONDITIONS_NOT_MET');
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
          cascade: [{ model: 'gemini-4-hydrogen', effort: 'high' }],
        });
        const t2 = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Second task',
          scheduleMode: 'immediate',
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
        });

        // Worker claims first task
        const claimed1 = queue.claimNext({
          runnerId: 'runner-docker-1',
        });
        assert.equal(claimed1?.id, t1.id);
        assert.equal(claimed1?.status, 'claimed');

        // Next claim gets second task
        const claimed2 = queue.claimNext({
          runnerId: 'runner-docker-1',
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

        const workers = queue.listRunners();
        assert.equal(workers.length, 1);
      } finally {
        db.close();
        cleanup();
      }
    });

    it('floors a fractional listTasks limit and falls back to the default on NaN', () => {
      const { dir, cleanup } = makeTempDir('orch_list_limit_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);
        for (const prompt of ['First', 'Second', 'Third']) {
          queue.enqueue({
            repositoryName: 'agylity',
            prompt,
            scheduleMode: 'immediate',
            cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
          });
        }

        // SQLite rejects a REAL LIMIT, so 2.5 must be floored rather than passed through.
        assert.equal(queue.listTasks({ limit: 2.5 }).length, 2);

        // NaN must not reach SQL either: it falls back to the default page size.
        const fallback = queue.listTasks({ limit: Number.NaN });
        assert.equal(fallback.length, 3);
      } finally {
        db.close();
        cleanup();
      }
    });

    it('searches title, repository and origin title only, and treats % as a literal', () => {
      const { dir, cleanup } = makeTempDir('orch_list_search_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);
        const migrated = queue.enqueue({
          repositoryName: 'agylity',
          title: 'Quarterly migration',
          prompt: 'move the schema',
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
        });
        queue.enqueue({
          repositoryName: 'Nebula',
          title: 'Chart cleanup',
          // The only occurrence of "quarterly" for this row is inside the prompt.
          prompt: 'quarterly prompt-only term',
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
        });
        const percentRow = queue.enqueue({
          repositoryName: 'agylity',
          title: 'Latency 99% fixup',
          prompt: 'investigate p99',
          originTitle: 'Issue about zebras',
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
        });

        // Title match. The second row carries the term in its prompt and must not surface.
        const byTitle = queue.listTasks({ q: 'quarterly' });
        assert.deepEqual(
          byTitle.map((t) => t.title),
          ['Quarterly migration']
        );
        assert.equal(queue.countTasks({ q: 'quarterly' }), 1);

        // Repository name, matched case-insensitively.
        assert.deepEqual(
          queue.listTasks({ q: 'NEBULA' }).map((t) => t.title),
          ['Chart cleanup']
        );

        // Origin title is searchable; the prompt is not.
        assert.deepEqual(
          queue.listTasks({ q: 'zebras' }).map((t) => t.id),
          [percentRow.id]
        );
        assert.equal(queue.listTasks({ q: 'zebras' }).length, 1);
        assert.equal(queue.listTasks({ q: 'prompt-only' }).length, 0);

        // An unescaped `%` would match every row; the literal must match only the row containing it.
        const percent = queue.listTasks({ q: '%' });
        assert.deepEqual(
          percent.map((t) => t.title),
          ['Latency 99% fixup']
        );
        assert.equal(queue.countTasks({ q: '%' }), 1);
        // `_` is the other LIKE wildcard and must be escaped the same way.
        assert.equal(queue.listTasks({ q: '_' }).length, 0);

        // taskNumber is an exact row match, not a pattern.
        assert.deepEqual(
          queue.listTasks({ taskNumber: migrated.taskNumber }).map((t) => t.id),
          [migrated.id]
        );
        assert.equal(queue.countTasks({ taskNumber: migrated.taskNumber }), 1);
        // A non-finite number is ignored rather than coerced to a task_number of 0.
        assert.equal(queue.listTasks({ taskNumber: Number.NaN }).length, 3);
      } finally {
        db.close();
        cleanup();
      }
    });

    it('pages with offset while countTasks keeps the full match count', () => {
      const { dir, cleanup } = makeTempDir('orch_list_offset_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);
        for (const title of ['Alpha', 'Bravo', 'Charlie', 'Delta']) {
          queue.enqueue({
            repositoryName: 'agylity',
            title: `Searchable ${title}`,
            prompt: `body ${title}`,
            cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
          });
        }

        const full = queue.listTasks({ q: 'Searchable' });
        assert.equal(full.length, 4);
        assert.equal(queue.countTasks({ q: 'Searchable' }), 4);

        const page = queue.listTasks({ q: 'Searchable', limit: 2, offset: 1 });
        assert.deepEqual(
          page.map((t) => t.id),
          full.slice(1, 3).map((t) => t.id)
        );
        // The total describes the match set, not the page.
        assert.equal(queue.countTasks({ q: 'Searchable' }), 4);

        // A negative offset is clamped to 0 rather than rejected by SQLite.
        assert.deepEqual(
          queue.listTasks({ q: 'Searchable', limit: 2, offset: -5 }).map((t) => t.id),
          full.slice(0, 2).map((t) => t.id)
        );
        // An offset past the end is an empty page, not an error.
        assert.equal(queue.listTasks({ q: 'Searchable', offset: 99 }).length, 0);
      } finally {
        db.close();
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 3. Git Branch Isolation & Official agy CLI TaskExecutor              */
  /* ==================================================================== */
  describe('2b. Pruning keeps the proof a backlog origin settled', () => {
    it('does not prune a terminal task whose backlog origin is still dispatched', () => {
      const { dir, cleanup } = makeTempDir('orch_prune_origin_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);
        const origin = queue.createBacklogTask({
          title: 'Sync docs',
          prompt: 'Do the thing',
          repositoryId: 'agylity',
        });
        queue.updateBacklogTask(origin.id, { status: 'dispatched' });

        const linked = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Linked run',
          scheduleMode: 'immediate',
          cascade: [{ model: 'gemini-4-hydrogen', effort: 'high' }],
          tier: 'backlog',
          originId: origin.id,
        });
        const loose = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Loose run',
          scheduleMode: 'immediate',
          cascade: [{ model: 'gemini-4-hydrogen', effort: 'high' }],
        });

        queue.updateTaskStatus(linked.id, { status: 'completed', durationMs: 10 });
        queue.updateTaskStatus(loose.id, { status: 'completed', durationMs: 10 });

        queue.pruneOldTasks(0);

        // The origin is still 'dispatched', so its terminal row is the reconciler's only evidence.
        assert.ok(queue.getTask(linked.id));
        assert.equal(queue.getTask(loose.id), undefined);
      } finally {
        db.close();
        cleanup();
      }
    });
  });

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
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
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
        assert.ok(result.branchName.startsWith('agy/'));
        assert.notEqual(result.branchName, 'main');

        // 1a. Stashes a dirty tree, then switches back to the default base branch ('main')
        assert.equal(invocations[0]?.file, 'git');
        assert.deepEqual(invocations[0]?.args, ['status', '--porcelain']);
        assert.equal(invocations[1]?.file, 'git');
        assert.deepEqual(invocations[1]?.args, [
          'stash',
          'push',
          '--include-untracked',
          '-m',
          `agylity ${task.id}`,
        ]);
        assert.equal(invocations[2]?.file, 'git');
        assert.deepEqual(invocations[2]?.args, ['checkout', 'main']);
        assert.equal(invocations[3]?.file, 'git');
        assert.deepEqual(invocations[3]?.args, ['pull', '--ff-only']);

        // 1b. Then checks out isolated continuation branch
        assert.equal(invocations[4]?.file, 'git');
        assert.deepEqual(invocations[4]?.args, ['checkout', '-B', result.branchName]);

        // 2. Next command must be official agy CLI with explicit --model and --effort
        assert.equal(invocations[5]?.file, 'agy');
        assert.deepEqual(invocations[5]?.args, [
          '-p',
          'Implement swarm poller unit tests\n\n[Instruction: If you create or edit any GitHub PR or Issue description directly, keep it minimal: simply append a footer: "---\n*Dispatched via Agylity (immediate) with `gemini-4-argon` (high reasoning) — please review carefully.*". Never mention runner hostnames, internal server paths, or worker IDs.]',
          '--mode',
          'auto',
          '--dangerously-skip-permissions',
          '--settings',
          '{"enableTerminalSandbox":false}',
          '--model',
          'gemini-4-argon',
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
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
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
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
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
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
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
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
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
      assert.equal(branch, 'agy/a4eb1c-tasks-table-is-fucked-on-mobile');
      assert.ok(!branch.endsWith('-'));

      // A word too long for the budget is dropped rather than sliced mid-word.
      assert.equal(buildContinuationBranchName('task-1-abc', 'x'.repeat(80)), 'agy/abc-work');
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
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
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
        coordinatorEnabled: true,
        runnerSharedSecret: 'swarm-secret-token-999',
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
      const sentryState = new SentryStateManager({ db: store.getDatabase() });
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
        assert.equal(modelsRes.defaultModel, 'gemini-4-hydrogen');
        assert.equal(modelsRes.models.length, 6);
        const hydrogen = modelsRes.models.find((m: any) => m.id === 'gemini-4-hydrogen');
        assert.ok(hydrogen, 'bundled catalog must offer Gemini 4 Hydrogen offline');
        assert.equal(hydrogen.family, 'gemini-flash');
        assert.ok(hydrogen.supportedEfforts.includes('xhigh'));

        // 2. Unauthenticated poll is rejected with 401
        await assert.rejects(
          async () => {
            await ky.post(`${baseUrl}/api/tasks/poll`, {
              json: { runnerId: 'rogue-worker' },
              retry: 0,
            });
          },
          (err: any) => err.response?.status === 401
        );

        // 3. Dispatch a task via POST /api/dispatch (queues for remote runner)
        const dispRes = await ky
          .post(`${baseUrl}/api/dispatch`, {
            json: {
              repositoryId: 'agylity',
              prompt: 'Refactor Connect-RPC discovery',
              cascade: [{ model: 'gemini-4-hydrogen', effort: 'high' }],
              workerMode: 'headless',
            },
          })
          .json<any>();

        assert.equal(dispRes.success, true);
        assert.equal(dispRes.status, 'queued');
        assert.equal(dispRes.model, 'gemini-4-hydrogen');
        assert.ok(dispRes.taskId);

        // 4. RemoteSwarmRunner polls, claims, executes via mock executor, and reports completion
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

        const worker = new RemoteSwarmRunner({
          coordinatorUrl: baseUrl,
          runnerId: 'runner-worker-1',
          sharedSecret: 'swarm-secret-token-999',
          executor: mockExecutor,
        });

        const claimedTask = await worker.pollOnce();
        assert.ok(claimedTask);
        assert.equal(claimedTask?.id, dispRes.taskId);
        assert.equal(claimedTask?.model, 'gemini-4-hydrogen');
        assert.equal(executedTasks.length, 1);

        // 5. Verify task is marked completed in GET /api/tasks
        const { tasks } = await ky.get(`${baseUrl}/api/tasks`).json<{ tasks: any[] }>();
        assert.equal(tasks[0]?.status, 'completed');
        assert.ok(tasks[0]?.branchName?.startsWith('agy/'));

        const workers = await ky.get(`${baseUrl}/api/runners`).json<any[]>();
        assert.equal(workers.length, 1);
        assert.equal(workers[0]?.runnerId, 'runner-worker-1');
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
        coordinatorEnabled: true,
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
      const sentryState = new SentryStateManager({ db: store.getDatabase() });
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
          .post(`${baseUrl}/api/runners/registration-token`, {
            json: {
              nameHint: 'linux-runner-1',
              labels: ['docker', 'linux'],
            },
          })
          .json<any>();
        assert.ok(reg1.registrationToken.startsWith('agyr_reg_'));

        const reg2 = await ky
          .post(`${baseUrl}/api/runners/registration-token`, {
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
        const worker1 = new RemoteSwarmRunner({
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
            await ky.post(`${baseUrl}/api/runners/register`, {
              json: { registrationToken: reg1.registrationToken },
              retry: 0,
            });
          },
          (err: any) => err.response?.status === 401
        );

        // 4. Restarting Runner 1 from persisted runner1.json works without registrationToken
        const worker1Restarted = new RemoteSwarmRunner({
          coordinatorUrl: baseUrl,
          runnerStatePath: runner1StatePath,
          executor: mockExecutor,
        });
        assert.equal(worker1Restarted.getRunnerId(), worker1.getRunnerId());
        assert.equal(worker1Restarted.getRunnerToken(), worker1.getRunnerToken());

        // 5. Register Runner 2
        const worker2 = new RemoteSwarmRunner({
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
              repositoryId: 'agylity',
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

        // 7. Pause Runner 1 via PATCH /api/runners/:id -> Runner 1 cannot claim headless docker tasks while paused
        const headlessDispatch = await ky
          .post(`${baseUrl}/api/dispatch`, {
            json: {
              repositoryId: 'agylity',
              prompt: 'Headless container task',
              workerMode: 'headless',
              requiredLabels: ['docker'],
            },
          })
          .json<any>();

        const pauseRes = await ky
          .patch(`${baseUrl}/api/runners/${encodeURIComponent(worker1.getRunnerId())}`, {
            json: { enabled: false },
          })
          .json<any>();
        assert.equal(pauseRes.runner.enabled, false);

        const claimWhilePaused = await worker1Restarted.pollOnce();
        assert.equal(claimWhilePaused, null);

        // Resume Runner 1 -> now claims and completes the task
        await ky.patch(`${baseUrl}/api/runners/${encodeURIComponent(worker1.getRunnerId())}`, {
          json: { enabled: true },
        });
        const claimAfterResume = await worker1Restarted.pollOnce();
        assert.equal(claimAfterResume?.id, headlessDispatch.taskId);

        // 8. Revoke Runner 1 via DELETE /api/runners/:id -> invalidates token (401 on subsequent poll)
        const delRes = await ky
          .delete(`${baseUrl}/api/runners/${encodeURIComponent(worker1.getRunnerId())}`)
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
      const opts = parseRunnerCliArgs(
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
      assert.equal(opts.runnerName, 'runner-node-1');
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
        ['low', 'medium', 'high', 'xhigh']
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

    it('Coordinator.dispatch rejects mismatched requestedByUserId when discordOwnerUserId is configured', async () => {
      const { dir, cleanup } = makeTempDir('coord_owner_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        discordOwnerUserId: 'owner-123',
      });
      const coordinator = new Coordinator({ configStore: store });

      const blocked = await coordinator.dispatch({
        repositoryId: 'Agylity',
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
      const { parseAgyTelemetry } = await import('../../src/coordinator/runner.js');

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

    it('RemoteSwarmRunner pre-claim auth guard pauses polling without claiming or failing tasks when unauthenticated', async () => {
      let execCalls = 0;
      const worker = new RemoteSwarmRunner({
        coordinatorUrl: 'http://127.0.0.1:8484',
        runnerId: 'guard-test-worker',
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
      const coordinator = new Coordinator({ configStore: store });

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
        defaultDispatchModel: 'gemini-4-hydrogen',
        poolPolicies: {
          claude: { alertsEnabled: true, dispatchEnabled: true },
          'gemini-argon': { alertsEnabled: true, dispatchEnabled: false },
          'gemini-flash': { alertsEnabled: true, dispatchEnabled: true },
        },
      });
      const coordinator = new Coordinator({ configStore: store });
      coordinator.onQuotaUpdated([
        {
          poolId: 'gemini-flash',
          family: 'gemini-flash',
          displayName: 'Gemini Flash',
          remainingFraction: 0.8,
          resetTime: new Date(Date.now() + 3600000).toISOString(),
          hoursUntilReset: 1,
          models: ['gemini-4-hydrogen'],
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
      const sentryState = new SentryStateManager({ db: store.getDatabase() });

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

        const coordinator = new Coordinator({ configStore: store, sentryState });

        // A stale 80% is most wrong right after a reset, so it must not authorise dispatch.
        assert.equal(coordinator.getActivePools().length, 0);
      } finally {
        store.close();
        cleanup();
      }
    });

    it('sanitises a repository name containing a colon or at-sign into the derived repository id', async () => {
      const { dir, cleanup } = makeTempDir('coord_repo_id_');
      const store = new ConfigStore(path.join(dir, 'test.db'), { coordinatorEnabled: true });
      const coordinator = new Coordinator({ configStore: store });
      coordinator.onQuotaUpdated([
        {
          poolId: 'gemini-flash',
          family: 'gemini-flash',
          displayName: 'Gemini Flash',
          remainingFraction: 0.8,
          resetTime: new Date(Date.now() + 3600000).toISOString(),
          hoursUntilReset: 1,
          models: ['gemini-4-hydrogen'],
        },
      ]);

      const res = await coordinator.dispatch({
        repositoryId: 'my:repo@v1',
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
        queue.registerRunnerHeartbeat({
          runnerId: 'runner-scoped',
          name: 'scoped',
          labels: ['docker'],
          repositories: [],
          status: 'idle',
        });

        const task = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Needs linux',
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
          requiredLabels: ['linux'],
        });

        // Declaring the extra label at poll time must not widen the registration.
        const claimed = queue.claimNext({ runnerId: 'runner-scoped', labels: ['linux'] });
        assert.equal(claimed, null);
        assert.equal(queue.getTask(task.id)?.status, 'queued');
        assert.deepEqual(queue.getRunner('runner-scoped')?.labels, ['docker']);
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
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
        });

        const claimed = queue.claimNext({ runnerId: 'runner-1' });
        assert.equal(claimed?.id, task.id);
        assert.equal(claimed?.status, 'claimed');

        // Revoking the runner mid-flight returns the task to the queue.
        assert.equal(queue.revokeRunner('runner-1'), true);
        assert.equal(queue.getTask(task.id)?.status, 'queued');
        assert.equal(queue.getTask(task.id)?.runnerId, undefined);

        // The still-running runner's heartbeat must not flip the task back to executing.
        const result = queue.updateTaskStatus(task.id, {
          status: 'executing',
          runnerId: 'runner-1',
        });
        assert.equal(result?.applied, false);
        assert.equal(queue.getTask(task.id)?.status, 'queued');
        assert.equal(queue.getTask(task.id)?.runnerId, undefined);
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
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
        });
        queue.claimNext({ runnerId: 'runner-1' });

        const result = queue.updateTaskStatus(task.id, {
          status: 'no_changes',
          runnerId: 'runner-1',
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
          runnerId: 'runner-1',
        });
        assert.equal(later?.applied, false);
        assert.equal(queue.getTask(task.id)?.status, 'no_changes');
      } finally {
        db.close();
        cleanup();
      }
    });

    it('survives an unparsable claimed_at instead of failing the duration_ms NOT NULL constraint', () => {
      const { dir, cleanup } = makeTempDir('orch_bad_claim_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);
        const task = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Corrupt claim stamp',
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
        });
        queue.claimNext({ runnerId: 'runner-1' });

        // An unparsable stamp makes the elapsed derivation NaN; feeding that to duration_ms used to
        // abort the UPDATE with a NOT NULL constraint violation.
        db.getRawDb()
          .prepare("UPDATE swarm_tasks SET claimed_at = 'not-a-timestamp' WHERE id = ?")
          .run(task.id);

        const patched = queue.updateTaskStatus(task.id, { status: 'completed' });
        assert.equal(patched?.applied, true);

        const stored = queue.getTask(task.id);
        assert.ok(stored);
        assert.equal(stored.status, 'completed');
        assert.ok(
          Number.isFinite(stored.durationMs),
          `expected a finite durationMs, got ${stored.durationMs}`
        );
        assert.ok(stored.durationMs >= 0);

        // Positive control: the fallback must not disarm the normal claimed_at -> now derivation.
        const timed = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Valid claim stamp',
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
        });
        queue.claimNext({ runnerId: 'runner-2' });
        db.getRawDb()
          .prepare('UPDATE swarm_tasks SET claimed_at = ? WHERE id = ?')
          .run(new Date(Date.now() - 30_000).toISOString(), timed.id);

        const completed = queue.updateTaskStatus(timed.id, { status: 'completed' });
        assert.equal(completed?.applied, true);

        const timedStored = queue.getTask(timed.id);
        assert.ok(timedStored);
        assert.equal(timedStored.status, 'completed');
        assert.ok(
          Number.isFinite(timedStored.durationMs) && timedStored.durationMs > 0,
          `expected a positive derived durationMs, got ${timedStored.durationMs}`
        );
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
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
        });
        const claimed = queue.claimNext({ runnerId: 'runner-owner' });
        assert.equal(claimed?.status, 'claimed');

        // A foreign runner cannot transition a task owned by another runner.
        const foreign = queue.updateTaskStatus(task.id, {
          status: 'executing',
          runnerId: 'runner-intruder',
        });
        assert.equal(foreign?.applied, false);
        assert.equal(queue.getTask(task.id)?.status, 'claimed');
        assert.equal(queue.getTask(task.id)?.runnerId, 'runner-owner');

        // A queued task may never be taken straight to an active state.
        const queued = queue.enqueue({
          repositoryName: 'agylity',
          prompt: 'Queued takeover guard',
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
        });
        const takeover = queue.updateTaskStatus(queued.id, {
          status: 'executing',
          runnerId: 'runner-intruder',
        });
        assert.equal(takeover?.applied, false);
        assert.equal(queue.getTask(queued.id)?.status, 'queued');
        assert.equal(queue.getTask(queued.id)?.runnerId, undefined);

        // The owning runner may still advance its own task.
        const owned = queue.updateTaskStatus(task.id, {
          status: 'executing',
          runnerId: 'runner-owner',
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
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
        });
        queue.claimNext({ runnerId: 'runner-dead' });

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
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
        });
        queue.claimNext({ runnerId: 'runner-dead-2' });
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
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
        });
        queue.claimNext({ runnerId: 'runner-dead' });
        assert.equal(queue.getRunner('runner-dead')?.status, 'busy');

        const nowMs = Date.now();
        const staleBeat = new Date(nowMs - 20_000).toISOString();
        db.getRawDb()
          .prepare('UPDATE swarm_tasks SET claimed_at = ?, heartbeat_at = ? WHERE id = ?')
          .run(staleBeat, staleBeat, task.id);
        db.getRawDb()
          .prepare('UPDATE swarm_runners SET last_seen_at = ? WHERE runner_id = ?')
          .run(staleBeat, 'runner-dead');

        const reaped = queue.reapStaleClaims(5_000, nowMs);
        assert.equal(reaped.length, 1);
        assert.equal(queue.getRunner('runner-dead')?.status, 'offline');
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
            runnerId: `worker-${i}`,
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

    it('creates the v1 schema once and applies no migration on a second boot', () => {
      const { dir, cleanup } = makeTempDir('queue_schema_v1_');
      const dbPath = path.join(dir, 'test.db');
      const db = new AppDatabase(dbPath);
      try {
        new TaskQueue(db);
        const raw = db.getRawDb();
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
          'num_turns',
          'total_tokens',
          'thinking_tokens',
        ]) {
          assert.ok(columns.has(expected), `v1 swarm_tasks should have ${expected}`);
        }
        // The legacy surface is gone, not merely unused.
        for (const dead of [
          'standing_task_id',
          'worker_id',
          'actor',
          'bot_pr_policy',
          'dispatch_id',
        ]) {
          assert.equal(columns.has(dead), false, `v1 swarm_tasks must not carry ${dead}`);
        }
        assert.equal(
          (raw.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }).c,
          3
        );
        assert.equal(
          (raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v,
          3
        );
        // v2 carries the sentry ledger, so a delivery and its dedupe row can share one commit.
        for (const sentryTable of [
          'pool_state',
          'pool_milestones',
          'pool_samples',
          'probe_state',
          'early_reset_notice',
          'alert_events',
        ]) {
          assert.ok(
            (
              raw
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
                .get(sentryTable) as { name?: string } | undefined
            )?.name,
            `v2 should create ${sentryTable}`
          );
        }

        // Booting the same database again must be a no-op, not a re-run.
        const second = new TaskQueue(db);
        assert.equal(
          (raw.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }).c,
          3
        );

        const task = second.enqueue({
          repositoryName: 'agylity',
          prompt: 'Post-migration enqueue',
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
        });
        assert.equal(task.status, 'queued');
        assert.equal(task.taskNumber, 1);
        // The list projection must not drag the transcript.
        assert.equal(second.listTasks({ limit: 5 })[0]?.output, undefined);
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
  describe('6. Runner GitHub Credential Preflight', () => {
    it('refuses to start when GITHUB_TOKEN is absent', () => {
      assert.throws(() => assertRunnerGitCredentials([], {}), /GITHUB_TOKEN is not set/);
    });

    it('treats a blank token as absent -- compose sets an empty string when the var is unset', () => {
      assert.throws(() => assertRunnerGitCredentials([], { GITHUB_TOKEN: '   ' }), /not set/);
    });

    it('names the compose environment: trap, which is how a token gets lost', () => {
      assert.throws(
        () => assertRunnerGitCredentials(['OtterBoops/agylity'], {}),
        /environment: in compose\.yaml/
      );
    });

    it('accepts a real token', () => {
      assert.doesNotThrow(() => assertRunnerGitCredentials([], { GITHUB_TOKEN: 'ghp_abc123' }));
    });

    it('allows an explicit opt-out for non-GitHub remotes', () => {
      assert.doesNotThrow(() => assertRunnerGitCredentials([], { ALLOW_TOKENLESS_RUNNER: 'true' }));
    });

    it('does not let the opt-out be enabled by a truthy-but-wrong value', () => {
      assert.throws(() => assertRunnerGitCredentials([], { ALLOW_TOKENLESS_RUNNER: 'yes' }));
    });

    it('blocks start() before any registration or poll happens', async () => {
      const savedToken = process.env.GITHUB_TOKEN;
      const savedOptOut = process.env.ALLOW_TOKENLESS_RUNNER;
      delete process.env.GITHUB_TOKEN;
      delete process.env.ALLOW_TOKENLESS_RUNNER;
      try {
        const worker = new RemoteSwarmRunner({
          coordinatorUrl: 'http://127.0.0.1:1',
          runnerId: 'runner-no-token',
          sharedSecret: 'swarm-secret-token-999',
        });
        await assert.rejects(() => worker.start(), /GITHUB_TOKEN is not set/);
      } finally {
        if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = savedToken;
        if (savedOptOut === undefined) delete process.env.ALLOW_TOKENLESS_RUNNER;
        else process.env.ALLOW_TOKENLESS_RUNNER = savedOptOut;
      }
    });
  });
  describe('7. Runner Identity Stability & List Hygiene', () => {
    it('derives the worker id from the configured name, not the container hostname', () => {
      const w = new RemoteSwarmRunner({
        coordinatorUrl: 'http://127.0.0.1:1',
        runnerName: 'worker-homelab',
      });
      // os.hostname() is the container id, so it changes on every recreate.
      assert.equal(w.getRunnerId(), 'worker-homelab');
      assert.ok(!w.getRunnerId().startsWith('runner-'));
    });

    it('gives two recreations of the same configured worker the same id', () => {
      const a = new RemoteSwarmRunner({ coordinatorUrl: 'http://127.0.0.1:1', runnerName: 'w1' });
      const b = new RemoteSwarmRunner({ coordinatorUrl: 'http://127.0.0.1:1', runnerName: 'w1' });
      assert.equal(a.getRunnerId(), b.getRunnerId());
    });

    it('still honours an explicit worker id over the name', () => {
      const w = new RemoteSwarmRunner({
        coordinatorUrl: 'http://127.0.0.1:1',
        runnerId: 'explicit-id',
        runnerName: 'worker-homelab',
      });
      assert.equal(w.getRunnerId(), 'explicit-id');
    });

    it('prunes offline workers past the grace period, keeping live ones', () => {
      const { dir, cleanup } = makeTempDir('orch_prune_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const queue = new TaskQueue(db);
        queue.registerRunnerHeartbeat({ runnerId: 'live-idle', name: 'live-idle', status: 'idle' });
        queue.registerRunnerHeartbeat({ runnerId: 'live-busy', name: 'live-busy', status: 'busy' });
        for (let i = 0; i < 30; i++) {
          queue.registerRunnerHeartbeat({
            runnerId: `dead-${i}`,
            name: `dead-${i}`,
            status: 'offline',
          });
        }
        // Age everything well past the grace period.
        const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        db.getRawDb().prepare('UPDATE swarm_runners SET last_seen_at = ?').run(stale);

        queue.pruneOldRunners();
        assert.deepEqual(
          queue
            .listRunners()
            .map((w) => w.runnerId)
            .sort(),
          ['live-busy', 'live-idle']
        );
      } finally {
        cleanup();
      }
    });

    it('leaves a just-offline worker visible inside the grace period', () => {
      const { dir, cleanup } = makeTempDir('orch_prune_grace_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const queue = new TaskQueue(db);
        queue.registerRunnerHeartbeat({
          runnerId: 'dead-now',
          name: 'dead-now',
          status: 'offline',
        });
        // The reaper marks a worker offline the moment it goes quiet; that transition must be
        // observable rather than deleted in the same cycle.
        queue.pruneOldRunners();
        assert.equal(queue.listRunners().length, 1);
        assert.equal(queue.listRunners()[0]?.status, 'offline');
      } finally {
        cleanup();
      }
    });

    it('is idempotent across repeated reaper cycles', () => {
      const { dir, cleanup } = makeTempDir('orch_prune_idem_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const queue = new TaskQueue(db);
        queue.registerRunnerHeartbeat({ runnerId: 'live-1', name: 'live-1', status: 'idle' });
        for (let i = 0; i < 5; i++) {
          queue.registerRunnerHeartbeat({
            runnerId: `dead-${i}`,
            name: `dead-${i}`,
            status: 'offline',
          });
        }
        const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        db.getRawDb().prepare('UPDATE swarm_runners SET last_seen_at = ?').run(stale);
        queue.pruneOldRunners();
        queue.pruneOldRunners();
        queue.pruneOldRunners();
        assert.deepEqual(
          queue.listRunners().map((w) => w.runnerId),
          ['live-1']
        );
      } finally {
        cleanup();
      }
    });
  });

  describe('8. Standing Tasks & Automated Pre-Reset Quota-Burn Scheduler', () => {
    it('performs CRUD operations on routine tasks in TaskQueue', () => {
      const { dir, cleanup } = makeTempDir('orch_routine_crud_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const queue = new TaskQueue(db);
        assert.deepEqual(queue.listRoutineTasks(), []);

        const created = queue.createRoutineTask({
          title: 'Claude Bug Hunter',
          prompt: 'Audit repo and submit issue',
          repositoryId: 'agylity',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          triggerBeforeResetHours: 12,
        });

        assert.ok(created.id.startsWith('routine-'));
        assert.equal(created.title, 'Claude Bug Hunter');
        assert.deepEqual(created.cascade, [{ model: 'claude-sonnet-5-5', effort: 'high' }]);
        assert.equal(created.triggerBeforeResetHours, 12);
        assert.equal(created.enabled, true);

        const fetched = queue.getRoutineTask(created.id);
        assert.equal(fetched?.id, created.id);

        const updated = queue.updateRoutineTask(created.id, {
          title: 'Claude Bug Hunter v2',
          triggerBeforeResetHours: 14,
          enabled: false,
          lastTriggeredResetTime: '2026-11-08T01:30:44Z',
        });
        assert.equal(updated?.title, 'Claude Bug Hunter v2');
        assert.equal(updated?.triggerBeforeResetHours, 14);
        assert.equal(updated?.enabled, false);
        assert.equal(updated?.lastTriggeredResetTime, '2026-11-08T01:30:44Z');

        const deleted = queue.deleteRoutineTask(created.id);
        assert.equal(deleted, true);
        assert.equal(queue.getRoutineTask(created.id), undefined);
      } finally {
        cleanup();
      }
    });

    it('performs CRUD operations on backlog tasks in TaskQueue', () => {
      const { dir, cleanup } = makeTempDir('orch_backlog_crud_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const queue = new TaskQueue(db);
        assert.deepEqual(queue.listBacklogTasks(), []);

        const created = queue.createBacklogTask({
          title: 'Implement feature X',
          prompt: 'Full prompt details',
          repositoryId: 'agylity',
          cascade: [
            { model: 'gemini-4-hydrogen', effort: 'medium' },
            { model: 'gemini-4-argon', effort: 'high' },
          ],
          priorityOrder: 1,
        });

        assert.ok(created.id.startsWith('backlog-'));
        assert.equal(created.taskNumber, 1);
        assert.equal(created.title, 'Implement feature X');
        // Order and per-hop effort both survive the round trip.
        assert.deepEqual(created.cascade, [
          { model: 'gemini-4-hydrogen', effort: 'medium' },
          { model: 'gemini-4-argon', effort: 'high' },
        ]);
        assert.equal(created.status, 'pending');
        assert.equal(created.attemptCount, 0);

        const fetched = queue.getBacklogTask(created.id);
        assert.equal(fetched?.id, created.id);

        const next = queue.getNextEligibleBacklogTask();
        assert.equal(next?.id, created.id);

        const updated = queue.updateBacklogTask(created.id, {
          title: 'Implement feature X (revised)',
          status: 'dispatched',
          attemptCount: 1,
          swarmTaskId: 'task-123',
        });
        assert.equal(updated?.title, 'Implement feature X (revised)');
        assert.equal(updated?.status, 'dispatched');
        assert.equal(updated?.attemptCount, 1);
        assert.equal(updated?.swarmTaskId, 'task-123');

        const deleted = queue.deleteBacklogTask(created.id);
        assert.equal(deleted, true);
        assert.equal(queue.getBacklogTask(created.id), undefined);
      } finally {
        cleanup();
      }
    });

    it('keeps a paused backlog row paused through an abort and never re-dispatches it', async () => {
      const { dir, cleanup } = makeTempDir('orch_backlog_paused_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const configStore = new ConfigStore(db, {
          coordinatorEnabled: true,
          defaultDispatchModel: 'claude-sonnet-5-5',
          poolPolicies: {
            claude: { alertsEnabled: true, dispatchEnabled: true },
            'gemini-argon': { alertsEnabled: true, dispatchEnabled: true },
            'gemini-flash': { alertsEnabled: true, dispatchEnabled: true },
          },
          repositories: [
            {
              id: 'agylity',
              name: 'OtterBoops/agylity',
              path: dir,
              cloneUrl: 'https://github.com/OtterBoops/agylity',
              defaultBranch: 'main',
            },
          ],
        });
        const coordinator = new Coordinator({ configStore });

        const origin = coordinator.queue.createBacklogTask({
          title: 'Pausable item',
          prompt: 'Work',
          repositoryId: 'agylity',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
        });
        const run = coordinator.queue.enqueue({
          repositoryId: 'agylity',
          repositoryName: 'agylity',
          prompt: 'Work',
          tier: 'backlog',
          originId: origin.id,
          originNumber: origin.taskNumber,
          originTitle: origin.title,
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          scheduleMode: 'immediate',
        });
        coordinator.queue.updateBacklogTask(origin.id, {
          status: 'dispatched',
          attemptCount: 1,
          swarmTaskId: run.id,
        });

        // Stop & Pause: the row is paused first, then the in-flight run is aborted.
        coordinator.queue.updateBacklogTask(origin.id, { status: 'paused' });
        await coordinator.cancelTask(run.id);

        // A late abort must not hand the row back to the evaluator as a retryable pending row.
        assert.equal(coordinator.queue.getBacklogTask(origin.id)?.status, 'paused');
        assert.equal(coordinator.queue.getNextEligibleBacklogTask(), undefined);

        const snapshots: QuotaSnapshot[] = [
          {
            poolId: 'claude',
            family: 'claude',
            displayName: 'Claude and GPT models',
            remainingFraction: 0.6,
            resetTime: '2026-11-08T01:30:44Z',
            hoursUntilReset: 1,
            models: ['Claude Sonnet'],
          },
        ];

        coordinator.setLastManualDispatchAt(Date.now() - 3 * 3600 * 1000);
        const whilePaused = await coordinator.triggerEligibleAutonomousTasks(snapshots);
        assert.equal(whilePaused.length, 0);
        assert.equal(coordinator.queue.getBacklogTask(origin.id)?.status, 'paused');

        // Resume is the only path back into the queue.
        coordinator.queue.updateBacklogTask(origin.id, { status: 'pending' });
        const afterResume = await coordinator.triggerEligibleAutonomousTasks(snapshots);
        assert.equal(afterResume.length, 1);
        assert.equal(afterResume[0]?.tier, 'backlog');
        assert.equal(afterResume[0]?.originId, origin.id);
        assert.equal(coordinator.queue.getBacklogTask(origin.id)?.status, 'dispatched');
      } finally {
        db.close();
        cleanup();
      }
    });

    it('quenches autonomous tasks when manual dispatch occurred within past 2 hours', async () => {
      const { dir, cleanup } = makeTempDir('orch_quench_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const configStore = new ConfigStore(db, {
          coordinatorEnabled: true,
          defaultDispatchModel: 'claude-sonnet-5-5',
          poolPolicies: {
            claude: { alertsEnabled: true, dispatchEnabled: true },
            'gemini-argon': { alertsEnabled: true, dispatchEnabled: true },
            'gemini-flash': { alertsEnabled: true, dispatchEnabled: true },
          },
          repositories: [
            {
              id: 'agylity',
              name: 'OtterBoops/agylity',
              path: dir,
              cloneUrl: 'https://github.com/OtterBoops/agylity',
              defaultBranch: 'main',
            },
          ],
        });
        const coordinator = new Coordinator({ configStore });

        coordinator.queue.createRoutineTask({
          title: 'Routine 1',
          prompt: 'Work',
          repositoryId: 'agylity',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          triggerBeforeResetHours: 12,
        });

        // Set lastManualDispatchAt to 30 minutes ago (within 2h window)
        coordinator.setLastManualDispatchAt(Date.now() - 30 * 60 * 1000);

        const snapshots: QuotaSnapshot[] = [
          {
            poolId: 'claude',
            family: 'claude',
            displayName: 'Claude and GPT models',
            remainingFraction: 0.5,
            resetTime: '2026-11-08T01:30:44Z',
            hoursUntilReset: 1,
            models: ['Claude Sonnet'],
          },
        ];

        const spawned = await coordinator.triggerEligibleAutonomousTasks(snapshots);
        assert.equal(spawned.length, 0); // Quenched!

        // Move manual dispatch to 2.5 hours ago (>2h quench window)
        coordinator.setLastManualDispatchAt(Date.now() - 2.5 * 3600 * 1000);
        const spawnedAfterQuench = await coordinator.triggerEligibleAutonomousTasks(snapshots);
        assert.equal(spawnedAfterQuench.length, 1);
        assert.equal(spawnedAfterQuench[0]?.tier, 'routine');
      } finally {
        cleanup();
      }
    });

    it('auto-triggers eligible routine tasks when pool reset is imminent and dedupes per cycle', async () => {
      const { dir, cleanup } = makeTempDir('orch_routine_sched_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const configStore = new ConfigStore(db, {
          coordinatorEnabled: true,
          defaultDispatchModel: 'claude-sonnet-5-5',
          poolPolicies: {
            claude: { alertsEnabled: true, dispatchEnabled: true },
            'gemini-argon': { alertsEnabled: true, dispatchEnabled: true },
            'gemini-flash': { alertsEnabled: true, dispatchEnabled: true },
          },
          repositories: [
            {
              id: 'agylity',
              name: 'OtterBoops/agylity',
              path: dir,
              cloneUrl: 'https://github.com/OtterBoops/agylity',
              defaultBranch: 'main',
            },
          ],
        });
        const coordinator = new Coordinator({ configStore });

        const rt = coordinator.queue.createRoutineTask({
          title: 'Claude Pre-Reset Burn',
          prompt: 'Audit code and test',
          repositoryId: 'agylity',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'medium' }],
          triggerBeforeResetHours: 12,
        });

        const resetTime = '2026-11-08T01:30:44Z';

        // 1. When pool is 15h away (>12h), scheduler does NOT trigger
        const farSnapshots: QuotaSnapshot[] = [
          {
            poolId: 'claude',
            family: 'claude',
            displayName: 'Claude and GPT models',
            remainingFraction: 0.5, // 50%
            resetTime,
            hoursUntilReset: 15,
            models: ['Claude Sonnet'],
          },
        ];
        const spawnedFar = await coordinator.triggerEligibleRoutines(farSnapshots);
        assert.equal(spawnedFar.length, 0);
        assert.equal(coordinator.queue.getRoutineTask(rt.id)?.lastTriggeredResetTime, undefined);

        // 2. When pool is 10h away (<=12h), scheduler TRIGGERS the routine task
        const imminentSnapshots: QuotaSnapshot[] = [
          {
            poolId: 'claude',
            family: 'claude',
            displayName: 'Claude and GPT models',
            remainingFraction: 0.5, // 50%
            resetTime,
            hoursUntilReset: 10,
            models: ['Claude Sonnet'],
          },
        ];
        const spawned = await coordinator.triggerEligibleRoutines(imminentSnapshots);
        assert.equal(spawned.length, 1);
        const task = spawned[0]!;
        assert.equal(task.tier, 'routine');
        assert.equal(task.originId, rt.id);
        assert.equal(task.model, 'claude-sonnet-5-5');
        assert.equal(task.scheduleMode, 'pre_reset');
        assert.equal(task.status, 'queued');

        // Verify routine task was stamped with lastTriggeredResetTime and lastTaskId
        const updatedRt = coordinator.queue.getRoutineTask(rt.id);
        assert.equal(updatedRt?.lastTriggeredResetTime, resetTime);
        assert.equal(updatedRt?.lastTaskId, task.id);

        // 3. A still-running task blocks the cycle: one in-flight run per routine at a time
        const recheck = await coordinator.triggerEligibleRoutines(imminentSnapshots);
        assert.equal(recheck.length, 0);
      } finally {
        cleanup();
      }
    });

    it('loops a routine sequentially inside one reset cycle after the previous run completed', async () => {
      const { dir, cleanup } = makeTempDir('orch_routine_loop_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const configStore = new ConfigStore(db, {
          coordinatorEnabled: true,
          defaultDispatchModel: 'claude-sonnet-5-5',
          poolPolicies: {
            claude: { alertsEnabled: true, dispatchEnabled: true },
            'gemini-argon': { alertsEnabled: true, dispatchEnabled: true },
            'gemini-flash': { alertsEnabled: true, dispatchEnabled: true },
          },
          repositories: [
            {
              id: 'agylity',
              name: 'OtterBoops/agylity',
              path: dir,
              defaultBranch: 'main',
            },
          ],
        });
        const coordinator = new Coordinator({ configStore });

        const rt = coordinator.queue.createRoutineTask({
          title: 'Claude Pre-Reset Loop',
          prompt: 'Keep burning quota',
          repositoryId: 'agylity',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          triggerBeforeResetHours: 12,
          minHeadroomPercent: 10,
        });

        const resetTime = '2026-11-08T01:30:44Z';
        const snapshots: QuotaSnapshot[] = [
          {
            poolId: 'claude',
            family: 'claude',
            displayName: 'Claude and GPT models',
            remainingFraction: 0.5,
            resetTime,
            hoursUntilReset: 10,
            models: ['Claude Sonnet'],
          },
        ];

        const first = await coordinator.triggerEligibleRoutines(snapshots);
        assert.equal(first.length, 1);
        const firstTask = first[0]!;
        assert.equal(coordinator.queue.getRoutineTask(rt.id)?.lastTriggeredResetTime, resetTime);

        // Still queued: a second pass must not stack a second run
        assert.equal((await coordinator.triggerEligibleRoutines(snapshots)).length, 0);

        await coordinator.reportTaskStatus(firstTask.id, { status: 'completed' });

        // Same resetTime, later in the cycle: completion re-arms the routine
        const second = await coordinator.triggerEligibleRoutines(snapshots);
        assert.equal(second.length, 1);
        const secondTask = second[0]!;
        assert.notEqual(secondTask.id, firstTask.id);
        assert.equal(secondTask.originId, rt.id);
        assert.equal(secondTask.tier, 'routine');
        assert.equal(coordinator.queue.getRoutineTask(rt.id)?.lastTaskId, secondTask.id);

        // And it keeps looping: a third completion yields a third run in the same cycle
        await coordinator.reportTaskStatus(secondTask.id, { status: 'completed' });
        const third = await coordinator.triggerEligibleRoutines(snapshots);
        assert.equal(third.length, 1);
      } finally {
        db.close();
        cleanup();
      }
    });

    it('announces the burn kick once per reset cycle and never pings the owner', async () => {
      const { dir, cleanup } = makeTempDir('orch_routine_burn_kick_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const configStore = new ConfigStore(db, {
          coordinatorEnabled: true,
          defaultDispatchModel: 'claude-sonnet-5-5',
          poolPolicies: {
            claude: { alertsEnabled: true, dispatchEnabled: true },
            'gemini-argon': { alertsEnabled: true, dispatchEnabled: true },
            'gemini-flash': { alertsEnabled: true, dispatchEnabled: true },
          },
          repositories: [
            {
              id: 'agylity',
              name: 'OtterBoops/agylity',
              path: dir,
              defaultBranch: 'main',
            },
          ],
        });

        const notices: InfoNotice[] = [];
        const coordinator = new Coordinator({
          configStore,
          notifier: {
            channelName: 'test',
            initialize: async () => {},
            notifyQuotaAlert: async () => ({ delivered: true, results: {} }),
            notifyDispatchStatus: async () => {},
            notifyInfo: async (notice) => {
              notices.push(notice);
            },
            shutdown: async () => {},
          },
        });

        coordinator.queue.createRoutineTask({
          title: 'Claude Pre-Reset Loop',
          prompt: 'Keep burning quota',
          repositoryId: 'agylity',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          triggerBeforeResetHours: 12,
          minHeadroomPercent: 10,
        });

        const resetTime = '2026-11-08T01:30:44Z';
        const snapshots: QuotaSnapshot[] = [
          {
            poolId: 'claude',
            family: 'claude',
            displayName: 'Claude and GPT models',
            remainingFraction: 0.5,
            resetTime,
            hoursUntilReset: 10,
            models: ['Claude Sonnet'],
          },
        ];

        const first = await coordinator.triggerEligibleRoutines(snapshots);
        assert.equal(first.length, 1);
        assert.equal(notices.length, 1);
        assert.match(notices[0]!.title, /Pre-reset burn started/);
        assert.equal(notices[0]!.poolFamily, 'claude');
        assert.equal(notices[0]!.resetTime, resetTime);
        assert.match(notices[0]!.message, /Routine #1/);

        // Looping inside the same cycle must not re-announce for the same pool.
        await coordinator.reportTaskStatus(first[0]!.id, { status: 'completed' });
        const second = await coordinator.triggerEligibleRoutines(snapshots);
        assert.equal(second.length, 1);
        assert.equal(notices.length, 1);

        // A new reset cycle is a new kick, so it announces again.
        await coordinator.reportTaskStatus(second[0]!.id, { status: 'completed' });
        const nextCycle: QuotaSnapshot[] = [
          {
            ...snapshots[0]!,
            resetTime: '2026-11-09T01:30:44Z',
          },
        ];
        const third = await coordinator.triggerEligibleRoutines(nextCycle);
        assert.equal(third.length, 1);
        assert.equal(notices.length, 2);
        assert.equal(notices[1]!.resetTime, '2026-11-09T01:30:44Z');
      } finally {
        db.close();
        cleanup();
      }
    });

    it('holds one active routine task across queued, claimed and executing states', async () => {
      const { dir, cleanup } = makeTempDir('orch_routine_single_active_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const configStore = new ConfigStore(db, {
          coordinatorEnabled: true,
          defaultDispatchModel: 'claude-sonnet-5-5',
          poolPolicies: {
            claude: { alertsEnabled: true, dispatchEnabled: true },
            'gemini-argon': { alertsEnabled: true, dispatchEnabled: true },
            'gemini-flash': { alertsEnabled: true, dispatchEnabled: true },
          },
        });
        const coordinator = new Coordinator({ configStore });

        const rt = coordinator.queue.createRoutineTask({
          title: 'Claude Dedup',
          prompt: 'Burn quota once at a time',
          repositoryId: 'agylity',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          triggerBeforeResetHours: 12,
        });

        const snapshots: QuotaSnapshot[] = [
          {
            poolId: 'claude',
            family: 'claude',
            displayName: 'Claude and GPT models',
            remainingFraction: 0.5,
            // A pre_reset dispatch expires with its window, so the fixture deadline must be live.
            resetTime: new Date(Date.now() + 10 * 3600_000).toISOString(),
            hoursUntilReset: 10,
            models: ['Claude Sonnet'],
          },
        ];

        const spawned = await coordinator.triggerEligibleRoutines(snapshots);
        assert.equal(spawned.length, 1);
        const taskId = spawned[0]!.id;
        assert.equal(spawned[0]!.originId, rt.id);

        // queued -> claimed through the queue's own claim path, then executing
        const claimed = coordinator.queue.claimNext({
          runnerId: 'runner-test',
          runnerName: 'test',
        });
        assert.equal(claimed?.id, taskId);
        assert.equal((await coordinator.triggerEligibleRoutines(snapshots)).length, 0);

        coordinator.queue.updateTaskStatus(taskId, {
          status: 'executing',
          runnerId: 'runner-test',
        });
        assert.equal(coordinator.queue.getTask(taskId)?.status, 'executing');
        assert.equal((await coordinator.triggerEligibleRoutines(snapshots)).length, 0);
      } finally {
        db.close();
        cleanup();
      }
    });

    it('stops looping for the reset cycle once a run fails or is cancelled', async () => {
      const { dir, cleanup } = makeTempDir('orch_routine_fail_stop_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const configStore = new ConfigStore(db, {
          coordinatorEnabled: true,
          defaultDispatchModel: 'claude-sonnet-5-5',
          poolPolicies: {
            claude: { alertsEnabled: true, dispatchEnabled: true },
            'gemini-argon': { alertsEnabled: true, dispatchEnabled: true },
            'gemini-flash': { alertsEnabled: true, dispatchEnabled: true },
          },
        });
        const coordinator = new Coordinator({ configStore });

        const resetTime = '2026-11-08T01:30:44Z';
        const snapshots: QuotaSnapshot[] = [
          {
            poolId: 'claude',
            family: 'claude',
            displayName: 'Claude and GPT models',
            remainingFraction: 0.5,
            resetTime,
            hoursUntilReset: 10,
            models: ['Claude Sonnet'],
          },
        ];

        const failing = coordinator.queue.createRoutineTask({
          title: 'Claude Fail Stop',
          prompt: 'Fail once',
          repositoryId: 'agylity',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          triggerBeforeResetHours: 12,
        });
        const firstRun = await coordinator.triggerEligibleRoutines(snapshots);
        assert.equal(firstRun.length, 1);
        await coordinator.reportTaskStatus(firstRun[0]!.id, {
          status: 'failed',
          error: 'boom',
        });

        // Same cycle, condition still met, but the cycle is burned by the failure
        assert.equal((await coordinator.triggerEligibleRoutines(snapshots)).length, 0);
        assert.equal((await coordinator.triggerEligibleRoutines(snapshots)).length, 0);
        assert.equal(coordinator.queue.getRoutineTask(failing.id)?.lastTaskId, firstRun[0]!.id);

        // A cancel inside the cycle stops it just the same
        await coordinator.queue.updateRoutineTask(failing.id, { enabled: false });
        const cancelled = coordinator.queue.createRoutineTask({
          title: 'Claude Cancel Stop',
          prompt: 'Cancel once',
          repositoryId: 'agylity',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          triggerBeforeResetHours: 12,
        });
        const cancelRun = await coordinator.triggerEligibleRoutines(snapshots);
        assert.equal(cancelRun.length, 1);
        assert.equal(cancelRun[0]!.originId, cancelled.id);
        await coordinator.cancelTask(cancelRun[0]!.id);
        assert.equal((await coordinator.triggerEligibleRoutines(snapshots)).length, 0);

        // A new reset cycle re-arms both routines
        const nextCycle: QuotaSnapshot[] = [
          {
            ...snapshots[0]!,
            resetTime: '2026-11-09T01:30:44Z',
          },
        ];
        const afterReset = await coordinator.triggerEligibleRoutines(nextCycle);
        assert.equal(afterReset.length, 1);
        assert.equal(afterReset[0]!.originId, cancelled.id);
      } finally {
        db.close();
        cleanup();
      }
    });

    it('skips disabled routine tasks or pools with disabled dispatch', async () => {
      const { dir, cleanup } = makeTempDir('orch_routine_disabled_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const configStore = new ConfigStore(db, {
          coordinatorEnabled: true,
          poolPolicies: {
            claude: { dispatchEnabled: false, alertsEnabled: true },
            'gemini-argon': { dispatchEnabled: true, alertsEnabled: true },
            'gemini-flash': { dispatchEnabled: true, alertsEnabled: true },
          },
        });
        const coordinator = new Coordinator({ configStore });

        coordinator.queue.createRoutineTask({
          title: 'Claude Burn',
          prompt: 'Audit code',
          repositoryId: 'agylity',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          triggerBeforeResetHours: 12,
          enabled: true,
        });

        const snapshots: QuotaSnapshot[] = [
          {
            poolId: 'claude',
            family: 'claude',
            displayName: 'Claude and GPT models',
            remainingFraction: 0.5,
            resetTime: '2026-11-08T01:30:44Z',
            hoursUntilReset: 10,
            models: ['Claude Sonnet'],
          },
        ];

        // Skipped because pool policy has dispatchEnabled: false
        const spawned = await coordinator.triggerEligibleRoutines(snapshots);
        assert.equal(spawned.length, 0);
      } finally {
        cleanup();
      }
    });

    const routineFixture = () => {
      const { dir, cleanup } = makeTempDir('orch_routine_batch2_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      const configStore = new ConfigStore(db, {
        coordinatorEnabled: true,
        defaultDispatchModel: 'claude-sonnet-5-5',
        poolPolicies: {
          claude: { alertsEnabled: true, dispatchEnabled: true },
          'gemini-argon': { alertsEnabled: true, dispatchEnabled: true },
          'gemini-flash': { alertsEnabled: true, dispatchEnabled: true },
        },
        repositories: [
          {
            id: 'agylity',
            name: 'OtterBoops/agylity',
            path: dir,
            cloneUrl: 'https://github.com/OtterBoops/agylity',
            defaultBranch: 'main',
          },
        ],
      });
      return { db, cleanup, coordinator: new Coordinator({ configStore }) };
    };

    const poolSnapshot = (
      family: 'claude' | 'gemini-argon' | 'gemini-flash',
      hoursUntilReset: number,
      remainingFraction: number
    ): QuotaSnapshot => ({
      poolId: family,
      family,
      displayName: `${family} models`,
      remainingFraction,
      resetTime: '2026-11-08T01:30:44Z',
      hoursUntilReset,
      models: [],
    });

    it('dispatches one routine per pool family inside a single autonomous tick', async () => {
      const { db, cleanup, coordinator } = routineFixture();
      try {
        const claudeRoutine = coordinator.queue.createRoutineTask({
          title: 'Claude Burn',
          prompt: 'Burn the claude pool',
          repositoryId: 'agylity',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          triggerBeforeResetHours: 12,
        });
        const argonRoutine = coordinator.queue.createRoutineTask({
          title: 'Argon Burn',
          prompt: 'Burn the argon pool',
          repositoryId: 'agylity',
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
          triggerBeforeResetHours: 12,
        });

        const spawned = await coordinator.triggerEligibleAutonomousTasks([
          poolSnapshot('claude', 10, 0.5),
          poolSnapshot('gemini-argon', 8, 0.6),
        ]);

        // One slot per family: both pools inside their window must both fire, not just the first.
        assert.equal(spawned.length, 2);
        assert.deepEqual(
          spawned.map((t) => t.poolFamily).sort(),
          ['claude', 'gemini-argon'].sort()
        );
        assert.deepEqual(
          spawned.map((t) => t.originId).sort(),
          [claudeRoutine.id, argonRoutine.id].sort()
        );
        assert.equal(
          spawned.every((t) => t.tier === 'routine'),
          true
        );
      } finally {
        db.close();
        cleanup();
      }
    });

    it('orders routine candidates least-recently-triggered first so a fast loop cannot starve its neighbour', async () => {
      const { db, cleanup, coordinator } = routineFixture();
      try {
        const firstInOrder = coordinator.queue.createRoutineTask({
          title: 'First In Order',
          prompt: 'Burn quota first',
          repositoryId: 'agylity',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          triggerBeforeResetHours: 12,
          sortOrder: 0,
        });
        const secondInOrder = coordinator.queue.createRoutineTask({
          title: 'Second In Order',
          prompt: 'Burn quota second',
          repositoryId: 'agylity',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          triggerBeforeResetHours: 12,
          sortOrder: 1,
        });
        const snapshots = [poolSnapshot('claude', 10, 0.5)];

        // Neither has run yet, so the single claude slot goes to sortOrder.
        const firstTick = await coordinator.triggerEligibleRoutines(snapshots);
        assert.equal(firstTick.length, 1);
        assert.equal(firstTick[0]!.originId, firstInOrder.id);

        // A completed run re-arms its own cycle, so only run recency can move the slot onward.
        await coordinator.reportTaskStatus(firstTick[0]!.id, { status: 'completed' });
        assert.equal(
          coordinator.queue.getRoutineTask(firstInOrder.id)?.lastTriggeredResetTime,
          '2026-11-08T01:30:44Z'
        );

        const secondTick = await coordinator.triggerEligibleRoutines(snapshots);
        assert.equal(secondTick.length, 1);
        assert.equal(secondTick[0]!.originId, secondInOrder.id);
      } finally {
        db.close();
        cleanup();
      }
    });

    it('computes every routine eligibility state from live pool telemetry', async () => {
      const { db, cleanup, coordinator } = routineFixture();
      try {
        const disabled = coordinator.queue.createRoutineTask({
          title: 'Disabled Routine',
          prompt: 'Never dispatches',
          repositoryId: 'agylity',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          enabled: false,
        });
        assert.equal(
          coordinator.computeRoutineEligibility(disabled, [poolSnapshot('claude', 1, 0.9)]).state,
          'disabled'
        );

        // Its own pool family, so the 10h claude snapshot below cannot make it dispatchable.
        const waiting = coordinator.queue.createRoutineTask({
          title: 'Waiting Routine',
          prompt: 'Waits for the window',
          repositoryId: 'agylity',
          cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
          triggerBeforeResetHours: 12,
        });
        assert.equal(
          coordinator.computeRoutineEligibility(waiting, [poolSnapshot('gemini-flash', 15, 0.9)])
            .state,
          'waiting_window'
        );

        const starved = coordinator.queue.createRoutineTask({
          title: 'Starved Routine',
          prompt: 'No headroom left',
          repositoryId: 'agylity',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          triggerBeforeResetHours: 12,
          minHeadroomPercent: 10,
        });
        assert.equal(
          coordinator.computeRoutineEligibility(starved, [poolSnapshot('claude', 10, 0.05)]).state,
          'low_headroom'
        );

        const ready = coordinator.queue.createRoutineTask({
          title: 'Ready Routine',
          prompt: 'Eligible right now',
          repositoryId: 'agylity',
          cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
          triggerBeforeResetHours: 12,
        });
        assert.equal(
          coordinator.computeRoutineEligibility(ready, [poolSnapshot('gemini-flash', 10, 0.5)])
            .state,
          'ready'
        );

        // Disabled and under-floor routines must not claim the claude slot either.
        assert.equal(
          (await coordinator.triggerEligibleRoutines([poolSnapshot('claude', 10, 0.05)])).length,
          0
        );

        const settled = coordinator.queue.createRoutineTask({
          title: 'Settled Routine',
          prompt: 'Already burned this cycle',
          repositoryId: 'agylity',
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
          triggerBeforeResetHours: 12,
        });
        const settledRun = await coordinator.triggerEligibleRoutines([
          poolSnapshot('gemini-argon', 10, 0.5),
        ]);
        assert.equal(settledRun.length, 1);
        assert.equal(settledRun[0]!.originId, settled.id);

        // Re-read the record: the cycle stamp lives in the queue, not in the create() return value.
        const readSettled = () => coordinator.queue.getRoutineTask(settled.id)!;

        // A productive run re-arms its own cycle, so the loop is still entitled to the next slot.
        await coordinator.reportTaskStatus(settledRun[0]!.id, { status: 'completed' });
        assert.equal(
          coordinator.computeRoutineEligibility(readSettled(), [
            poolSnapshot('gemini-argon', 10, 0.5),
          ]).state,
          'ready'
        );

        // A no_changes run burns the cycle: there is nothing left for this reset to spend.
        const loopRun = await coordinator.triggerEligibleRoutines([
          poolSnapshot('gemini-argon', 10, 0.5),
        ]);
        assert.equal(loopRun.length, 1);
        assert.notEqual(loopRun[0]!.id, settledRun[0]!.id);
        await coordinator.reportTaskStatus(loopRun[0]!.id, { status: 'no_changes' });
        assert.equal(
          coordinator.computeRoutineEligibility(readSettled(), [
            poolSnapshot('gemini-argon', 10, 0.5),
          ]).state,
          'cycle_complete'
        );

        const failing = coordinator.queue.createRoutineTask({
          title: 'Failing Routine',
          prompt: 'Failed this cycle',
          repositoryId: 'agylity',
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
          triggerBeforeResetHours: 12,
        });
        const failedRun = await coordinator.triggerEligibleRoutines([
          poolSnapshot('gemini-argon', 10, 0.5),
        ]);
        assert.equal(failedRun.length, 1);
        assert.equal(failedRun[0]!.originId, failing.id);

        // A failure is terminal for the cycle and must read as a failure, not as completed work.
        await coordinator.reportTaskStatus(failedRun[0]!.id, {
          status: 'failed',
          error: 'runner exited 1',
        });
        const failedStatus = coordinator.computeRoutineEligibility(
          coordinator.queue.getRoutineTask(failing.id)!,
          [poolSnapshot('gemini-argon', 10, 0.5)]
        );
        assert.equal(failedStatus.state, 'cycle_failed');
        assert.match(failedStatus.detail, /last run failed/);
      } finally {
        db.close();
        cleanup();
      }
    });

    it('streams the runner output tail into a running task on heartbeat', () => {
      const { db, cleanup, coordinator } = routineFixture();
      try {
        const task = coordinator.queue.enqueue({
          repositoryId: 'agylity',
          repositoryName: 'OtterBoops/agylity',
          prompt: 'Stream the run output',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
        });
        const claimed = coordinator.queue.claimNext({
          runnerId: 'runner-test',
          runnerName: 'test',
        });
        assert.equal(claimed?.id, task.id);
        coordinator.queue.updateTaskStatus(task.id, {
          status: 'executing',
          runnerId: 'runner-test',
        });

        const beat = coordinator.heartbeatTask(task.id, 'runner-test', undefined, 'step 1\nstep 2');
        assert.equal(beat?.applied, true);
        assert.equal(beat?.task.status, 'executing');
        assert.equal(beat?.task.output, 'step 1\nstep 2');

        // A tail-less beat refreshes the lease without blanking what the previous beat delivered.
        const bareBeat = coordinator.heartbeatTask(task.id, 'runner-test');
        assert.equal(bareBeat?.applied, true);
        assert.equal(bareBeat?.task.output, 'step 1\nstep 2');

        // A foreign runner cannot write into a run it does not own.
        const stolen = coordinator.heartbeatTask(task.id, 'runner-other', undefined, 'stolen');
        assert.equal(stolen?.applied, false);
        assert.equal(coordinator.queue.getTask(task.id)?.output, 'step 1\nstep 2');
      } finally {
        db.close();
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 12. Flat Disclosure Footer & Autonomous PR Governance Policy          */
  /* ==================================================================== */
  describe('12. Flat Disclosure Footer & Autonomous PR Governance Policy', () => {
    it('isDocumentationFile accurately identifies documentation files and paths', () => {
      // Documentation files
      assert.equal(isDocumentationFile('README.md'), true);
      assert.equal(isDocumentationFile('README'), true);
      assert.equal(isDocumentationFile('LICENSE'), true);
      assert.equal(isDocumentationFile('LICENSE.txt'), true);
      assert.equal(isDocumentationFile('CONTRIBUTING.md'), true);
      assert.equal(isDocumentationFile('docs/guide.md'), true);
      assert.equal(isDocumentationFile('docs/images/diagram.svg'), true);
      assert.equal(isDocumentationFile('.github/ISSUE_TEMPLATE/bug.md'), true);

      // Non-documentation code / config / workflow files
      assert.equal(isDocumentationFile('src/index.ts'), false);
      assert.equal(isDocumentationFile('package.json'), false);
      assert.equal(isDocumentationFile('compose.yaml'), false);
      assert.equal(isDocumentationFile('Dockerfile'), false);
      assert.equal(isDocumentationFile('.github/workflows/ci.yml'), false);
      assert.equal(isDocumentationFile('scripts/build.sh'), false);
    });

    it('always appends flat disclosure footer without agylity[bot] commit authorship', async () => {
      const { dir, cleanup } = makeTempDir('orch_flat_disclosure_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const queue = new TaskQueue(db);
        const botTask = queue.enqueue({
          repositoryName: 'agylity',
          repositoryPath: dir,
          prompt: 'Fix bug in auth',
          cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
          prPolicy: 'all',
          pushBranch: true,
          autoCreatePr: true,
        });

        const capturedPrompts: string[] = [];
        let capturedCommitEnv: Record<string, string | undefined> | undefined;
        const executor = new TaskExecutor({
          agyBinPath: 'agy',
          dirExistsFn: () => true,
          prPolicy: 'all',
          execFileFn: async (file, args, opts) => {
            if (file === 'agy') {
              const pIdx = args.indexOf('-p');
              if (pIdx >= 0) capturedPrompts.push(String(args[pIdx + 1]));
              return { stdout: 'done', stderr: '' };
            }
            if (file === 'git' && args[0] === 'status') {
              return { stdout: ' M src/auth.ts\n', stderr: '' };
            }
            if (file === 'git' && args[0] === 'commit') {
              capturedCommitEnv = opts?.env as Record<string, string | undefined>;
              return { stdout: '[main 1234567] commit', stderr: '' };
            }
            if (file === 'gh' && args[0] === 'pr') {
              return { stdout: 'https://github.com/OtterBoops/agylity/pull/42\n', stderr: '' };
            }
            return { stdout: 'done', stderr: '' };
          },
        });

        const res = await executor.execute(botTask);
        assert.equal(res.success, true);
        assert.equal(res.prUrl, 'https://github.com/OtterBoops/agylity/pull/42');
        assert.ok(
          capturedPrompts[0]?.includes(
            '*Dispatched via Agylity (immediate) with `gemini-4-hydrogen` (medium reasoning) — please review carefully.*'
          )
        );
        assert.notEqual(capturedCommitEnv?.GIT_AUTHOR_NAME, 'agylity[bot]');

        const userTask = queue.enqueue({
          repositoryName: 'agylity',
          repositoryPath: dir,
          prompt: 'User task',
          cascade: [{ model: 'gemini-4-hydrogen', effort: 'low' }],
          pushBranch: false,
          autoCreatePr: false,
        });
        await executor.execute(userTask);
        assert.ok(
          capturedPrompts[1]?.includes(
            '*Dispatched via Agylity (immediate) with `gemini-4-hydrogen` (low reasoning) — please review carefully.*'
          )
        );
      } finally {
        db.close();
        cleanup();
      }
    });

    it('blocks autonomous PRs and deletes the branch when an agent run modifies code under prPolicy=docs_only', async () => {
      const { dir, cleanup } = makeTempDir('orch_bot_docs_only_block_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const queue = new TaskQueue(db);
        const task = queue.enqueue({
          repositoryName: 'agylity',
          repositoryPath: dir,
          prompt: 'Refactor auth',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          tier: 'routine',
          pushBranch: true,
          autoCreatePr: true,
        });

        const gitInvocations: string[][] = [];
        const executor = new TaskExecutor({
          agyBinPath: 'agy',
          dirExistsFn: () => true,
          prPolicy: 'docs_only',
          execFileFn: async (file, args) => {
            if (file === 'git') {
              gitInvocations.push(args as string[]);
              if (args[0] === 'status') {
                return { stdout: ' M src/auth.ts\n', stderr: '' };
              }
              if (args[0] === 'diff' && args.includes('--name-only')) {
                return { stdout: 'src/auth.ts\n', stderr: '' };
              }
            }
            return { stdout: 'done', stderr: '' };
          },
        });

        const res = await executor.execute(task);
        assert.equal(res.success, true);
        assert.equal(res.noChanges, true);
        assert.ok(
          res.output.includes(
            "[Policy Guard] Autonomous PR suppressed: PR policy is 'docs_only', so only"
          )
        );
        assert.ok(res.output.includes('src/auth.ts'));
        assert.ok(!gitInvocations.some((args) => args.includes('push') && !args.includes('stash')));
        assert.ok(gitInvocations.some((args) => args[0] === 'branch' && args[1] === '-D'));
      } finally {
        db.close();
        cleanup();
      }
    });

    it('allows autonomous PRs when an agent run modifies only documentation under prPolicy=docs_only', async () => {
      const { dir, cleanup } = makeTempDir('orch_bot_docs_only_allow_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const queue = new TaskQueue(db);
        const task = queue.enqueue({
          repositoryName: 'agylity',
          repositoryPath: dir,
          prompt: 'Update docs',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          tier: 'routine',
          pushBranch: true,
          autoCreatePr: true,
        });

        const gitInvocations: string[][] = [];
        const executor = new TaskExecutor({
          agyBinPath: 'agy',
          dirExistsFn: () => true,
          prPolicy: 'docs_only',
          execFileFn: async (file, args) => {
            if (file === 'git') {
              gitInvocations.push(args as string[]);
              if (args[0] === 'status') {
                return { stdout: ' M docs/guide.md\n', stderr: '' };
              }
              if (args[0] === 'diff' && args.includes('--name-only')) {
                return { stdout: 'docs/guide.md\n', stderr: '' };
              }
            }
            if (file === 'gh' && args[0] === 'pr') {
              return { stdout: 'https://github.com/OtterBoops/agylity/pull/42\n', stderr: '' };
            }
            return { stdout: 'done', stderr: '' };
          },
        });

        const res = await executor.execute(task);
        assert.equal(res.success, true);
        assert.equal(res.noChanges, undefined);
        assert.equal(res.prUrl, 'https://github.com/OtterBoops/agylity/pull/42');
        assert.ok(gitInvocations.some((args) => args.includes('push') && !args.includes('stash')));
      } finally {
        db.close();
        cleanup();
      }
    });

    it('suppresses all PRs and pushes when prPolicy=none', async () => {
      const { dir, cleanup } = makeTempDir('orch_bot_policy_none_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const queue = new TaskQueue(db);
        const task = queue.enqueue({
          repositoryName: 'agylity',
          repositoryPath: dir,
          prompt: 'Audit only',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          tier: 'routine',
          pushBranch: true,
          autoCreatePr: true,
        });

        const gitInvocations: string[][] = [];
        const executor = new TaskExecutor({
          agyBinPath: 'agy',
          dirExistsFn: () => true,
          prPolicy: 'none',
          execFileFn: async (file, args) => {
            if (file === 'git') {
              gitInvocations.push(args as string[]);
              if (args[0] === 'status') {
                return { stdout: ' M README.md\n', stderr: '' };
              }
            }
            return { stdout: 'done', stderr: '' };
          },
        });

        const res = await executor.execute(task);
        assert.equal(res.success, true);
        assert.equal(res.noChanges, true);
        assert.ok(
          res.output.includes("[Policy Guard] Autonomous PR suppressed: PR policy is 'none'")
        );
        assert.ok(!gitInvocations.some((args) => args.includes('push') && !args.includes('stash')));
      } finally {
        db.close();
        cleanup();
      }
    });

    it('injects issues-only instruction and suppresses PRs/pushes when prPolicy=issues_only', async () => {
      const { dir, cleanup } = makeTempDir('orch_bot_policy_issues_only_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const queue = new TaskQueue(db);
        const task = queue.enqueue({
          repositoryName: 'agylity',
          repositoryPath: dir,
          prompt: 'Find bugs',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          tier: 'routine',
          pushBranch: true,
          autoCreatePr: true,
          prPolicy: 'issues_only',
        });

        const gitInvocations: string[][] = [];
        let capturedPrompt = '';
        const executor = new TaskExecutor({
          agyBinPath: 'agy',
          dirExistsFn: () => true,
          execFileFn: async (file, args) => {
            if (file === 'agy') {
              const pIdx = (args as string[]).indexOf('-p');
              if (pIdx >= 0) capturedPrompt = String(args[pIdx + 1] ?? '');
            }
            if (file === 'git') {
              gitInvocations.push(args as string[]);
              if (args[0] === 'status') {
                return { stdout: ' M src/index.ts\n', stderr: '' };
              }
            }
            return { stdout: 'done', stderr: '' };
          },
        });

        const res = await executor.execute(task);
        assert.equal(res.success, true);
        assert.equal(res.noChanges, true);
        assert.ok(capturedPrompt.includes('[Policy: Issues Only'));
        assert.ok(
          res.output.includes("[Policy Guard] Autonomous PR suppressed: PR policy is 'issues_only'")
        );
        assert.ok(!gitInvocations.some((args) => args.includes('push') && !args.includes('stash')));
        assert.ok(gitInvocations.some((args) => args[0] === 'branch' && args[1] === '-D'));
      } finally {
        db.close();
        cleanup();
      }
    });

    it('supports per-routine prPolicy override and clearing back to inherit global', () => {
      const { dir, cleanup } = makeTempDir('orch_routine_policy_override_');
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        const queue = new TaskQueue(db);

        const routine = queue.createRoutineTask({
          title: 'Hydrogen Triage & Fix',
          prompt: 'Fix issues',
          repositoryId: 'agylity',
          cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
          prPolicy: 'all',
        });
        assert.equal(routine.prPolicy, 'all');

        const inherited = queue.updateRoutineTask(routine.id, { prPolicy: null });
        assert.equal(inherited?.prPolicy, undefined);

        const restored = queue.updateRoutineTask(routine.id, { prPolicy: 'none' });
        assert.equal(restored?.prPolicy, 'none');
      } finally {
        db.close();
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 13. Retry Origin Sync, Blank-Patch Fallback & Early-Reset Recovery   */
  /* ==================================================================== */
  describe('13. Retry Origin Sync, Blank-Patch Fallback & Early-Reset Recovery', () => {
    const freshFlashPools = (
      resetTime = new Date(Date.now() + 6 * 3600 * 1000).toISOString()
    ): QuotaSnapshot[] => [
      {
        poolId: 'gemini-flash',
        family: 'gemini-flash',
        displayName: 'Gemini Flash',
        remainingFraction: 0.8,
        resetTime,
        hoursUntilReset: 6,
        models: ['gemini-4-hydrogen'],
      },
    ];

    const retryConfig = (dir: string) => ({
      coordinatorEnabled: true,
      defaultDispatchModel: 'gemini-4-hydrogen',
      repositories: [
        {
          id: 'agylity',
          name: 'Agylity',
          path: dir,
          cloneUrl: 'https://example.invalid/example.git',
          defaultBranch: 'main',
        },
      ],
    });

    it('retries a failed backlog-tier task and repoints the backlog row at the retried swarm task', async () => {
      const { dir, cleanup } = makeTempDir('coord_retry_backlog_');
      const store = new ConfigStore(path.join(dir, 'test.db'), retryConfig(dir));

      try {
        const coordinator = new Coordinator({ configStore: store });
        coordinator.onQuotaUpdated(freshFlashPools());

        const backlog = coordinator.queue.createBacklogTask({
          title: 'Repoint the backlog origin',
          prompt: 'A retry must carry the origin row to the new task',
          repositoryId: 'agylity',
          cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
        });

        const first = await coordinator.dispatch({
          repositoryId: 'agylity',
          prompt: backlog.prompt,
          title: backlog.title,
          tier: 'backlog',
          originId: backlog.id,
          originNumber: backlog.taskNumber,
          originTitle: backlog.title,
          requestedBy: `backlog:${backlog.id}`,
          scheduleMode: 'immediate',
          cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
        });
        assert.equal(first.success, true);
        assert.ok(first.taskId, 'the first attempt must enqueue a swarm task');

        // The attempt failed: the origin row goes back to pending with the failure recorded.
        await coordinator.reportTaskStatus(first.taskId!, {
          status: 'failed',
          error: 'runner crashed',
        });
        const pendingRow = coordinator.queue.getBacklogTask(backlog.id);
        assert.equal(pendingRow?.status, 'pending');
        assert.equal(pendingRow?.lastError, 'runner crashed');

        const finished = coordinator.queue.getTask(first.taskId!);
        assert.equal(finished?.status, 'failed');

        const retry = await coordinator.retryTask(finished!);
        assert.equal(retry.success, true);
        assert.ok(retry.taskId);
        assert.notEqual(retry.taskId, first.taskId);

        const row = coordinator.queue.getBacklogTask(backlog.id);
        assert.equal(row?.status, 'dispatched');
        assert.equal(row?.swarmTaskId, retry.taskId);
        assert.equal(row?.lastError, undefined);

        const retriedTask = coordinator.queue.getTask(retry.taskId!);
        assert.equal(retriedTask?.tier, 'backlog');
        assert.equal(retriedTask?.originId, backlog.id);
        // The finished run is left exactly as it ended.
        assert.equal(coordinator.queue.getTask(first.taskId!)?.status, 'failed');
      } finally {
        store.close();
        cleanup();
      }
    });

    it('retries a finished routine-tier task and repoints lastTaskId at the retried task', async () => {
      const { dir, cleanup } = makeTempDir('coord_retry_routine_');
      const store = new ConfigStore(path.join(dir, 'test.db'), retryConfig(dir));

      try {
        const coordinator = new Coordinator({ configStore: store });
        coordinator.onQuotaUpdated(freshFlashPools());

        const routine = coordinator.queue.createRoutineTask({
          title: 'Nightly retention sweep',
          prompt: 'A retry must repoint the routine at the new task',
          repositoryId: 'agylity',
          cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
          triggerBeforeResetHours: 12,
        });

        const first = await coordinator.dispatch({
          repositoryId: 'agylity',
          prompt: routine.prompt,
          title: routine.title,
          tier: 'routine',
          originId: routine.id,
          originNumber: routine.taskNumber,
          originTitle: routine.title,
          requestedBy: `routine:${routine.id}`,
          scheduleMode: 'immediate',
          cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
        });
        assert.equal(first.success, true);
        assert.ok(first.taskId, 'the first run must enqueue a swarm task');

        await coordinator.reportTaskStatus(first.taskId!, { status: 'completed' });

        const resetTime = '2026-11-09T01:30:44Z';
        coordinator.queue.updateRoutineTask(routine.id, {
          lastTaskId: first.taskId!,
          lastTriggeredResetTime: resetTime,
        });

        const retry = await coordinator.retryTask(coordinator.queue.getTask(first.taskId!)!);
        assert.equal(retry.success, true);
        assert.ok(retry.taskId);
        assert.notEqual(retry.taskId, first.taskId);

        const row = coordinator.queue.getRoutineTask(routine.id);
        assert.equal(row?.lastTaskId, retry.taskId);
        // A retry is a new run in the same cycle, not a new cycle.
        assert.equal(row?.lastTriggeredResetTime, resetTime);

        const retriedTask = coordinator.queue.getTask(retry.taskId!);
        assert.equal(retriedTask?.tier, 'routine');
        assert.equal(retriedTask?.originId, routine.id);
      } finally {
        store.close();
        cleanup();
      }
    });

    it('forgets the announced burn kick for a replenished pool without touching other pools', () => {
      const { dir, cleanup } = makeTempDir('coord_early_reset_kick_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const configStore = new ConfigStore(db, { coordinatorEnabled: true });
        const coordinator = new Coordinator({ configStore });

        const previousResetTime = '2026-11-08T01:30:44Z';
        const resetTime = '2026-11-09T01:30:44Z';
        coordinator.queue.setRuntimeValue(
          'burnKickAnnouncedCycles',
          JSON.stringify({ claude: previousResetTime, 'gemini-flash': resetTime })
        );

        coordinator.onEarlyQuotaReset([
          {
            poolId: 'claude',
            displayName: 'Claude and GPT models',
            previousRemainingFraction: 0.15,
            remainingFraction: 0.95,
            previousResetTime,
            resetTime,
          },
        ]);

        const cycles = JSON.parse(
          coordinator.queue.getRuntimeValue('burnKickAnnouncedCycles') ?? '{}'
        ) as Record<string, string>;
        assert.equal(Object.hasOwn(cycles, 'claude'), false);
        // Only the pool that actually replenished reopens its announcement window.
        assert.equal(cycles['gemini-flash'], resetTime);
      } finally {
        db.close();
        cleanup();
      }
    });

    it('resets lastTriggeredResetTime only on routines stamped for the replenished cycle', () => {
      const { dir, cleanup } = makeTempDir('coord_early_reset_routine_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const configStore = new ConfigStore(db, {
          coordinatorEnabled: true,
          defaultDispatchModel: 'gemini-4-hydrogen',
        });
        const coordinator = new Coordinator({ configStore });

        const previousResetTime = '2026-11-08T01:30:44Z';
        const resetTime = '2026-11-09T01:30:44Z';
        const staleCycle = '2026-11-07T01:30:44Z';

        const stamped = coordinator.queue.createRoutineTask({
          title: 'Claude pre-reset burn',
          prompt: 'Burn the cycle that just reset early',
          repositoryId: 'agylity',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          triggerBeforeResetHours: 12,
        });
        coordinator.queue.updateRoutineTask(stamped.id, {
          lastTriggeredResetTime: previousResetTime,
        });

        const nextCycle = coordinator.queue.createRoutineTask({
          title: 'Claude later cycle',
          prompt: 'Stamped for a different cycle',
          repositoryId: 'agylity',
          cascade: [{ model: 'claude-sonnet-5-5', effort: 'high' }],
          triggerBeforeResetHours: 12,
        });
        coordinator.queue.updateRoutineTask(nextCycle.id, { lastTriggeredResetTime: staleCycle });

        coordinator.onEarlyQuotaReset([
          {
            poolId: 'claude',
            displayName: 'Claude and GPT models',
            previousRemainingFraction: 0.15,
            remainingFraction: 0.95,
            previousResetTime,
            resetTime,
          },
        ]);

        assert.equal(
          coordinator.queue.getRoutineTask(stamped.id)?.lastTriggeredResetTime,
          undefined
        );
        assert.equal(
          coordinator.queue.getRoutineTask(nextCycle.id)?.lastTriggeredResetTime,
          staleCycle
        );
      } finally {
        db.close();
        cleanup();
      }
    });

    it('keeps the stored routine and backlog text when a patch supplies only blank fields', () => {
      const { dir, cleanup } = makeTempDir('coord_blank_patch_fallback_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);

        const routine = queue.createRoutineTask({
          title: 'Routine title',
          prompt: 'Routine prompt',
          repositoryId: 'agylity',
          cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
        });
        const patchedRoutine = queue.updateRoutineTask(routine.id, {
          title: '   ',
          prompt: '',
          repositoryId: '  ',
        });
        assert.equal(patchedRoutine?.title, 'Routine title');
        assert.equal(patchedRoutine?.prompt, 'Routine prompt');
        assert.equal(patchedRoutine?.repositoryId, 'agylity');
        // A real value still overwrites, trimmed.
        assert.equal(
          queue.updateRoutineTask(routine.id, { title: ' Renamed routine ' })?.title,
          'Renamed routine'
        );

        const backlog = queue.createBacklogTask({
          title: 'Backlog title',
          prompt: 'Backlog prompt',
          repositoryId: 'agylity',
        });
        const patchedBacklog = queue.updateBacklogTask(backlog.id, {
          title: '',
          prompt: ' \t ',
          repositoryId: ' ',
        });
        assert.equal(patchedBacklog?.title, 'Backlog title');
        assert.equal(patchedBacklog?.prompt, 'Backlog prompt');
        assert.equal(patchedBacklog?.repositoryId, 'agylity');
        assert.equal(
          queue.updateBacklogTask(backlog.id, { prompt: ' Rewritten prompt ' })?.prompt,
          'Rewritten prompt'
        );
      } finally {
        db.close();
        cleanup();
      }
    });
  });
});
