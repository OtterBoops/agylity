import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { makeTempDir } from '../e2e/harness/index.js';
import { createLogger } from '../../src/logs/logger.js';
import { AppDatabase } from '../../src/storage/db.js';
import { TaskQueue, type SwarmTask } from '../../src/coordinator/queue.js';
import {
  buildPullRequestBody,
  hasCoAuthorTrailer,
  isUnownedIdentity,
  parseBranchCommitLog,
  stripCoAuthorTrailers,
} from '../../src/runner/executor.js';
import { defaultExecFileAsync } from '../../src/sentry/discovery.js';
import { parseRunnerCliArgs } from '../../src/runner-cli.js';
import {
  RemoteSwarmRunner,
  STATUS_BODY_MAX_BYTES,
  TaskExecutor,
  buildContinuationBranchName,
  fitStatusPayload,
  isCapacityExhaustedOutput,
  isDocumentationFile,
  normalizePrPolicy,
  parseAgyTelemetry,
  redactGitSecrets,
  sumAgyTelemetry,
  type SpawnFn,
} from '../../src/runner/index.js';
import { GITHUB_ISSUE_TITLE_PREFIX } from '../../src/runner/policy.js';

const TELEMETRY_LINE = '{"num_turns":4,"usage":{"total_tokens":1234,"thinking_tokens":321}}';

describe('Unit Tests: Runner telemetry preservation (Workstream 2)', () => {
  describe('1. Zero-diff TaskExecutor result', () => {
    it('reports telemetry on the noChanges path instead of dropping the cost of the run', async () => {
      const { dir, cleanup } = makeTempDir('runner_nochanges_');
      const db = new AppDatabase(path.join(dir, 'test.db'));

      try {
        const queue = new TaskQueue(db);
        const task = queue.enqueue({
          repositoryName: 'agylity',
          repositoryPath: dir,
          prompt: 'Answer a question without touching files',
          cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
        });

        const executor = new TaskExecutor({
          agyBinPath: 'agy',
          dirExistsFn: () => true,
          execFileFn: async (file, args) => {
            // A clean tree with no commits ahead of base is the zero-diff branch.
            if (file === 'git' && args[0] === 'status') return { stdout: '', stderr: '' };
            if (file === 'git' && args[0] === 'rev-list') return { stdout: '0\n', stderr: '' };
            if (file === 'agy') return { stdout: `${TELEMETRY_LINE}\n`, stderr: '' };
            return { stdout: '', stderr: '' };
          },
        });

        const result = await executor.execute(task);

        assert.equal(result.success, true);
        assert.equal(result.noChanges, true);
        // A discarded branch is reported as null so the coordinator clears the column.
        assert.equal(result.branchName, null);
        assert.deepEqual(
          {
            numTurns: result.numTurns,
            totalTokens: result.totalTokens,
            thinkingTokens: result.thinkingTokens,
          },
          { numTurns: 4, totalTokens: 1234, thinkingTokens: 321 }
        );
      } finally {
        db.close();
        cleanup();
      }
    });

    it('fails the run and keeps the branch when the commit itself fails', async () => {
      const { dir, cleanup } = makeTempDir('runner_commit_fail_');
      const { task, db } = enqueueTask(dir);
      const gitCalls: string[][] = [];

      try {
        const { spawnFn } = recordSpawn((call) => finishChild(call.child, 0, 'work done\n'));

        const executor = new TaskExecutor({
          agyBinPath: 'agy',
          dirExistsFn: () => true,
          spawnFn,
          killProcessTreeFn: async () => {},
          execFileFn: async (file, args) => {
            if (file !== 'git') return { stdout: '', stderr: '' };
            gitCalls.push([...args]);
            if (args[0] === 'status') return { stdout: ' M src/app.ts', stderr: '' };
            if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--quiet') {
              throw Object.assign(new Error('staged changes'), { code: 1 });
            }
            if (args[0] === 'commit') {
              const err: any = new Error('git commit failed');
              err.stderr = 'fatal: pre-commit hook declined';
              throw err;
            }
            if (args[0] === 'rev-list') return { stdout: '0\n', stderr: '' };
            return { stdout: '', stderr: '' };
          },
        });

        const result = await executor.execute(task);

        assert.equal(result.success, false);
        assert.equal(result.noChanges, undefined);
        assert.match(result.error ?? '', /pre-commit hook declined/);
        assert.ok(result.branchName, 'the branch holding the uncommitted work must be kept');
        assert.equal(
          gitCalls.some((args) => args[0] === 'branch' && args.includes('-D')),
          false,
          'a failed commit must not discard the branch'
        );
      } finally {
        db.close();
        cleanup();
      }
    });
  });

  describe('2. parseAgyTelemetry', () => {
    it('reads NDJSON telemetry lines and accepts the turns alias', () => {
      const telemetry = parseAgyTelemetry(
        ['Working...', '{"turns":3}', '{"usage":{"input_tokens":10,"output_tokens":5}}'].join('\n')
      );

      assert.equal(telemetry.numTurns, 3);
      assert.equal(telemetry.inputTokens, 10);
      assert.equal(telemetry.outputTokens, 5);
      // total_tokens is never reported, so the sum of the two sides stands in for it.
      assert.equal(telemetry.totalTokens, 15);
    });

    it('ignores non-JSON noise and returns nothing for empty output', () => {
      assert.deepEqual(parseAgyTelemetry(''), {});
      assert.deepEqual(parseAgyTelemetry('plain text\n{not json}\n'), {});

      const telemetry = parseAgyTelemetry('noise\n{"conversation_id":"conv-7"}\ntrailing');
      assert.equal(telemetry.conversationId, 'conv-7');
      assert.equal(telemetry.numTurns, undefined);
    });

    it('keeps a counter undefined when no attempt reported it', () => {
      const summed = sumAgyTelemetry([{ numTurns: 2 }, { totalTokens: 10 }]);
      assert.equal(summed.numTurns, 2);
      assert.equal(summed.totalTokens, 10);
      assert.equal(summed.thinkingTokens, undefined);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Fake spawn plumbing: a controllable child process with no real handle.     */
/* -------------------------------------------------------------------------- */

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => boolean;
}

interface SpawnCall {
  file: string;
  args: readonly string[];
  child: FakeChild;
}

const createFakeChild = (pid: number): FakeChild => {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
};

// Emits output and closes on the next macrotask, after the runner attached its listeners.
const finishChild = (child: FakeChild, code: number, stdout = '', stderr = ''): void => {
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', stdout);
    if (stderr) child.stderr.emit('data', stderr);
    child.emit('close', code, null);
  });
};

interface SpawnRecorder {
  spawnFn: SpawnFn;
  calls: SpawnCall[];
}

const recordSpawn = (onSpawn?: (call: SpawnCall, index: number) => void): SpawnRecorder => {
  const calls: SpawnCall[] = [];
  const spawnFn: SpawnFn = (file, args) => {
    const child = createFakeChild(9000 + calls.length);
    const call: SpawnCall = { file, args: [...args], child };
    calls.push(call);
    onSpawn?.(call, calls.length - 1);
    return child as unknown as ChildProcess;
  };
  return { spawnFn, calls };
};

// `agy` argv carries the prompt directly after `-p` and the model after `--model`.
const promptOf = (call: SpawnCall | undefined): string => String(call?.args[1] ?? '');
const modelOf = (call: SpawnCall | undefined): string => {
  const args = call?.args ?? [];
  const index = args.indexOf('--model');
  return index === -1 ? '' : String(args[index + 1] ?? '');
};

interface GitFakeState {
  status: () => string;
  revList?: () => string;
  diffStat?: string;
}

const createGitExecFile = (state: GitFakeState, calls: string[][] = []) => {
  return async (file: string, args: readonly string[]) => {
    if (file !== 'git') return { stdout: '', stderr: '' };
    calls.push([...args]);
    const cmd = args[0];
    if (cmd === 'status') return { stdout: state.status(), stderr: '' };
    if (cmd === 'rev-list') return { stdout: state.revList?.() ?? '0\n', stderr: '' };
    if (cmd === 'diff' && args[1] === '--stat') return { stdout: state.diffStat ?? '', stderr: '' };
    return { stdout: '', stderr: '' };
  };
};

const enqueueTask = (
  dir: string,
  input: Record<string, unknown> = {}
): { task: SwarmTask; db: AppDatabase } => {
  const db = new AppDatabase(path.join(dir, 'test.db'));
  const queue = new TaskQueue(db);
  const task = queue.enqueue({
    repositoryName: 'agylity',
    repositoryPath: dir,
    prompt: 'Implement the queue worker',
    cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
    ...input,
  });
  return { task, db };
};

describe('Runner: process-group subprocess control', () => {
  it('kills the child process tree and fails the run without committing when aborted', async () => {
    const { dir, cleanup } = makeTempDir('runner_abort_');
    const { task, db } = enqueueTask(dir);

    try {
      const gitCalls: string[][] = [];
      const killedPids: number[] = [];
      const { spawnFn, calls } = recordSpawn();

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async (pid) => {
          killedPids.push(pid);
        },
        execFileFn: createGitExecFile({ status: () => '' }, gitCalls),
      });

      const controller = new AbortController();
      const run = executor.execute(task, { signal: controller.signal });

      await new Promise((resolve) => setTimeout(resolve, 25));
      controller.abort();
      const result = await run;

      assert.equal(result.success, false);
      assert.match(String(result.error), /abort/i);
      assert.equal(killedPids.length > 0, true);
      assert.equal(killedPids[0], calls[0]?.child.pid);
      assert.equal(
        gitCalls.some((args) => args[0] === 'commit' || args[0] === 'push'),
        false
      );
    } finally {
      db.close();
      cleanup();
    }
  });

  it('caps the streamed onOutput tail at 16 KB and keeps the newest bytes', async () => {
    const { dir, cleanup } = makeTempDir('runner_tail_');
    const { task, db } = enqueueTask(dir);

    try {
      const payload = `${'a'.repeat(20000)}${'b'.repeat(20000)}NEWEST_BYTES`;
      const { spawnFn } = recordSpawn((call) => {
        finishChild(call.child, 0, payload);
      });

      const tails: string[] = [];
      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: createGitExecFile({ status: () => '' }),
      });

      const result = await executor.execute(task, {
        onOutput: (tail) => {
          tails.push(tail);
        },
      });

      assert.equal(result.success, true);
      assert.equal(tails.length > 0, true);
      assert.equal(
        tails.every((tail) => tail.length <= 16384),
        true
      );
      assert.equal(tails.at(-1)?.endsWith('NEWEST_BYTES'), true);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('rejects a hung command by killing its tree instead of leaking it', async () => {
    const { dir, cleanup } = makeTempDir('runner_timeout_');
    const { task, db } = enqueueTask(dir);

    try {
      const killedPids: number[] = [];
      // Never closes: only the timeout can end this run.
      const { spawnFn } = recordSpawn();

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        timeoutMs: 40,
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async (pid) => {
          killedPids.push(pid);
        },
        execFileFn: createGitExecFile({ status: () => '' }),
      });

      const result = await executor.execute(task);

      assert.equal(result.success, false);
      assert.match(String(result.error), /timed out/i);
      assert.equal(killedPids.length, 1);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('rejects a nonzero exit as a failed run', async () => {
    const { dir, cleanup } = makeTempDir('runner_exit_');
    const { task, db } = enqueueTask(dir);

    try {
      const { spawnFn } = recordSpawn((call) => {
        finishChild(call.child, 3, 'partial work', 'boom: agent crashed');
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: createGitExecFile({ status: () => '' }),
      });

      const result = await executor.execute(task);

      assert.equal(result.success, false);
      assert.match(String(result.error), /boom: agent crashed/);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('does not kill the tree of a child that already exited cleanly', async () => {
    const { dir, cleanup } = makeTempDir('runner_clean_exit_');
    const { task, db } = enqueueTask(dir);

    try {
      const killedPids: number[] = [];
      const { spawnFn } = recordSpawn((call) => {
        finishChild(call.child, 0, 'done\n');
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async (pid) => {
          killedPids.push(pid);
        },
        execFileFn: createGitExecFile({ status: () => '', revList: () => '0\n' }),
      });

      const result = await executor.execute(task);

      assert.equal(result.success, true);
      assert.deepEqual(killedPids, [], 'a finished child owns no live tree to kill');
    } finally {
      db.close();
      cleanup();
    }
  });

  it('redacts a credential that surfaces on the failure path before it is logged or returned', async () => {
    const { dir, cleanup } = makeTempDir('runner_failure_redact_');
    const { task, db } = enqueueTask(dir);
    const previousToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_failurepathsecret123';

    try {
      const { spawnFn } = recordSpawn((call) => {
        finishChild(
          call.child,
          1,
          '',
          'fatal: https://x-access-token:ghp_failurepathsecret123@github.com/OtterBoops/agylity.git'
        );
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: createGitExecFile({ status: () => '' }),
      });

      const result = await executor.execute(task);

      assert.equal(result.success, false);
      assert.equal(String(result.error).includes('ghp_failurepathsecret123'), false);
      assert.equal(String(result.output).includes('ghp_failurepathsecret123'), false);
      assert.equal(String(result.error).includes('[redacted]'), true);
    } finally {
      if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousToken;
      db.close();
      cleanup();
    }
  });
});

describe('Runner: capacity-exhaustion detection', () => {
  it('matches upstream quota refusals', () => {
    for (const text of [
      'MODEL_CAPACITY_EXHAUSTED: gemini-4-argon is out of budget',
      'rpc error: code = RESOURCE_EXHAUSTED',
      'HTTP 429 Too Many Requests',
      'status: 429',
      'server overloaded, try again later',
      'capacity exhausted for this pool',
    ]) {
      assert.equal(isCapacityExhaustedOutput(text), true, `expected a match for: ${text}`);
    }
  });

  it('ignores ordinary failures and digit-adjacent counters', () => {
    for (const text of [
      undefined,
      '',
      'fatal: not a git repository',
      'TypeError: cannot read properties of undefined',
      'wrote 1429 bytes',
      'exit code 4291',
      'compilation failed with 3 errors',
    ]) {
      assert.equal(isCapacityExhaustedOutput(text), false, `expected no match for: ${text}`);
    }
  });
});

describe('Runner: effortless models', () => {
  it('omits --effort for a model that advertises no effort variants', async () => {
    const { dir, cleanup } = makeTempDir('runner_effortless_');
    const { task, db } = enqueueTask(dir, {
      cascade: [{ model: 'gemini-pro-orchestrator-argon', effort: 'high' }],
    });

    try {
      const { spawnFn, calls } = recordSpawn((call) => {
        finishChild(call.child, 0, 'done\n');
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: createGitExecFile({ status: () => '', revList: () => '0\n' }),
      });

      const result = await executor.execute(task);

      assert.equal(result.success, true);
      assert.equal(modelOf(calls[0]), 'gemini-pro-orchestrator-argon');
      assert.equal(calls[0]?.args.includes('--effort'), false);
      // The footer must not claim a reasoning level the model never ran at.
      assert.equal(promptOf(calls[0]).includes('(high reasoning)'), false);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('still passes --effort for a model that advertises variants', async () => {
    const { dir, cleanup } = makeTempDir('runner_effort_');
    const { task, db } = enqueueTask(dir, {
      cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
    });

    try {
      const { spawnFn, calls } = recordSpawn((call) => {
        finishChild(call.child, 0, 'done\n');
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: createGitExecFile({ status: () => '', revList: () => '0\n' }),
      });

      const result = await executor.execute(task);

      assert.equal(result.success, true);
      const args = calls[0]?.args ?? [];
      const effortIndex = args.indexOf('--effort');
      assert.equal(effortIndex === -1 ? '' : args[effortIndex + 1], 'high');
      assert.ok(promptOf(calls[0]).includes('(high reasoning)'));
    } finally {
      db.close();
      cleanup();
    }
  });
});

describe('Runner: capacity fallback with continuation context', () => {
  it('re-runs a clean tree with the next candidate model and the original prompt', async () => {
    const { dir, cleanup } = makeTempDir('runner_fallback_clean_');
    const { task, db } = enqueueTask(dir, {
      cascade: [
        { model: 'gemini-4-argon', effort: 'high' },
        { model: 'gemini-4-hydrogen', effort: 'medium' },
      ],
    });

    try {
      const { spawnFn, calls } = recordSpawn((call, index) => {
        if (index === 0) {
          finishChild(call.child, 1, 'MODEL_CAPACITY_EXHAUSTED\n');
          return;
        }
        finishChild(call.child, 0, 'done\n');
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: createGitExecFile({ status: () => '', revList: () => '0\n' }),
      });

      const result = await executor.execute(task);

      assert.equal(result.success, true);
      assert.equal(calls.length, 2);
      assert.equal(modelOf(calls[0]), 'gemini-4-argon');
      assert.equal(modelOf(calls[1]), 'gemini-4-hydrogen');
      // Clean tree: a fresh attempt on the original prompt, not a handoff.
      assert.ok(promptOf(calls[1]).includes(task.prompt));
      assert.equal(promptOf(calls[1]).includes('[CONTINUATION CONTEXT]'), false);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('hands dirty partial work over with git status, diff stat and a 2000-char tail', async () => {
    const { dir, cleanup } = makeTempDir('runner_fallback_dirty_');
    const { task, db } = enqueueTask(dir, {
      cascade: [
        { model: 'gemini-4-argon', effort: 'high' },
        { model: 'gemini-4-hydrogen', effort: 'medium' },
      ],
    });

    try {
      let statusCalls = 0;
      const gitCalls: string[][] = [];
      const firstOutput = `START_MARKER${'x'.repeat(2500)}MODEL_CAPACITY_EXHAUSTED TAIL_MARKER_END`;

      const { spawnFn, calls } = recordSpawn((call, index) => {
        if (index === 0) {
          finishChild(call.child, 1, firstOutput);
          return;
        }
        finishChild(call.child, 0, 'done\n');
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: createGitExecFile(
          {
            // Clean at checkout time, dirty once the aborted attempt left work behind.
            status: () => {
              statusCalls += 1;
              return statusCalls === 1 ? '' : ' M src/a.ts\n';
            },
            revList: () => '0\n',
            diffStat: ' src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n',
          },
          gitCalls
        ),
      });

      const result = await executor.execute(task);
      const prompt = promptOf(calls[1]);

      assert.equal(result.success, true);
      assert.equal(calls.length, 2);
      assert.equal(modelOf(calls[1]), 'gemini-4-hydrogen');
      assert.ok(prompt.startsWith('[CONTINUATION CONTEXT]'));
      assert.ok(prompt.includes('A previous attempt with model gemini-4-argon'));
      assert.ok(prompt.includes('Current git status:'));
      assert.ok(prompt.includes(' M src/a.ts'));
      assert.ok(prompt.includes('Diff summary:'));
      assert.ok(prompt.includes('src/a.ts | 2 +-'));
      assert.ok(prompt.includes('TAIL_MARKER_END'));
      // Only the last 2000 characters of the interrupted output travel with the handoff.
      assert.equal(prompt.includes('START_MARKER'), false);
      assert.ok(prompt.includes(task.prompt));
      // Partial work is a handoff: nothing is stashed or reset to get a clean tree back.
      assert.equal(
        gitCalls.some((args) => args[0] === 'stash' || args[0] === 'reset'),
        false
      );
    } finally {
      db.close();
      cleanup();
    }
  });

  it('does not fail over when only the attempt’s own transcript mentions a capacity signal', async () => {
    const { dir, cleanup } = makeTempDir('runner_transcript_capacity_');
    const { task, db } = enqueueTask(dir, {
      cascade: [
        { model: 'gemini-4-argon', effort: 'high' },
        { model: 'gemini-4-hydrogen', effort: 'medium' },
      ],
    });

    try {
      const { spawnFn, calls } = recordSpawn((call, index) => {
        if (index === 0) {
          finishChild(
            call.child,
            1,
            [
              JSON.stringify({ event: 'init', conversation_id: 'c1' }),
              JSON.stringify({
                event: 'step_update',
                step_update: {
                  step_index: 1,
                  state: 'DONE',
                  step_type: 'agent_response',
                  text_delta: 'The tool returned 429 too many requests, so I retried it',
                },
              }),
            ].join('\n')
          );
          return;
        }
        finishChild(call.child, 0, 'done\n');
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: createGitExecFile({ status: () => '', revList: () => '0\n' }),
      });

      const result = await executor.execute(task);

      assert.equal(calls.length, 1);
      assert.equal(result.success, false);
      assert.ok(String(result.output).includes('429'), String(result.output));
    } finally {
      db.close();
      cleanup();
    }
  });

  it('still fails over when the CLI result event itself reports capacity exhaustion', async () => {
    const { dir, cleanup } = makeTempDir('runner_result_status_capacity_');
    const { task, db } = enqueueTask(dir, {
      cascade: [
        { model: 'gemini-4-argon', effort: 'high' },
        { model: 'gemini-4-hydrogen', effort: 'medium' },
      ],
    });

    try {
      const { spawnFn, calls } = recordSpawn((call, index) => {
        if (index === 0) {
          finishChild(
            call.child,
            1,
            [
              JSON.stringify({ event: 'init', conversation_id: 'c1' }),
              JSON.stringify({ event: 'result', result: { status: 'CAPACITY_EXHAUSTED' } }),
            ].join('\n')
          );
          return;
        }
        finishChild(call.child, 0, 'done\n');
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: createGitExecFile({ status: () => '', revList: () => '0\n' }),
      });

      const result = await executor.execute(task);

      assert.equal(result.success, true);
      assert.equal(calls.length, 2);
      assert.equal(modelOf(calls[1]), 'gemini-4-hydrogen');
    } finally {
      db.close();
      cleanup();
    }
  });

  it('sums telemetry across every attempt that ran', async () => {
    const { dir, cleanup } = makeTempDir('runner_fallback_telemetry_');
    const { task, db } = enqueueTask(dir, {
      cascade: [
        { model: 'gemini-4-argon', effort: 'high' },
        { model: 'gemini-4-hydrogen', effort: 'medium' },
      ],
    });

    try {
      const { spawnFn } = recordSpawn((call, index) => {
        if (index === 0) {
          finishChild(
            call.child,
            1,
            `${TELEMETRY_LINE}\nMODEL_CAPACITY_EXHAUSTED\n`,
            'MODEL_CAPACITY_EXHAUSTED'
          );
          return;
        }
        finishChild(call.child, 0, '{"num_turns":2,"usage":{"total_tokens":100}}\n');
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: createGitExecFile({ status: () => '', revList: () => '0\n' }),
      });

      const result = await executor.execute(task);

      assert.equal(result.success, true);
      assert.equal(result.numTurns, 6);
      assert.equal(result.totalTokens, 1334);
      assert.equal(result.thinkingTokens, 321);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('stops at the first non-capacity error without burning the remaining candidates', async () => {
    const { dir, cleanup } = makeTempDir('runner_fallback_stop_');
    const { task, db } = enqueueTask(dir, {
      cascade: [
        { model: 'gemini-4-argon', effort: 'high' },
        { model: 'gemini-4-hydrogen', effort: 'medium' },
      ],
    });

    try {
      const { spawnFn, calls } = recordSpawn((call) => {
        finishChild(call.child, 1, '', 'fatal: agent crashed on a malformed prompt');
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: createGitExecFile({ status: () => '' }),
      });

      const result = await executor.execute(task);

      assert.equal(result.success, false);
      assert.equal(calls.length, 1);
    } finally {
      db.close();
      cleanup();
    }
  });
});

describe('Runner: local bare mirror and reference clone', () => {
  const CLONE_URL = 'https://github.com/OtterBoops/agylity.git';

  it('clones through a bare mirror and then a reference clone', async () => {
    const { dir, cleanup } = makeTempDir('runner_mirror_');
    const mirrorRoot = path.join(dir, 'mirrors');
    const repoPath = path.join(dir, 'work', 'agylity');
    const { task, db } = enqueueTask(dir, { repositoryPath: repoPath, cloneUrl: CLONE_URL });

    try {
      const cloneCalls: string[][] = [];
      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => false,
        mirrorCacheDir: mirrorRoot,
        spawnFn: recordSpawn((call) => finishChild(call.child, 0)).spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: async (file, args) => {
          if (file === 'git' && args.includes('clone')) {
            cloneCalls.push([...args]);
            const dest = String(args.at(-1));
            if (args.includes('--bare')) {
              mkdirSync(dest, { recursive: true });
              writeFileSync(path.join(dest, 'HEAD'), 'ref: refs/heads/main\n');
            }
          }
          if (file === 'git' && args[0] === 'status') return { stdout: '', stderr: '' };
          if (file === 'git' && args[0] === 'rev-list') return { stdout: '0\n', stderr: '' };
          return { stdout: '', stderr: '' };
        },
      });

      const first = await executor.execute(task);
      assert.equal(first.success, true);
      assert.equal(cloneCalls[0]?.includes('--bare'), true, 'first clone seeds the bare mirror');
      assert.equal(cloneCalls[1]?.includes('--reference-if-able'), true);
      assert.equal(cloneCalls[1]?.includes('--dissociate'), true);
      assert.equal(cloneCalls[1]?.at(-2), CLONE_URL);

      // Second run reuses the mirror: fetch instead of a fresh bare clone.
      cloneCalls.length = 0;
      const second = await executor.execute(task);
      assert.equal(second.success, true);
      assert.equal(
        cloneCalls.filter((args) => args.includes('--bare')).length,
        0,
        'an existing mirror is fetched, not re-cloned'
      );
      assert.equal(cloneCalls[0]?.includes('--reference-if-able'), true);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('falls back to a plain clone when the mirror step throws', async () => {
    const { dir, cleanup } = makeTempDir('runner_mirror_fallback_');
    const repoPath = path.join(dir, 'work', 'agylity');
    const { task, db } = enqueueTask(dir, { repositoryPath: repoPath, cloneUrl: CLONE_URL });

    try {
      const cloneCalls: string[][] = [];
      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => false,
        mirrorCacheDir: path.join(dir, 'mirrors'),
        spawnFn: recordSpawn((call) => finishChild(call.child, 0)).spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: async (file, args) => {
          if (file === 'git' && args.includes('--bare')) {
            cloneCalls.push([...args]);
            throw new Error('fatal: mirror is unreachable');
          }
          if (file === 'git' && args.includes('clone')) {
            cloneCalls.push([...args]);
          }
          if (file === 'git' && args[0] === 'status') return { stdout: '', stderr: '' };
          if (file === 'git' && args[0] === 'rev-list') return { stdout: '0\n', stderr: '' };
          return { stdout: '', stderr: '' };
        },
      });

      const result = await executor.execute(task);

      assert.equal(result.success, true);
      assert.equal(cloneCalls.length, 2);
      assert.equal(cloneCalls[0]?.includes('--bare'), true);
      assert.equal(cloneCalls[1]?.includes('--reference-if-able'), false);
      assert.equal(cloneCalls[1]?.at(-2), CLONE_URL);
      assert.equal(cloneCalls[1]?.at(-1), repoPath);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('carries the leased git credentials into the mirror fetch so a private remote stays fresh', async () => {
    const { dir, cleanup } = makeTempDir('runner_mirror_auth_');
    const mirrorRoot = path.join(dir, 'mirrors');
    const mirrorPath = path.join(
      mirrorRoot,
      `${createHash('sha256').update(CLONE_URL).digest('hex')}.git`
    );
    mkdirSync(mirrorPath, { recursive: true });
    writeFileSync(path.join(mirrorPath, 'HEAD'), 'ref: refs/heads/main\n');

    const repoPath = path.join(dir, 'work', 'agylity');
    const { task, db } = enqueueTask(dir, { repositoryPath: repoPath, cloneUrl: CLONE_URL });
    const leasedToken = 'ghp_leased_mirror_token_123456';

    try {
      const fetchCalls: string[][] = [];
      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => false,
        mirrorCacheDir: mirrorRoot,
        spawnFn: recordSpawn((call) => finishChild(call.child, 0)).spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: async (file, args) => {
          if (file === 'git' && args.includes('fetch')) fetchCalls.push([...args]);
          if (file === 'git' && args[0] === 'status') return { stdout: '', stderr: '' };
          if (file === 'git' && args[0] === 'rev-list') return { stdout: '0\n', stderr: '' };
          return { stdout: '', stderr: '' };
        },
      });

      const result = await executor.execute(task, { githubToken: leasedToken });

      assert.equal(result.success, true);
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0]?.includes('--prune'), true);
      assert.equal(
        fetchCalls[0]?.some((arg) => arg.includes('AUTHORIZATION: basic ')),
        true,
        'the mirror fetch ran without the credentials the clone uses'
      );
      const expectedBasic = Buffer.from(`x-access-token:${leasedToken}`, 'utf8').toString('base64');
      assert.equal(
        fetchCalls[0]?.some((arg) => arg.includes(expectedBasic)),
        true,
        'the mirror fetch must carry the leased token, not a runner-local one'
      );
    } finally {
      db.close();
      cleanup();
    }
  });

  it('never builds a mirror when useMirrorCache is false', async () => {
    const { dir, cleanup } = makeTempDir('runner_mirror_off_');
    const repoPath = path.join(dir, 'work', 'agylity');
    const { task, db } = enqueueTask(dir, { repositoryPath: repoPath, cloneUrl: CLONE_URL });

    try {
      const cloneCalls: string[][] = [];
      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => false,
        useMirrorCache: false,
        spawnFn: recordSpawn((call) => finishChild(call.child, 0)).spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: async (file, args) => {
          if (file === 'git' && args.includes('clone')) cloneCalls.push([...args]);
          if (file === 'git' && args[0] === 'status') return { stdout: '', stderr: '' };
          if (file === 'git' && args[0] === 'rev-list') return { stdout: '0\n', stderr: '' };
          return { stdout: '', stderr: '' };
        },
      });

      const result = await executor.execute(task);

      assert.equal(result.success, true);
      assert.equal(cloneCalls.length, 1);
      assert.equal(cloneCalls[0]?.includes('--bare'), false);
      assert.equal(cloneCalls[0]?.includes('--reference-if-able'), false);
    } finally {
      db.close();
      cleanup();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Status report payload budget                                                */
/* -------------------------------------------------------------------------- */

const bodyBytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

const terminalPayload = (output: string, error?: string): Record<string, unknown> => ({
  status: 'completed',
  runnerId: 'runner-1',
  branchName: 'agy/abc123-implement-the-worker',
  output,
  error,
  durationMs: 1234,
  numTurns: 4,
});

describe('Runner: status report payload budget', () => {
  it('leaves a payload that already fits byte-for-byte alone', () => {
    const payload = terminalPayload('short output');
    assert.equal(fitStatusPayload(payload), payload);
  });

  it('keeps the head and the tail of an oversized output inside the body limit', () => {
    const output = `HEAD_MARKER\n${'x'.repeat(200 * 1024)}\nTAIL_MARKER`;
    const fitted = fitStatusPayload(terminalPayload(output));

    assert.ok(bodyBytesOf(fitted) <= STATUS_BODY_MAX_BYTES, `body is ${bodyBytesOf(fitted)} bytes`);
    assert.equal(fitted.status, 'completed');
    assert.equal(fitted.numTurns, 4);
    assert.equal(fitted.branchName, 'agy/abc123-implement-the-worker');

    const reported = String(fitted.output);
    assert.ok(reported.includes('HEAD_MARKER'));
    assert.ok(reported.includes('TAIL_MARKER'));
    assert.ok(reported.includes('truncated by the runner'));
    assert.ok(reported.length < output.length);
  });

  it('falls back to the error field when the output alone cannot make the body fit', () => {
    const fitted = fitStatusPayload(
      terminalPayload('o'.repeat(120 * 1024), `ERR_HEAD${'e'.repeat(120 * 1024)}ERR_TAIL`)
    );

    assert.ok(bodyBytesOf(fitted) <= STATUS_BODY_MAX_BYTES, `body is ${bodyBytesOf(fitted)} bytes`);
    assert.equal(fitted.status, 'completed');
    const reported = String(fitted.error);
    assert.ok(reported.includes('ERR_HEAD'));
    assert.ok(reported.includes('ERR_TAIL'));
  });

  it('fits a body whose bulk sits outside output and error', () => {
    const base = terminalPayload('ok');
    const shapes: Array<Record<string, unknown>> = [
      { ...base, title: 't'.repeat(200 * 1024) },
      { ...base, branchName: 'b'.repeat(200 * 1024) },
      {
        ...base,
        issueUrls: Array.from(
          { length: 5000 },
          (_, i) => `https://github.com/o/r/issues/${i}${'z'.repeat(40)}`
        ),
      },
    ];

    for (const payload of shapes) {
      const fitted = fitStatusPayload(payload);
      assert.ok(
        bodyBytesOf(fitted) <= STATUS_BODY_MAX_BYTES,
        `body is ${bodyBytesOf(fitted)} bytes for ${Object.keys(payload).join(',')}`
      );
      assert.equal(fitted.status, 'completed');
    }
  });

  it('never overshoots the budget for multibyte output', () => {
    const fitted = fitStatusPayload(terminalPayload('漢'.repeat(60 * 1024)));

    assert.ok(bodyBytesOf(fitted) <= STATUS_BODY_MAX_BYTES, `body is ${bodyBytesOf(fitted)} bytes`);
    assert.equal(typeof fitted.output, 'string');
    assert.ok(String(fitted.output).length > 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

describe('Runner: git credential redaction', () => {
  it('strips both the token and its basic-auth encoding from captured output', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = token;
    try {
      const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
      const redacted = redactGitSecrets(
        `fatal: https://x-access-token:${token}@github.com/o/r.git\nextraheader=${basic}`
      );

      assert.equal(redacted.includes(token), false);
      assert.equal(redacted.includes(basic), false);
      assert.ok(redacted.includes('[redacted]'));
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });

  it('leaves output untouched when no usable token is configured', () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'short';
    try {
      assert.equal(redactGitSecrets('fatal: short circuit'), 'fatal: short circuit');
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });
});

describe('Runner: leased token redaction', () => {
  it('keeps the leased token out of the run output, the heartbeat tail and the routine PR body', async () => {
    const { dir, cleanup } = makeTempDir('runner_token_redaction_');
    const token = 'ghp_leased_redaction_4f7c19ab';
    const { task, db } = enqueueTask(dir, {
      tier: 'routine',
      prompt: 'Summarise the open issues',
    });
    const agentText = `Exported GITHUB_TOKEN=${token} while checking the environment.`;
    const ndjson = [
      { event: 'init', conversation_id: 'c1' },
      {
        event: 'step_update',
        step_update: {
          step_index: 1,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: agentText,
        },
      },
      { event: 'result', result: { status: 'SUCCESS', response: agentText, num_turns: 1 } },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
    const tails: string[] = [];
    const exec = createWorkspaceExecFile({
      status: () => ' M src/a.ts\n',
      revList: () => '1\n',
      onGh: () => 'https://github.com/OtterBoops/agylity/pull/9\n',
    });
    const { spawnFn } = recordSpawn((call) => finishChild(call.child, 0, `${ndjson}\n`));
    const executor = new TaskExecutor({
      agyBinPath: 'agy',
      dirExistsFn: () => true,
      spawnFn,
      killProcessTreeFn: async () => {},
      resolveGithubIdentityFn: async () => ({ name: 'Runner', email: 'runner@example.com' }),
      execFileFn: exec.execFileFn,
    });

    try {
      const result = await executor.execute(task, {
        githubToken: token,
        onOutput: (tail) => tails.push(tail),
      });

      assert.equal(result.success, true, result.error ?? 'the run must succeed');
      assert.equal(result.output.includes(token), false, result.output);
      assert.ok(result.output.includes('[redacted]'), result.output);

      assert.ok(tails.length > 0, 'the run emitted no heartbeat tail');
      for (const tail of tails) assert.equal(tail.includes(token), false, tail);

      const prCall = exec.calls.find(
        (entry) => entry[0] === 'gh' && entry[1] === 'pr' && entry[2] === 'create'
      );
      assert.ok(prCall, 'expected a gh pr create invocation');
      const body = String(prCall![prCall!.indexOf('--body') + 1] ?? '');
      assert.equal(body.includes(token), false, body);
      assert.ok(body.includes('[redacted]'), body);
    } finally {
      db.close();
      cleanup();
    }
  });
});

describe('Runner: pr policy and documentation classification', () => {
  it('accepts every schema policy regardless of case or padding, and refuses anything else', () => {
    for (const policy of ['none', 'docs_only', 'issues_only', 'all'] as const) {
      assert.equal(normalizePrPolicy(`  ${policy.toUpperCase()}  `), policy);
    }
    for (const raw of [undefined, '', '   ', 'docs-only', 'alll', 'true']) {
      assert.equal(normalizePrPolicy(raw), undefined, `expected no policy for: ${raw}`);
    }
  });

  it('classifies documentation files by extension, bare licence names and docs assets', () => {
    for (const file of [
      'README.md',
      'readme',
      'LICENSE',
      'docs/guide.md',
      'Docs/diagram.png',
      '.github/CONTRIBUTING.md',
      'notes.txt',
      'docs/images/flow.svg',
    ]) {
      assert.equal(isDocumentationFile(file), true, `expected documentation: ${file}`);
    }
    for (const file of [
      'src/runner/executor.ts',
      'src/README.ts',
      'docs/schema.sql',
      'package.json',
      'scripts/build.sh',
    ]) {
      assert.equal(isDocumentationFile(file), false, `expected code: ${file}`);
    }
  });

  it('classifies a C-quoted non-ASCII path the way git reports it when path quoting is on', () => {
    for (const file of ['"docs/caf\\303\\251.md"', '"docs/caf\\303\\251.png"', '"docs/guide.md"']) {
      assert.equal(isDocumentationFile(file), true, `expected documentation: ${file}`);
    }
    for (const file of ['"src/caf\\303\\251.ts"', '"package.json"']) {
      assert.equal(isDocumentationFile(file), false, `expected code: ${file}`);
    }
  });

  it('builds descriptive branch names that can never collide with the base branches', () => {
    const branch = buildContinuationBranchName(
      'task-1794914459794-50a10f',
      'Refactor the runner process supervision layer for clarity and add regression tests'
    );
    assert.ok(branch.startsWith('agy/50a10f-'));
    assert.ok(branch.length <= 'agy/'.length + 8 + 1 + 32);
    assert.equal(branch.includes('main'), false);

    assert.equal(buildContinuationBranchName('task-1-abc', ''), 'agy/abc-work');
  });

  it('emits a git-valid ref for every title shape it can be handed', () => {
    const invalid = (ref: string): boolean =>
      ref === '' ||
      /\s/.test(ref) ||
      /[~^:?*\[\]\\]/.test(ref) ||
      ref.includes('..') ||
      ref.includes('//') ||
      ref.includes('@{') ||
      ref.startsWith('-') ||
      ref.endsWith('/') ||
      ref.endsWith('.') ||
      ref.endsWith('.lock') ||
      /[\x00-\x1f\x7f]/.test(ref);

    const titles = [
      '',
      '   ',
      '[GH #12]',
      'main',
      'master',
      'HEAD',
      '..dots..',
      '@{upstream}',
      'fix: a/b',
      'a'.repeat(200),
      'emoji 🚀 only',
      'multi\nline',
      '-leading dash',
    ];

    for (const title of titles) {
      const branch = buildContinuationBranchName('task-1795693744039-6524c4', title);
      assert.equal(
        invalid(branch),
        false,
        `${JSON.stringify(title)} -> ${branch} is not a valid ref`
      );
      assert.ok(branch.startsWith('agy/'), `${JSON.stringify(title)} -> ${branch}`);
      assert.notEqual(branch, 'main');
      assert.notEqual(branch, 'master');
    }
  });

  it('slugs the resolved title and strips a GitHub issue label prefix first', () => {
    assert.equal(
      buildContinuationBranchName('task-1700000000000-abc12345', '[GH #12] Fix the parser'),
      'agy/abc12345-fix-the-parser'
    );
    // A resolved plain title needs no prefix handling and still slugs from its own words, not from
    // the raw prompt the caller no longer passes.
    assert.equal(
      buildContinuationBranchName('task-1700000000000-abc12345', 'Fix the parser'),
      'agy/abc12345-fix-the-parser'
    );
    // The prefix also has to survive stray padding and lowercase spelling from the label sync.
    assert.equal(
      buildContinuationBranchName('task-1700000000000-abc12345', '  [gh #7]   Fix the parser'),
      'agy/abc12345-fix-the-parser'
    );

    // The rule lives in one place so the issue sync and the slugger cannot drift apart.
    assert.equal(GITHUB_ISSUE_TITLE_PREFIX.test('[GH #12] Fix the parser'), true);
    assert.equal(GITHUB_ISSUE_TITLE_PREFIX.test('Fix the parser'), false);
    assert.equal(
      '[GH #12] Fix the parser'.replace(GITHUB_ISSUE_TITLE_PREFIX, ''),
      'Fix the parser'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* A workspace command fake covering clone, commit, push and gh                */
/* -------------------------------------------------------------------------- */

interface WorkspaceFakeOptions {
  status?: () => string;
  revList?: () => string;
  diffStat?: string;
  diffNameOnly?: () => string;
  onClone?: () => void;
  onPush?: () => void;
  onLog?: () => string;
  onGh?: (args: readonly string[]) => string;
}

const createWorkspaceExecFile = (options: WorkspaceFakeOptions = {}) => {
  const calls: string[][] = [];
  const execFileFn = async (file: string, args: readonly string[]) => {
    calls.push([file, ...args]);
    if (file === 'gh') return { stdout: options.onGh?.(args) ?? '', stderr: '' };
    if (file !== 'git') return { stdout: '', stderr: '' };

    const cmd = args[0];
    if (cmd === 'clone') {
      options.onClone?.();
      return { stdout: '', stderr: '' };
    }
    if (cmd === 'push') {
      options.onPush?.();
      return { stdout: '', stderr: '' };
    }
    if (cmd === 'status') return { stdout: options.status?.() ?? '', stderr: '' };
    if (cmd === 'rev-list') return { stdout: options.revList?.() ?? '0\n', stderr: '' };
    if (cmd === 'log') return { stdout: options.onLog?.() ?? '', stderr: '' };
    if (cmd === 'diff' && args[1] === '--stat')
      return { stdout: options.diffStat ?? '', stderr: '' };
    if (cmd === 'diff' && args[1] === '--cached' && args[2] === '--quiet') {
      if ((options.status?.() ?? '').trim() !== '') {
        throw Object.assign(new Error('staged changes'), { code: 1 });
      }
      return { stdout: '', stderr: '' };
    }
    if (cmd === 'diff' && args[1] === '--name-only') {
      return { stdout: options.diffNameOnly?.() ?? '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const has = (needle: string): boolean => calls.some((call) => call.includes(needle));
  // `git stash push` also carries "push", so a real publish needs both the subcommand and the remote.
  const pushed = (): boolean =>
    calls.some((call) => call[0] === 'git' && call.includes('push') && call.includes('origin'));
  return { execFileFn, calls, has, pushed };
};

const quietLogger = createLogger({ minLevel: 'error' });

/* -------------------------------------------------------------------------- */
/* Process control edge cases                                                  */
/* -------------------------------------------------------------------------- */

describe('Runner: process control edge cases', () => {
  it('treats a zero timeout as no timeout instead of killing the child on the next tick', async () => {
    const { dir, cleanup } = makeTempDir('runner_no_timeout_');
    const { task, db } = enqueueTask(dir);

    try {
      const { spawnFn } = recordSpawn((call) => {
        setTimeout(() => finishChild(call.child, 0, 'completed\n'), 25);
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        timeoutMs: 0,
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: createWorkspaceExecFile({ status: () => '' }).execFileFn,
      });

      const result = await executor.execute(task);

      assert.equal(result.success, true);
      assert.equal(result.error, undefined);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('never spawns the agent when the abort signal already fired', async () => {
    const { dir, cleanup } = makeTempDir('runner_pre_abort_');
    const { task, db } = enqueueTask(dir);

    try {
      const { spawnFn, calls } = recordSpawn((call) => finishChild(call.child, 0, 'too late\n'));
      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: createWorkspaceExecFile({ status: () => '' }).execFileFn,
      });

      const controller = new AbortController();
      controller.abort();
      const result = await executor.execute(task, { signal: controller.signal });

      assert.equal(result.success, false);
      assert.match(String(result.error), /abort/i);
      assert.equal(calls.length, 0);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('removes a half-written clone so the next attempt clones again', async () => {
    const { dir, cleanup } = makeTempDir('runner_clone_cleanup_');
    const repoPath = path.join(dir, 'work', 'agylity');
    const { task, db } = enqueueTask(dir, {
      repositoryPath: repoPath,
      cloneUrl: 'https://github.com/OtterBoops/agylity.git',
    });

    try {
      const exec = createWorkspaceExecFile({
        onClone: () => {
          throw new Error('fatal: repository not found');
        },
      });
      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        useMirrorCache: false,
        dirExistsFn: () => false,
        spawnFn: recordSpawn().spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: exec.execFileFn,
      });

      const first = await executor.execute(task);
      assert.equal(first.success, false);
      assert.match(String(first.error), /repository not found/);
      assert.equal(existsSync(repoPath), false);

      const second = await executor.execute(task);
      assert.equal(second.success, false);
      assert.equal(exec.calls.filter((call) => call[1] === 'clone').length, 2);
    } finally {
      db.close();
      cleanup();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Verification command guard                                                  */
/* -------------------------------------------------------------------------- */

describe('Runner: commit identity precedence', () => {
  interface IdentityRun {
    leaseIdentity?: { name: string; email: string };
    envIdentity?: { name: string; email: string };
    agentIdentity?: { name: string; email: string };
  }

  const pushedAuthor = async (run: IdentityRun): Promise<string> => {
    const { dir, cleanup } = makeTempDir('runner_identity_');
    const work = path.join(dir, 'work');
    const remote = path.join(dir, 'remote.git');
    const saved = {
      name: process.env.GIT_AUTHOR_NAME,
      email: process.env.GIT_AUTHOR_EMAIL,
      committerName: process.env.GIT_COMMITTER_NAME,
      committerEmail: process.env.GIT_COMMITTER_EMAIL,
    };
    const git = async (cwd: string, args: string[], env?: Record<string, string>) =>
      (
        await defaultExecFileAsync('git', args, {
          cwd,
          timeout: 30000,
          env: { ...process.env, ...env },
        })
      ).stdout;

    const db = new AppDatabase(path.join(dir, 'test.db'));
    try {
      await git(dir, ['init', '-q', '-b', 'main', work]);
      await git(dir, ['init', '-q', '--bare', remote]);
      await git(work, ['remote', 'add', 'origin', remote.split(path.sep).join('/')]);
      writeFileSync(path.join(work, 'README.md'), 'base\n');
      await git(work, ['add', '-A']);
      await git(work, ['commit', '-q', '-m', 'chore: base'], {
        GIT_AUTHOR_NAME: 'Human',
        GIT_AUTHOR_EMAIL: 'human@example.com',
        GIT_COMMITTER_NAME: 'Human',
        GIT_COMMITTER_EMAIL: 'human@example.com',
      });

      for (const key of [
        'GIT_AUTHOR_NAME',
        'GIT_AUTHOR_EMAIL',
        'GIT_COMMITTER_NAME',
        'GIT_COMMITTER_EMAIL',
      ]) {
        delete process.env[key];
      }
      if (run.envIdentity) {
        Object.assign(process.env, {
          GIT_AUTHOR_NAME: run.envIdentity.name,
          GIT_AUTHOR_EMAIL: run.envIdentity.email,
          GIT_COMMITTER_NAME: run.envIdentity.name,
          GIT_COMMITTER_EMAIL: run.envIdentity.email,
        });
      }

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        prPolicy: 'all',
        resolveGithubIdentityFn: async () => ({
          name: 'Inferred',
          email: '7777+Inferred@users.noreply.github.com',
        }),
        execFileFn: async (file, args, opts) => {
          if (file === 'agy') {
            writeFileSync(path.join(work, 'a.txt'), 'a\n');
            await git(work, ['add', '-A']);
            await git(
              work,
              run.agentIdentity
                ? ['commit', '-q', '-m', 'feat: add a']
                : ['commit', '-q', '-m', 'feat: add a'],
              run.agentIdentity
                ? {
                    GIT_AUTHOR_NAME: run.agentIdentity.name,
                    GIT_AUTHOR_EMAIL: run.agentIdentity.email,
                    GIT_COMMITTER_NAME: run.agentIdentity.name,
                    GIT_COMMITTER_EMAIL: run.agentIdentity.email,
                  }
                : undefined
            );
            return { stdout: 'Done.', stderr: '' };
          }
          if (file === 'gh') throw new Error('no pull request for this task');
          return defaultExecFileAsync(file, args, opts);
        },
      });

      const task = new TaskQueue(db).enqueue({
        repositoryName: 'agylity',
        repositoryPath: work,
        prompt: 'Add a',
        cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
        prPolicy: 'all',
        pushBranch: true,
        autoCreatePr: false,
      });

      const result = await executor.execute(task, {
        githubToken: 'ghp_test_token_123',
        ...(run.leaseIdentity ? { gitIdentity: run.leaseIdentity } : {}),
      });
      assert.equal(result.success, true, result.error ?? 'the run must succeed');
      return (await git(remote, ['log', '-1', '--format=%ae', result.branchName ?? ''])).trim();
    } finally {
      db.close();
      for (const [key, value] of [
        ['GIT_AUTHOR_NAME', saved.name],
        ['GIT_AUTHOR_EMAIL', saved.email],
        ['GIT_COMMITTER_NAME', saved.committerName],
        ['GIT_COMMITTER_EMAIL', saved.committerEmail],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      cleanup();
    }
  };

  it('lets the configured identity outrank the environment and the token', async () => {
    const author = await pushedAuthor({
      leaseIdentity: { name: 'OtterBoops', email: '12345+OtterBoops@users.noreply.github.com' },
      envIdentity: { name: 'Ilya Solovyov', email: 'ilya@example.com' },
    });
    assert.equal(author, '12345+OtterBoops@users.noreply.github.com');
  });

  it('falls back to the environment before the identity inferred from the token', async () => {
    const author = await pushedAuthor({
      envIdentity: { name: 'Build Bot', email: 'build@example.com' },
    });
    assert.equal(author, 'build@example.com');
  });

  it('rewrites a commit by an identity the resolved one does not own', async () => {
    const author = await pushedAuthor({
      leaseIdentity: { name: 'OtterBoops', email: '12345+OtterBoops@users.noreply.github.com' },
      agentIdentity: { name: 'Ilya Solovyov', email: 'ilya@example.com' },
    });
    assert.equal(
      author,
      '12345+OtterBoops@users.noreply.github.com',
      'a stranger on the branch must not reach the remote'
    );
  });
});

describe('Runner: verification artifacts', () => {
  it('commits the agent work but not what the verification run writes', async () => {
    const { dir, cleanup } = makeTempDir('runner_verify_artifacts_');
    const work = path.join(dir, 'work');
    const git = async (cwd: string, args: string[], env?: Record<string, string>) =>
      (
        await defaultExecFileAsync('git', args, {
          cwd,
          timeout: 30000,
          env: { ...process.env, ...env },
        })
      ).stdout;

    const db = new AppDatabase(path.join(dir, 'test.db'));
    try {
      await git(dir, ['init', '-q', '-b', 'main', work]);
      writeFileSync(path.join(work, 'README.md'), 'base\n');
      await git(work, ['add', '-A']);
      await git(work, ['commit', '-q', '-m', 'chore: base'], {
        GIT_AUTHOR_NAME: 'Human',
        GIT_AUTHOR_EMAIL: 'human@example.com',
        GIT_COMMITTER_NAME: 'Human',
        GIT_COMMITTER_EMAIL: 'human@example.com',
      });

      const { spawnFn } = recordSpawn((call) => {
        if (call.file === 'agy') {
          writeFileSync(path.join(work, 'notes.md'), '# docs\n');
          finishChild(call.child, 0, 'Done.\n');
          return;
        }
        mkdirSync(path.join(work, 'coverage'), { recursive: true });
        writeFileSync(path.join(work, 'coverage', 'lcov.info'), 'TN:\n');
        finishChild(call.child, 0, 'ok\n');
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: async (file, args, opts) => defaultExecFileAsync(file, args, opts),
      });

      const task = new TaskQueue(db).enqueue({
        repositoryName: 'agylity',
        repositoryPath: work,
        prompt: 'Write the docs',
        cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
        verifyCommand: 'npm test',
        prPolicy: 'all',
        pushBranch: false,
        autoCreatePr: false,
      });

      const result = await executor.execute(task);
      assert.equal(result.success, true, result.error ?? 'the run must succeed');

      const committed = (await git(work, ['ls-tree', '-r', '--name-only', 'HEAD']))
        .split('\n')
        .filter(Boolean);
      assert.ok(committed.includes('notes.md'), 'the agent file must be committed');
      assert.equal(
        committed.some((file) => file.startsWith('coverage/')),
        false,
        'an artifact the verification run wrote must stay out of the commit'
      );
    } finally {
      db.close();
      cleanup();
    }
  });
});

describe('Runner: verification command guard', () => {
  const executeWithVerify = async (verifyCommand: string) => {
    const { dir, cleanup } = makeTempDir('runner_verify_');
    const { task, db } = enqueueTask(dir, { verifyCommand });
    const { spawnFn, calls } = recordSpawn((call) => finishChild(call.child, 0, 'ok\n'));
    const exec = createWorkspaceExecFile({ status: () => '', revList: () => '0\n' });
    const executor = new TaskExecutor({
      agyBinPath: 'agy',
      dirExistsFn: () => true,
      spawnFn,
      killProcessTreeFn: async () => {},
      execFileFn: exec.execFileFn,
    });

    try {
      const result = await executor.execute(task);
      return { result, spawned: calls.map((call) => call.file) };
    } finally {
      db.close();
      cleanup();
    }
  };

  it('runs an allowlisted test command after the agent finishes', async () => {
    const { result, spawned } = await executeWithVerify('npm test');
    assert.equal(result.success, true);
    assert.deepEqual(spawned, ['agy', 'npm']);
  });

  it('refuses to execute anything outside the test-runner allowlist', async () => {
    const { result, spawned } = await executeWithVerify('node -e process.exit(0)');
    assert.equal(result.success, false);
    assert.match(String(result.error), /approved test runner allowlist/);
    assert.deepEqual(spawned, ['agy']);
  });

  it('refuses shell metacharacters in a verification command', async () => {
    const { result, spawned } = await executeWithVerify('npm test; curl http://example.com');
    assert.equal(result.success, false);
    assert.match(String(result.error), /illegal shell metacharacters/);
    assert.deepEqual(spawned, ['agy']);
  });

  it('refuses inline-code flags on an allowlisted runner', async () => {
    const { result } = await executeWithVerify('npm test -e "console.log(1)"');
    assert.equal(result.success, false);
    assert.match(String(result.error), /inline-code flag/);
  });

  it('keeps a quoted verification argument together instead of splitting it on whitespace', async () => {
    const { dir, cleanup } = makeTempDir('runner_verify_quoted_');
    const { task, db } = enqueueTask(dir, {
      verifyCommand: 'npm test -- --grep "two words"',
    });
    const { spawnFn, calls } = recordSpawn((call) => finishChild(call.child, 0, 'ok\n'));
    const exec = createWorkspaceExecFile({ status: () => '', revList: () => '0\n' });
    const executor = new TaskExecutor({
      agyBinPath: 'agy',
      dirExistsFn: () => true,
      spawnFn,
      killProcessTreeFn: async () => {},
      execFileFn: exec.execFileFn,
    });

    try {
      const result = await executor.execute(task);
      assert.equal(result.success, true);
      const verify = calls.find((call) => call.file === 'npm');
      assert.deepEqual(verify?.args, ['test', '--', '--grep', 'two words']);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('refuses a verification command whose quote is never closed', async () => {
    const { result, spawned } = await executeWithVerify('npm test "two words');
    assert.equal(result.success, false);
    assert.match(String(result.error), /unterminated/);
    assert.deepEqual(spawned, ['agy']);
  });

  it('fails the run when the verification command itself fails', async () => {
    const { dir, cleanup } = makeTempDir('runner_verify_fail_');
    const { task, db } = enqueueTask(dir, { verifyCommand: 'npm test' });
    const { spawnFn } = recordSpawn((call, index) => {
      if (index === 0) finishChild(call.child, 0, 'agent done\n');
      else finishChild(call.child, 1, '', '3 tests failed');
    });
    const exec = createWorkspaceExecFile({ status: () => '', revList: () => '0\n' });
    const executor = new TaskExecutor({
      agyBinPath: 'agy',
      dirExistsFn: () => true,
      spawnFn,
      killProcessTreeFn: async () => {},
      execFileFn: exec.execFileFn,
    });

    try {
      const result = await executor.execute(task);
      assert.equal(result.success, false);
      assert.match(String(result.error), /Verification command failed \(npm test\)/);
      assert.match(String(result.error), /3 tests failed/);
      assert.equal(exec.pushed(), false);
    } finally {
      db.close();
      cleanup();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Push, pull request and autonomous PR policy                                 */
/* -------------------------------------------------------------------------- */

describe('Runner: push, pull request and policy guards', () => {
  const runWithWorkspace = async (
    input: Record<string, unknown>,
    options: WorkspaceFakeOptions = {}
  ) => {
    const { dir, cleanup } = makeTempDir('runner_workspace_');
    const { task, db } = enqueueTask(dir, input);
    const exec = createWorkspaceExecFile({
      status: () => ' M src/a.ts\n',
      revList: () => '1\n',
      ...options,
    });
    const executor = new TaskExecutor({
      agyBinPath: 'agy',
      dirExistsFn: () => true,
      spawnFn: recordSpawn((call) => finishChild(call.child, 0, 'done\n')).spawnFn,
      killProcessTreeFn: async () => {},
      execFileFn: exec.execFileFn,
    });

    try {
      const result = await executor.execute(task);
      return { result, exec };
    } finally {
      db.close();
      cleanup();
    }
  };

  // `createWorkspaceExecFile` records each call as `[file, ...args]`.
  const prCreateFrom = (exec: { calls: string[][] }) => {
    const call = exec.calls.find(
      (entry) => entry[0] === 'gh' && entry[1] === 'pr' && entry[2] === 'create'
    );
    assert.ok(call, 'expected a gh pr create invocation');
    const flag = (name: string): string | undefined => {
      const index = call!.indexOf(name);
      return index === -1 ? undefined : call![index + 1];
    };
    return { title: flag('--title'), body: flag('--body') };
  };

  it('asks agy for stream-json and renders its progress instead of raw NDJSON', async () => {
    const { dir, cleanup } = makeTempDir('runner_stream_json_');
    const { task, db } = enqueueTask(dir);
    const ndjson = [
      { event: 'init', conversation_id: 'c1', init: { model: 'gemini-4-argon' } },
      {
        event: 'step_update',
        step_update: {
          step_index: 1,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: { parameters: { CommandLine: 'npm test' } },
        },
      },
      {
        event: 'step_update',
        step_update: {
          step_index: 1,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'run_command',
          duration_seconds: 2.5,
        },
      },
      {
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: 'All green\n',
          num_turns: 1,
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
    const tails: string[] = [];
    const exec = createWorkspaceExecFile({ status: () => '', revList: () => '0\n' });
    const { spawnFn, calls } = recordSpawn((call) => finishChild(call.child, 0, ndjson));
    const executor = new TaskExecutor({
      agyBinPath: 'agy',
      dirExistsFn: () => true,
      spawnFn,
      killProcessTreeFn: async () => {},
      execFileFn: exec.execFileFn,
    });

    try {
      const result = await executor.execute(task, { onOutput: (tail) => tails.push(tail) });
      const args = calls[0]!.args;
      assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
      const tail = tails.at(-1) ?? '';
      assert.ok(tail.includes('[tool] run_command: npm test'), tail);
      assert.equal(tail.includes('"event"'), false);
      assert.equal(result.output.trim(), 'All green');
      assert.equal(result.totalTokens, 110);
      assert.equal(result.numTurns, 1);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('re-runs the attempt in text mode when agy rejects --output-format', async () => {
    const { dir, cleanup } = makeTempDir('runner_stream_fallback_');
    const { task, db } = enqueueTask(dir);
    const exec = createWorkspaceExecFile({ status: () => '', revList: () => '0\n' });
    const { spawnFn, calls } = recordSpawn((call, index) =>
      index === 0
        ? finishChild(call.child, 1, '', 'unknown flag: --output-format\n')
        : finishChild(call.child, 0, 'plain text output\n')
    );
    const executor = new TaskExecutor({
      agyBinPath: 'agy',
      dirExistsFn: () => true,
      spawnFn,
      killProcessTreeFn: async () => {},
      execFileFn: exec.execFileFn,
    });

    try {
      const result = await executor.execute(task);
      assert.equal(calls.length, 2);
      assert.equal(calls[0]!.args.includes('--output-format'), true);
      assert.equal(calls[1]!.args.includes('--output-format'), false);
      assert.equal(result.output.trim(), 'plain text output');
    } finally {
      db.close();
      cleanup();
    }
  });

  it('keeps a failed attempt instead of re-running it when its own output prints an invalid argument', async () => {
    const { dir, cleanup } = makeTempDir('runner_flag_reject_');
    const { task, db } = enqueueTask(dir);

    try {
      const { spawnFn, calls } = recordSpawn((call, index) => {
        if (index === 0) {
          finishChild(call.child, 1, 'step 3 failed: invalid argument in the tool payload\n');
          return;
        }
        finishChild(call.child, 0, 'retried\n');
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: createWorkspaceExecFile({ status: () => '', revList: () => '0\n' }).execFileFn,
      });

      const result = await executor.execute(task);

      assert.equal(calls.length, 1);
      assert.equal(result.success, false);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('does not re-run a failure whose stderr echoes the phrase inside a long transcript', async () => {
    const { dir, cleanup } = makeTempDir('runner_flag_reject_long_');
    const { task, db } = enqueueTask(dir);

    try {
      const { spawnFn, calls } = recordSpawn((call, index) => {
        if (index === 0) {
          finishChild(call.child, 1, '', `unknown flag: --output-format\n${'x'.repeat(2000)}`);
          return;
        }
        finishChild(call.child, 0, 'retried\n');
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: createWorkspaceExecFile({ status: () => '', revList: () => '0\n' }).execFileFn,
      });

      const result = await executor.execute(task);

      assert.equal(calls.length, 1);
      assert.equal(result.success, false);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('does not re-run once the stream formatter has seen a stream-json event', async () => {
    const { dir, cleanup } = makeTempDir('runner_flag_reject_stream_');
    const { task, db } = enqueueTask(dir);

    try {
      const { spawnFn, calls } = recordSpawn((call, index) => {
        if (index === 0) {
          finishChild(
            call.child,
            1,
            [
              JSON.stringify({ event: 'init', conversation_id: 'c1' }),
              JSON.stringify({ event: 'result', result: { status: 'ERROR' } }),
            ].join('\n'),
            'invalid argument: --output-format\n'
          );
          return;
        }
        finishChild(call.child, 0, 'retried\n');
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: createWorkspaceExecFile({ status: () => '', revList: () => '0\n' }).execFileFn,
      });

      const result = await executor.execute(task);

      assert.equal(calls.length, 1);
      assert.equal(result.success, false);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('decodes stdout chunks split across a multi-byte character boundary', async () => {
    const { dir, cleanup } = makeTempDir('runner_utf8_split_');
    const { task, db } = enqueueTask(dir);

    try {
      const payload = Buffer.from('done ✅ 中文 end', 'utf8');
      const { spawnFn } = recordSpawn((call) => {
        setImmediate(() => {
          call.child.stdout.emit('data', payload.subarray(0, 4));
          call.child.stdout.emit('data', payload.subarray(4, 7));
          call.child.stdout.emit('data', payload.subarray(7, 11));
          call.child.stdout.emit('data', payload.subarray(11));
          call.child.emit('close', 0, null);
        });
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: createWorkspaceExecFile({ status: () => '', revList: () => '0\n' }).execFileFn,
      });

      const result = await executor.execute(task);

      assert.equal(result.output, 'done ✅ 中文 end');
      assert.equal(result.output.includes('�'), false);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('pushes the branch and reports the pull request URL the CLI printed', async () => {
    const { result, exec } = await runWithWorkspace(
      {},
      { onGh: () => 'https://github.com/OtterBoops/agylity/pull/42\n' }
    );

    assert.equal(result.success, true);
    assert.equal(result.prUrl, 'https://github.com/OtterBoops/agylity/pull/42');
    assert.equal(exec.pushed(), true);
  });

  it('opens the pull request asking GitHub to close the issue the run came from', async () => {
    const { exec } = await runWithWorkspace(
      { tier: 'backlog', originIssueNumber: 25 },
      { onGh: () => 'https://github.com/OtterBoops/agylity/pull/77\n' }
    );

    const { body } = prCreateFrom(exec);
    assert.equal(body?.startsWith('Closes #25\n\n'), true);
  });

  it('titles the pull request with the resolved task title instead of an id-prefixed prompt slice', async () => {
    const { result, exec } = await runWithWorkspace(
      {
        title: 'Fix the flaky scheduler test',
        prompt: '## Fix the flaky scheduler test\n\nIt re-armed a cycle that had already settled.',
      },
      { onGh: () => 'https://github.com/OtterBoops/agylity/pull/11\n' }
    );

    assert.equal(result.prUrl, 'https://github.com/OtterBoops/agylity/pull/11');
    const { title } = prCreateFrom(exec);
    assert.equal(title, 'Fix the flaky scheduler test');
    assert.equal(
      title?.includes('[Agylity]'),
      false,
      `title still carries the old prefix: ${title}`
    );
    assert.equal(title?.includes('task-'), false, `title still carries the task id: ${title}`);
  });

  it('names the branch after the resolved title with the GitHub issue prefix stripped', async () => {
    const { result } = await runWithWorkspace(
      { title: '[GH #12] Fix the parser' },
      { onGh: () => '' }
    );

    assert.equal(result.success, true);
    // The executor passes the resolved title, not the prompt, so the label prefix is all that is
    // stripped and the issue number never reaches the branch name.
    assert.match(String(result.branchName), /^agy\/[0-9a-f]{6}-fix-the-parser$/);
    assert.equal(String(result.branchName).includes('12'), false);
  });

  it('appends the dispatch footer once to a prompt that does not already carry one', async () => {
    const prompt = 'Investigate the outage and file a report.';
    const { exec } = await runWithWorkspace(
      { prompt },
      { onGh: () => 'https://github.com/OtterBoops/agylity/pull/12\n' }
    );

    assert.equal(
      prCreateFrom(exec).body,
      [
        prompt,
        '',
        '---',
        '*Dispatched via Agylity (immediate) with `gemini-4-argon` (high reasoning) — please review carefully.*',
      ].join('\n')
    );
  });

  it('does not append a second dispatch footer when the prompt already ends with one', async () => {
    const prompt = [
      'Root cause: the scheduler re-armed a settled cycle.',
      '',
      '---',
      '*Dispatched via Agylity (backlog) with `gemini-4-argon` — please review carefully.*',
    ].join('\n');
    const { exec } = await runWithWorkspace(
      { prompt, tier: 'backlog' },
      { onGh: () => 'https://github.com/OtterBoops/agylity/pull/13\n' }
    );

    const body = prCreateFrom(exec).body ?? '';
    assert.equal(body, prompt);
    assert.equal(body.split('Dispatched via Agylity').length - 1, 1, `body was: ${body}`);
  });

  it('uses the resolved title as the commit subject', async () => {
    const { exec } = await runWithWorkspace({
      title: 'Fix the flaky scheduler test',
      prompt: '## Fix the flaky scheduler test\n\nIt re-armed a cycle that had already settled.',
    });

    const commit = exec.calls.find((call) => call[0] === 'git' && call[1] === 'commit');
    assert.ok(commit, 'expected a git commit');
    assert.equal(commit![commit!.indexOf('-m') + 1], 'Fix the flaky scheduler test');
  });

  it('derives the commit subject from the prompt when the task carries no title', async () => {
    const { exec } = await runWithWorkspace({
      prompt: '## Re-run the embed snapshot\n\nbody text',
    });

    const commit = exec.calls.find((call) => call[0] === 'git' && call[1] === 'commit');
    assert.ok(commit, 'expected a git commit');
    assert.equal(commit![commit!.indexOf('-m') + 1], 'Re-run the embed snapshot');
    assert.equal(
      commit!.some((arg) => arg.startsWith('Complete Antigravity continuation task')),
      false,
      `commit subject still uses the old wording: ${commit!.join(' ')}`
    );
  });

  it('keeps a successful run successful when only the pull request call fails', async () => {
    const { result, exec } = await runWithWorkspace(
      {},
      {
        onGh: () => {
          throw new Error('gh: not authenticated');
        },
      }
    );

    assert.equal(result.success, true);
    assert.equal(result.prUrl, undefined);
    assert.equal(exec.pushed(), true);
  });

  it('reports a rejected push as a failed run and names the missing lease', async () => {
    const { result } = await runWithWorkspace(
      {},
      {
        onPush: () => {
          throw new Error("fatal: could not read Username for 'https://github.com'");
        },
      }
    );

    assert.equal(result.success, false);
    assert.match(String(result.error), /Git push to origin\/agy\//);
    assert.match(String(result.error), /coordinator leased no GitHub token/);
  });

  it('never authenticates from a legacy runner GITHUB_TOKEN', async () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_legacy_runner_token_123456';
    try {
      const { result, exec } = await runWithWorkspace({}, { onGh: () => '' });

      assert.equal(result.success, true);
      const gitCalls = exec.calls.filter((call) => call[0] === 'git');
      assert.equal(
        gitCalls.some((call) => call.includes('-c')),
        false,
        'a legacy runner token must not reach git auth'
      );
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });

  it('suppresses and deletes a docs_only branch that touched code', async () => {
    const { result, exec } = await runWithWorkspace(
      { tier: 'backlog', prPolicy: 'docs_only' },
      { diffNameOnly: () => 'src/runner/executor.ts\nREADME.md\n' }
    );

    assert.equal(result.success, true);
    assert.equal(result.noChanges, true);
    assert.match(String(result.output), /docs_only/);
    assert.match(String(result.output), /src\/runner\/executor\.ts/);
    assert.equal(exec.pushed(), false);
    assert.equal(exec.has('-D'), true);
  });

  it('lets a documentation-only branch through the docs_only policy', async () => {
    const { result, exec } = await runWithWorkspace(
      { tier: 'backlog', prPolicy: 'docs_only' },
      { diffNameOnly: () => 'docs/guide.md\nREADME.md\n' }
    );

    assert.equal(result.success, true);
    assert.equal(result.noChanges, undefined);
    assert.equal(exec.pushed(), true);
  });

  it('reads the docs_only diff unquoted so a non-ASCII documentation path passes', async () => {
    const { result, exec } = await runWithWorkspace(
      { tier: 'backlog', prPolicy: 'docs_only' },
      { diffNameOnly: () => 'docs/café.md\0docs/guide.md\0' }
    );

    const diffCall = exec.calls.find((call) => call[1] === 'diff' && call[2] === '--name-only');
    assert.equal(diffCall?.includes('-z'), true);
    assert.equal(result.noChanges, undefined);
    assert.equal(exec.pushed(), true);
  });

  it('suppresses a docs_only branch when the commit diff cannot be inspected', async () => {
    const { result, exec } = await runWithWorkspace(
      { tier: 'backlog', prPolicy: 'docs_only' },
      {
        diffNameOnly: () => {
          throw new Error('fatal: bad object HEAD');
        },
      }
    );

    assert.equal(result.success, true);
    assert.equal(result.noChanges, true);
    assert.match(String(result.output), /docs_only/);
    assert.match(String(result.output), /could not be inspected/);
    assert.equal(exec.pushed(), false);
    assert.equal(exec.has('-D'), true);
  });

  it('footers the pull request with the cascade hop that actually executed', async () => {
    const { dir, cleanup } = makeTempDir('runner_pr_footer_');
    const { task, db } = enqueueTask(dir, {
      cascade: [
        { model: 'gemini-4-argon', effort: 'high' },
        { model: 'gemini-4-hydrogen', effort: 'medium' },
      ],
    });
    const { spawnFn } = recordSpawn((call, index) => {
      if (index === 0) finishChild(call.child, 1, 'MODEL_CAPACITY_EXHAUSTED\n');
      else finishChild(call.child, 0, 'done\n');
    });
    const bodies: string[] = [];
    const exec = createWorkspaceExecFile({
      status: () => ' M src/a.ts\n',
      revList: () => '1\n',
      onGh: (args) => {
        const bodyIndex = args.indexOf('--body');
        if (bodyIndex !== -1) bodies.push(String(args[bodyIndex + 1] ?? ''));
        return 'https://github.com/OtterBoops/agylity/pull/7\n';
      },
    });
    const executor = new TaskExecutor({
      agyBinPath: 'agy',
      dirExistsFn: () => true,
      spawnFn,
      killProcessTreeFn: async () => {},
      execFileFn: exec.execFileFn,
    });

    try {
      const result = await executor.execute(task);
      const footer = bodies[0]?.split('\n').at(-1) ?? '';

      assert.equal(result.prUrl, 'https://github.com/OtterBoops/agylity/pull/7');
      assert.equal(footer.includes('`gemini-4-hydrogen`'), true, `footer was: ${footer}`);
      assert.equal(footer.includes('(medium reasoning)'), true);
      assert.equal(footer.includes('`gemini-4-argon`'), false);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('suppresses an autonomous branch outright under the none policy', async () => {
    const { result, exec } = await runWithWorkspace({ tier: 'routine', prPolicy: 'none' });

    assert.equal(result.success, true);
    assert.equal(result.noChanges, true);
    assert.match(String(result.output), /PR policy is 'none'/);
    assert.equal(exec.pushed(), false);
    assert.equal(exec.has('-D'), true);
  });

  it('applies the policy to an immediate dispatch as well', async () => {
    const { result, exec } = await runWithWorkspace({ prPolicy: 'none' });

    assert.equal(result.success, true);
    assert.equal(result.noChanges, true);
    assert.match(String(result.output), /PR policy is 'none'/);
    assert.equal(exec.pushed(), false);
    assert.equal(exec.has('-D'), true);
  });

  it('gates an immediate dispatch under docs_only when it touched code', async () => {
    const { result, exec } = await runWithWorkspace(
      { prPolicy: 'docs_only' },
      { diffNameOnly: () => 'src/web/server.ts\n' }
    );

    assert.equal(result.success, true);
    assert.equal(result.noChanges, true);
    assert.equal(exec.pushed(), false);
    assert.equal(exec.has('-D'), true);
  });

  const runZeroDiffWithGh = async (onGh: (args: readonly string[]) => string) => {
    const { dir, cleanup } = makeTempDir('runner_issue_deliverable_');
    const { task, db } = enqueueTask(dir, {
      repositoryName: 'OtterBoops/agylity',
      prPolicy: 'issues_only',
    });
    const { spawnFn } = recordSpawn((call) => finishChild(call.child, 0, 'analysis done\n'));
    const exec = createWorkspaceExecFile({ status: () => '', revList: () => '0\n', onGh });
    const executor = new TaskExecutor({
      agyBinPath: 'agy',
      dirExistsFn: () => true,
      spawnFn,
      killProcessTreeFn: async () => {},
      execFileFn: exec.execFileFn,
    });

    try {
      const result = await executor.execute(task);
      return { result, exec };
    } finally {
      db.close();
      cleanup();
    }
  };

  it('reports filed GitHub issues as the deliverable of a zero-diff run', async () => {
    const duringRun = new Date(Date.now() + 60_000).toISOString();
    const { result, exec } = await runZeroDiffWithGh((args) => {
      if (args[0] !== 'issue') return '';
      return JSON.stringify([
        {
          number: 14,
          url: 'https://github.com/OtterBoops/agylity/issues/14',
          body: 'Root cause found.\n\n---\n*Dispatched via Agylity (backlog) — please review carefully.*',
          createdAt: duringRun,
        },
        {
          number: 15,
          url: 'https://github.com/OtterBoops/agylity/issues/15',
          body: 'Filed by a human while the run was in flight.',
          createdAt: duringRun,
        },
        {
          number: 9,
          url: 'https://github.com/OtterBoops/agylity/issues/9',
          body: '*Dispatched via Agylity (routine) — please review carefully.*',
          createdAt: '2020-01-01T00:00:00.000Z',
        },
      ]);
    });

    assert.equal(result.success, true);
    assert.equal(result.noChanges, undefined);
    assert.deepEqual(result.issueUrls, ['https://github.com/OtterBoops/agylity/issues/14']);
    assert.match(String(result.output), /\[Deliverable\] Filed GitHub issues/);
    assert.equal(exec.pushed(), false);
  });

  it('keeps a zero-diff run as no_changes when the window holds no Agylity issues', async () => {
    const { result } = await runZeroDiffWithGh((args) =>
      args[0] === 'issue'
        ? JSON.stringify([
            {
              number: 15,
              url: 'https://github.com/OtterBoops/agylity/issues/15',
              body: 'Filed by a human during the run.',
              createdAt: new Date(Date.now() + 60_000).toISOString(),
            },
          ])
        : ''
    );

    assert.equal(result.success, true);
    assert.equal(result.noChanges, true);
    assert.equal(result.issueUrls, undefined);
  });

  it('treats an unreadable GitHub issue listing as no deliverable rather than a failed run', async () => {
    const { result } = await runZeroDiffWithGh(() => {
      throw new Error('gh: not authenticated');
    });

    assert.equal(result.success, true);
    assert.equal(result.noChanges, true);
    assert.equal(result.issueUrls, undefined);
  });
});

/* -------------------------------------------------------------------------- */
/* Deliverable-settled titles and branch names                                 */
/* -------------------------------------------------------------------------- */

describe('Runner: deliverable-settled titles', () => {
  const runDeliverable = async (
    input: Record<string, unknown>,
    options: WorkspaceFakeOptions = {}
  ) => {
    const { dir, cleanup } = makeTempDir('runner_deliverable_');
    const { task, db } = enqueueTask(dir, input);
    const exec = createWorkspaceExecFile({
      status: () => '',
      revList: () => '1\n',
      onGh: () => 'https://github.com/OtterBoops/agylity/pull/77\n',
      ...options,
    });
    const executor = new TaskExecutor({
      agyBinPath: 'agy',
      dirExistsFn: () => true,
      spawnFn: recordSpawn((call) => finishChild(call.child, 0, 'done\n')).spawnFn,
      killProcessTreeFn: async () => {},
      execFileFn: exec.execFileFn,
    });

    try {
      return { result: await executor.execute(task), exec };
    } finally {
      db.close();
      cleanup();
    }
  };

  // `calls` entries are `[file, ...args]`.
  const branchRename = (exec: { calls: string[][] }) =>
    exec.calls.find((call) => call[0] === 'git' && call[1] === 'branch' && call[2] === '-m');
  const prTitleFrom = (exec: { calls: string[][] }): string | undefined => {
    const call = exec.calls.find(
      (entry) => entry[0] === 'gh' && entry[1] === 'pr' && entry[2] === 'create'
    );
    return call?.[call.indexOf('--title') + 1];
  };

  it('settles an untitled run on the commit the agent authored and renames the branch for it', async () => {
    const { result, exec } = await runDeliverable({}, { onLog: () => 'Add the lease reaper\n' });

    assert.equal(result.success, true);
    assert.equal(result.resolvedTitle, 'Add the lease reaper');
    assert.match(String(result.branchName), /^agy\/[0-9a-f]{6}-add-the-lease-reaper$/);

    const rename = branchRename(exec);
    assert.ok(rename, 'expected a git branch -m before publishing');
    assert.notEqual(rename![3], rename![4]);
    assert.equal(rename![4], result.branchName);

    const push = exec.calls.find(
      (call) => call[0] === 'git' && call.includes('push') && call.includes('origin')
    );
    assert.equal(push?.includes(String(result.branchName)), true);
    // The rename must land before the push, or the old name is what upstream receives.
    assert.ok(
      exec.calls.indexOf(rename!) < exec.calls.indexOf(push!),
      'branch rename happened after the push'
    );

    assert.equal(prTitleFrom(exec), 'Add the lease reaper');
  });

  it('settles a routine run from its deliverable, keeping the routine name on its origin', async () => {
    const { result, exec } = await runDeliverable(
      { tier: 'routine', title: 'Nightly sweep' },
      { onLog: () => 'Refresh the dependency lockfile\n' }
    );

    assert.equal(result.resolvedTitle, 'Refresh the dependency lockfile');
    assert.match(String(result.branchName), /-refresh-the-dependency-lockfile$/);
    assert.ok(branchRename(exec), 'a routine run still renames its branch from the deliverable');
    assert.equal(prTitleFrom(exec), 'Refresh the dependency lockfile');
  });

  it('keeps a human-typed title and never renames the branch for it', async () => {
    const { result, exec } = await runDeliverable(
      { title: 'Human picked this', tier: 'immediate' },
      { onLog: () => 'Agent wrote this instead\n' }
    );

    assert.equal(result.resolvedTitle, undefined);
    assert.equal(branchRename(exec), undefined);
    assert.match(String(result.branchName), /-human-picked-this$/);
    assert.equal(prTitleFrom(exec), 'Human picked this');
  });

  it('preserves commit subjects over 72 chars in the PR title while keeping the dashboard title clipped', async () => {
    const longSubject =
      'fix(queue): use tailWindow in capOutput to avoid splitting surrogate pairs (#20)';
    const { result, exec } = await runDeliverable(
      { tier: 'routine', title: 'Bug hunt' },
      { onLog: () => `${longSubject}\n` }
    );

    assert.ok(
      (result.resolvedTitle?.length ?? 0) <= 72,
      'dashboard resolvedTitle stays within the 72-char budget'
    );
    assert.equal(prTitleFrom(exec), longSubject);
  });

  it('settles the title from a filed issue and clears the discarded branch', async () => {
    const duringRun = new Date(Date.now() + 60_000).toISOString();
    const { result, exec } = await runDeliverable(
      { repositoryName: 'OtterBoops/agylity', prPolicy: 'issues_only' },
      {
        revList: () => '0\n',
        onGh: (args) =>
          args[0] === 'issue'
            ? JSON.stringify([
                {
                  number: 21,
                  title: 'Parser drops the trailing token',
                  url: 'https://github.com/OtterBoops/agylity/issues/21',
                  body: '*Dispatched via Agylity (backlog) — please review carefully.*',
                  createdAt: duringRun,
                },
              ])
            : '',
      }
    );

    assert.equal(result.success, true);
    assert.equal(result.resolvedTitle, 'Parser drops the trailing token');
    assert.deepEqual(result.issueUrls, ['https://github.com/OtterBoops/agylity/issues/21']);
    // A discarded branch is cleared to NULL rather than left pointing at a branch that is gone.
    assert.equal(result.branchName, null);
    assert.equal(exec.pushed(), false);
  });

  it('counts the extra issues in the settled title', async () => {
    const duringRun = new Date(Date.now() + 60_000).toISOString();
    const { result } = await runDeliverable(
      { repositoryName: 'OtterBoops/agylity', prPolicy: 'issues_only' },
      {
        revList: () => '0\n',
        onGh: (args) =>
          args[0] === 'issue'
            ? JSON.stringify([
                {
                  number: 21,
                  title: 'Parser drops the trailing token',
                  url: 'https://github.com/OtterBoops/agylity/issues/21',
                  body: '*Dispatched via Agylity (backlog) — please review carefully.*',
                  createdAt: duringRun,
                },
                {
                  number: 22,
                  title: 'Tokenizer drops the leading token',
                  url: 'https://github.com/OtterBoops/agylity/issues/22',
                  body: '*Dispatched via Agylity (backlog) — please review carefully.*',
                  createdAt: duringRun,
                },
              ])
            : '',
      }
    );

    assert.equal(result.resolvedTitle, 'Parser drops the trailing token (+1)');
    assert.equal(result.issueUrls?.length, 2);
    assert.equal(result.branchName, null);
  });

  it('clears the branch name when a policy suppresses the run', async () => {
    const { result, exec } = await runDeliverable({ prPolicy: 'none' });

    assert.equal(result.success, true);
    assert.equal(result.noChanges, true);
    assert.equal(result.branchName, null);
    assert.equal(exec.has('-D'), true);
  });
});

/* -------------------------------------------------------------------------- */
/* Policy directives are part of every prompt                                  */
/* -------------------------------------------------------------------------- */

describe('Runner: policy directives', () => {
  const promptForPolicy = async (prPolicy: string): Promise<string> => {
    const { dir, cleanup } = makeTempDir('runner_policy_prompt_');
    const { task, db } = enqueueTask(dir, { prPolicy });
    const { spawnFn, calls } = recordSpawn((call) => finishChild(call.child, 0, 'done\n'));
    const executor = new TaskExecutor({
      agyBinPath: 'agy',
      dirExistsFn: () => true,
      spawnFn,
      killProcessTreeFn: async () => {},
      execFileFn: createWorkspaceExecFile({ status: () => '', revList: () => '0\n' }).execFileFn,
    });

    try {
      await executor.execute(task);
      return promptOf(calls[0]);
    } finally {
      db.close();
      cleanup();
    }
  };

  it('asks the model to implement and commit the work under the all policy', async () => {
    const prompt = await promptForPolicy('all');

    assert.match(prompt, /\[Policy: Implement the requested changes on this branch/);
    assert.match(prompt, /commit your changes/);
    assert.doesNotMatch(prompt, /Do NOT modify repository files/);
  });

  it('restricts the working tree to documentation under docs_only', async () => {
    const prompt = await promptForPolicy('docs_only');

    assert.match(prompt, /\[Policy: Documentation only/);
    assert.match(prompt, /do NOT modify source code/);
  });

  it('forbids file edits and PRs under issues_only', async () => {
    const prompt = await promptForPolicy('issues_only');

    assert.match(prompt, /\[Policy: Issues Only/);
    assert.match(prompt, /GitHub Issues only/);
  });

  it('asks for read-only analysis under none', async () => {
    const prompt = await promptForPolicy('none');

    assert.match(prompt, /\[Policy: Read-only analysis/);
    assert.match(prompt, /do NOT modify repository files/);
  });
});

/* -------------------------------------------------------------------------- */
/* Capacity handoff keeps the policy brief                                     */
/* -------------------------------------------------------------------------- */

describe('Runner: capacity handoff prompt', () => {
  it('keeps the issues_only policy and attribution suffixes on the continuation prompt', async () => {
    const { dir, cleanup } = makeTempDir('runner_handoff_policy_');
    const { task, db } = enqueueTask(dir, {
      tier: 'backlog',
      prPolicy: 'issues_only',
      cascade: [
        { model: 'gemini-4-argon', effort: 'high' },
        { model: 'gemini-4-hydrogen', effort: 'medium' },
      ],
    });

    try {
      let statusCalls = 0;
      const { spawnFn, calls } = recordSpawn((call, index) => {
        if (index === 0) finishChild(call.child, 1, 'MODEL_CAPACITY_EXHAUSTED\n');
        else finishChild(call.child, 0, 'done\n');
      });
      const exec = createWorkspaceExecFile({
        status: () => {
          statusCalls += 1;
          return statusCalls === 1 ? '' : ' M src/a.ts\n';
        },
        revList: () => '0\n',
        diffStat: ' src/a.ts | 1 +\n',
      });
      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: exec.execFileFn,
      });

      const result = await executor.execute(task);
      const handoff = promptOf(calls[1]);

      assert.equal(result.success, true);
      assert.equal(calls.length, 2);
      assert.ok(handoff.startsWith('[CONTINUATION CONTEXT]'));
      assert.ok(handoff.includes('[Policy: Issues Only'));
      assert.ok(handoff.includes('Dispatched via Agylity'));
    } finally {
      db.close();
      cleanup();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Persisted identity precedence                                               */
/* -------------------------------------------------------------------------- */

describe('Runner: persisted identity', () => {
  const writeState = (statePath: string) =>
    writeFileSync(
      statePath,
      JSON.stringify({
        runnerId: 'persisted-id',
        runnerName: 'persisted-name',
        labels: ['persisted'],
        repositories: ['persisted-repo'],
        runnerToken: 'agyr_run_persisted',
        coordinatorUrl: 'http://127.0.0.1:8484',
        registeredAt: new Date().toISOString(),
      })
    );

  it('lets an explicit id and token outrank the state file', () => {
    const { dir, cleanup } = makeTempDir('runner_state_override_');
    const statePath = path.join(dir, 'runner.json');
    writeState(statePath);

    try {
      const runner = new RemoteSwarmRunner({
        coordinatorUrl: 'http://127.0.0.1:8484',
        runnerId: 'cli-id',
        runnerName: 'cli-name',
        runnerToken: 'agyr_run_cli',
        runnerStatePath: statePath,
        logger: quietLogger,
      });

      assert.equal(runner.getRunnerId(), 'cli-id');
      assert.equal(runner.getRunnerToken(), 'agyr_run_cli');
    } finally {
      cleanup();
    }
  });

  it('inherits the persisted identity when nothing was passed in', () => {
    const { dir, cleanup } = makeTempDir('runner_state_inherit_');
    const statePath = path.join(dir, 'runner.json');
    writeState(statePath);

    try {
      const runner = new RemoteSwarmRunner({
        coordinatorUrl: 'http://127.0.0.1:8484',
        runnerName: 'untouched-name',
        runnerStatePath: statePath,
        logger: quietLogger,
      });

      assert.equal(runner.getRunnerId(), 'persisted-id');
      assert.equal(runner.getRunnerToken(), 'agyr_run_persisted');
    } finally {
      cleanup();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Coordinator request contract                                                */
/* -------------------------------------------------------------------------- */

interface RecordedRequest {
  path: string;
  body: any;
  bytes: number;
  rejected: boolean;
}

const closeStubServer = async (server: http.Server): Promise<void> => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

// A stand-in coordinator holding the real body cap, so the runner cannot cheat with an oversized report.
const startCoordinatorStub = async (options: { task: SwarmTask | null; pollStatus?: number }) => {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const bytes = Buffer.byteLength(raw, 'utf8');
      const url = req.url ?? '';
      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (bytes > 64 * 1024) {
        requests.push({ path: url, body: null, bytes, rejected: true });
        send(413, { error: 'payload too large' });
        return;
      }

      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path: url, body, bytes, rejected: false });

      if (url === '/api/runners/register') {
        const now = new Date().toISOString();
        send(200, {
          runner: {
            runnerId: 'runner-1',
            name: 'runner-1',
            labels: [],
            repositories: [],
            systemInfo: {},
            enabled: true,
            status: 'idle',
            registeredAt: now,
            lastSeenAt: now,
          },
          runnerToken: 'agyr_run_exchanged',
        });
        return;
      }
      if (url === '/api/tasks/poll') {
        if ((options.pollStatus ?? 200) !== 200) {
          send(options.pollStatus ?? 200, { error: 'Unauthorized runner token' });
          return;
        }
        send(200, { task: options.task });
        return;
      }
      if (url.endsWith('/status')) {
        send(200, { success: true });
        return;
      }
      if (url === '/api/runner/heartbeat') {
        send(200, { success: true });
        return;
      }
      send(404, { error: 'not found' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, requests };
};

describe('Runner: coordinator request contract', () => {
  it('fits an oversized terminal report into the coordinator body limit', async () => {
    const { dir, cleanup } = makeTempDir('runner_contract_report_');
    const { task, db } = enqueueTask(dir);
    const stub = await startCoordinatorStub({ task });

    try {
      const executor = {
        execute: async () => ({
          success: true,
          branchName: 'agy/abc123-work',
          output: `HEAD_MARKER\n${'y'.repeat(200 * 1024)}\nTAIL_MARKER`,
          durationMs: 25,
          numTurns: 2,
          totalTokens: 500,
          thinkingTokens: 50,
        }),
      } as unknown as TaskExecutor;

      const runner = new RemoteSwarmRunner({
        coordinatorUrl: stub.baseUrl,
        runnerToken: 'agyr_run_test',
        runnerStatePath: path.join(dir, 'runner.json'),
        executor,
        execFileFn: async () => ({ stdout: '', stderr: '' }),
        logger: quietLogger,
      });

      const claimed = await runner.pollOnce();
      assert.equal(claimed?.id, task.id);

      assert.deepEqual(
        stub.requests.filter((request) => request.rejected),
        [],
        'the runner sent a body the coordinator refuses'
      );

      const reported = stub.requests.find(
        (request) =>
          request.path.endsWith(`/${encodeURIComponent(task.id)}/status`) &&
          request.body?.status === 'completed'
      );
      assert.ok(reported, 'no accepted terminal status report reached the coordinator');
      assert.ok(reported.bytes <= 64 * 1024);
      assert.equal(reported.body.numTurns, 2);
      assert.equal(String(reported.body.output).includes('TAIL_MARKER'), true);
      assert.equal(String(reported.body.output).includes('HEAD_MARKER'), true);
    } finally {
      await closeStubServer(stub.server);
      db.close();
      cleanup();
    }
  });

  it('backs off after a rejected credential instead of polling on in a tight loop', async () => {
    const { dir, cleanup } = makeTempDir('runner_contract_401_');
    const { task, db } = enqueueTask(dir);
    const stub = await startCoordinatorStub({ task, pollStatus: 401 });

    try {
      const runner = new RemoteSwarmRunner({
        coordinatorUrl: stub.baseUrl,
        runnerToken: 'agyr_run_revoked',
        runnerStatePath: path.join(dir, 'runner.json'),
        executor: {
          execute: async () => {
            throw new Error('a task must never be claimed with a rejected credential');
          },
        } as unknown as TaskExecutor,
        execFileFn: async () => ({ stdout: '', stderr: '' }),
        logger: quietLogger,
      });

      await assert.rejects(async () => {
        await runner.pollOnce();
      });
      const pollsAfterRejection = stub.requests.filter(
        (request) => request.path === '/api/tasks/poll'
      ).length;
      assert.equal(pollsAfterRejection, 1);

      assert.equal(await runner.pollOnce(), null);
      assert.equal(
        stub.requests.filter((request) => request.path === '/api/tasks/poll').length,
        1,
        'the backoff window must not send another poll'
      );
    } finally {
      await closeStubServer(stub.server);
      db.close();
      cleanup();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Runner CLI argument handling                                                */
/* -------------------------------------------------------------------------- */

describe('Runner CLI: argument and environment precedence', () => {
  it('settles a scheme-less coordinator URL at boot instead of failing every poll', () => {
    const opts = parseRunnerCliArgs(['--url', 'coordinator.internal:8484'], {});
    assert.equal(opts.coordinatorUrl, 'http://coordinator.internal:8484');

    const httpsOpts = parseRunnerCliArgs(['--url=https://coordinator.internal:8484/'], {});
    assert.equal(httpsOpts.coordinatorUrl, 'https://coordinator.internal:8484');
  });

  it('refuses a coordinator URL that cannot be parsed', () => {
    assert.throws(
      () => parseRunnerCliArgs(['--url', 'not a valid url'], {}),
      /Coordinator URL is not a valid URL/
    );
  });

  it('shares the runner policy normaliser, so a padded or upper-case policy is honoured', () => {
    assert.equal(parseRunnerCliArgs([], { PR_POLICY: '  DOCS_ONLY ' }).prPolicy, 'docs_only');
    assert.equal(parseRunnerCliArgs(['--pr-policy=issue_only'], {}).prPolicy, undefined);
  });

  it('lets REMOTE_AGY_BIN_PATH outrank AGY_BIN_PATH for a spawned runner', () => {
    assert.equal(
      parseRunnerCliArgs([], {
        REMOTE_AGY_BIN_PATH: '/opt/override/agy',
        AGY_BIN_PATH: '/usr/bin/agy',
      }).agyBinPath,
      '/opt/override/agy'
    );
    assert.equal(
      parseRunnerCliArgs(['--agy-bin', '/flag/agy'], { REMOTE_AGY_BIN_PATH: '/opt/override/agy' })
        .agyBinPath,
      '/flag/agy'
    );
  });

  it('keeps the long-poll defaults when compose exports empty interval variables', () => {
    const opts = parseRunnerCliArgs([], {
      RUNNER_POLL_TIMEOUT_MS: '',
      RUNNER_IDLE_INTERVAL_MS: ' ',
    });
    assert.equal(opts.pollTimeoutMs, 25000);
    assert.equal(opts.idlePollIntervalMs, 2000);

    const explicit = parseRunnerCliArgs([], { RUNNER_IDLE_INTERVAL_MS: '0' });
    assert.equal(explicit.idlePollIntervalMs, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Periodic agy update (idle-only)                                            */
/* -------------------------------------------------------------------------- */

const waitForCondition = async (predicate: () => boolean, label: string): Promise<void> => {
  // The stub records on request end, so a loaded suite can take well past a second to see it.
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

describe('Runner: idle-only agy update', () => {
  it('defers the scheduled update while a task is executing', async () => {
    const { dir, cleanup } = makeTempDir('runner_agy_idle_');
    const { task, db } = enqueueTask(dir);
    const stub = await startCoordinatorStub({ task });

    let releaseTask = (): void => {};
    const taskStarted = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const updates: string[] = [];

    const runner = new RemoteSwarmRunner({
      coordinatorUrl: stub.baseUrl,
      runnerToken: 'agyr_run_test',
      runnerStatePath: path.join(dir, 'runner.json'),
      executor: {
        execute: async () => {
          await taskStarted;
          return { success: true, output: '', durationMs: 1 };
        },
      } as unknown as TaskExecutor,
      execFileFn: async () => ({ stdout: '', stderr: '' }),
      agyUpdater: {
        getVersion: async () => null,
        getCachedVersion: () => null,
        invalidate: () => {},
        update: async () => {
          updates.push('update');
          return { before: null, after: null, updated: false };
        },
      },
      logger: quietLogger,
    });

    try {
      const polling = runner.pollOnce();
      await waitForCondition(
        () => stub.requests.some((request) => request.body?.status === 'executing'),
        'the executing claim'
      );

      assert.equal(await runner.runScheduledAgyUpdate(), false);
      assert.deepEqual(updates, [], 'a running task owns the binary');

      releaseTask();
      await polling;

      assert.equal(await runner.runScheduledAgyUpdate(), true);
      assert.deepEqual(updates, ['update']);
    } finally {
      releaseTask();
      await closeStubServer(stub.server);
      db.close();
      cleanup();
    }
  });
});

describe('Runner: agy update gate', () => {
  it('claims nothing while the update is replacing the binary', async () => {
    const { dir, cleanup } = makeTempDir('runner_agy_update_gate_');
    const { task, db } = enqueueTask(dir);
    const stub = await startCoordinatorStub({ task });

    let releaseUpdate = (): void => {};
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });

    const runner = new RemoteSwarmRunner({
      coordinatorUrl: stub.baseUrl,
      runnerToken: 'agyr_run_test',
      runnerStatePath: path.join(dir, 'runner.json'),
      executor: {
        execute: async () => ({ success: true, output: '', durationMs: 1 }),
      } as unknown as TaskExecutor,
      execFileFn: async () => ({ stdout: '', stderr: '' }),
      agyUpdater: {
        getVersion: async () => null,
        getCachedVersion: () => null,
        invalidate: () => {},
        update: async () => {
          await updateGate;
          return { before: null, after: null, updated: false };
        },
      },
      logger: quietLogger,
    });

    try {
      const updating = runner.runScheduledAgyUpdate();
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(await runner.pollOnce(), null);
      assert.deepEqual(
        stub.requests.filter((request) => request.body?.status === 'executing'),
        []
      );

      releaseUpdate();
      assert.equal(await updating, true);
    } finally {
      releaseUpdate();
      await closeStubServer(stub.server);
      db.close();
      cleanup();
    }
  });
});

describe('Runner: PR body selection', () => {
  it('uses the agent summary instead of the meta-prompt for routine PRs', () => {
    const body = buildPullRequestBody(
      { tier: 'routine', prompt: 'Step 1: list issues\nStep 2: branch' },
      'Prevent capOutput surrogate split (#20)',
      'Fixed capOutput to use tailWindow. Closes #20.'
    );
    assert.equal(body, 'Fixed capOutput to use tailWindow. Closes #20.');
  });

  it('falls back to the resolved title when a routine produces no captured output', () => {
    const body = buildPullRequestBody(
      { tier: 'routine', prompt: 'Step 1: list issues' },
      'Prevent capOutput surrogate split (#20)',
      '   \n  '
    );
    assert.equal(body, 'Prevent capOutput surrogate split (#20)');
  });

  it('keeps the original task prompt for non-routine PRs', () => {
    const body = buildPullRequestBody(
      { tier: 'immediate', prompt: 'Fix the header wrapping in SwarmRunnersStrip' },
      'Fix header wrapping',
      'Done.'
    );
    assert.equal(body, 'Fix the header wrapping in SwarmRunnersStrip');
  });
});

describe('Runner: automatic GitHub commit identity & no-co-authoring directive', () => {
  it('resolves git author identity from the leased GitHub token, caches it, and forbids Co-authored-by trailers', async () => {
    const { dir, cleanup } = makeTempDir('runner_gh_identity_');
    const db = new AppDatabase(path.join(dir, 'test.db'));
    const prevAuthorName = process.env.GIT_AUTHOR_NAME;
    const prevAuthorEmail = process.env.GIT_AUTHOR_EMAIL;
    const prevCommitterName = process.env.GIT_COMMITTER_NAME;
    const prevCommitterEmail = process.env.GIT_COMMITTER_EMAIL;
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_NAME;
    delete process.env.GIT_COMMITTER_EMAIL;

    try {
      const queue = new TaskQueue(db);
      let resolveCalls = 0;
      const capturedAgyEnvs: Array<Record<string, string | undefined>> = [];
      const capturedPrompts: string[] = [];

      const executor = new TaskExecutor({
        dirExistsFn: () => true,
        resolveGithubIdentityFn: async () => {
          resolveCalls += 1;
          return { name: 'OtterBoops', email: '12345+OtterBoops@users.noreply.github.com' };
        },
        execFileFn: async (file, args, opts) => {
          if (file === 'agy') {
            capturedAgyEnvs.push({ ...(opts?.env as Record<string, string | undefined>) });
            const pIdx = args.indexOf('-p');
            if (pIdx >= 0) capturedPrompts.push(String(args[pIdx + 1] ?? ''));
            return { stdout: 'Done.', stderr: '' };
          }
          if (file === 'git' && args[0] === 'status') return { stdout: '', stderr: '' };
          if (file === 'git' && args[0] === 'rev-list') return { stdout: '0\n', stderr: '' };
          return { stdout: '', stderr: '' };
        },
      });

      const task1 = queue.enqueue({
        repositoryName: 'agylity',
        repositoryPath: dir,
        prompt: 'Fix a bug',
        cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
        pushBranch: false,
        autoCreatePr: false,
      });
      const task2 = queue.enqueue({
        repositoryName: 'agylity',
        repositoryPath: dir,
        prompt: 'Fix another bug',
        cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
        pushBranch: false,
        autoCreatePr: false,
      });

      await executor.execute(task1, { githubToken: 'ghp_test_token_123' });
      await executor.execute(task2, { githubToken: 'ghp_test_token_123' });

      assert.equal(resolveCalls, 1, 'GitHub identity lookup should be cached per token');
      assert.equal(capturedAgyEnvs[0]?.GIT_AUTHOR_NAME, 'OtterBoops');
      assert.equal(
        capturedAgyEnvs[0]?.GIT_AUTHOR_EMAIL,
        '12345+OtterBoops@users.noreply.github.com'
      );
      assert.equal(capturedAgyEnvs[0]?.GIT_COMMITTER_NAME, 'OtterBoops');
      assert.equal(
        capturedAgyEnvs[0]?.GIT_COMMITTER_EMAIL,
        '12345+OtterBoops@users.noreply.github.com'
      );
      assert.match(capturedPrompts[0] ?? '', /Do NOT add Co-authored-by trailers/);
    } finally {
      if (prevAuthorName !== undefined) process.env.GIT_AUTHOR_NAME = prevAuthorName;
      if (prevAuthorEmail !== undefined) process.env.GIT_AUTHOR_EMAIL = prevAuthorEmail;
      if (prevCommitterName !== undefined) process.env.GIT_COMMITTER_NAME = prevCommitterName;
      if (prevCommitterEmail !== undefined) process.env.GIT_COMMITTER_EMAIL = prevCommitterEmail;
      db.close();
      cleanup();
    }
  });
});

describe('Runner: branch attribution guard', () => {
  it('detects co-author trailers however the agent spells them', () => {
    assert.equal(hasCoAuthorTrailer('feat: x\n\nCo-authored-by: A <a@b.c>'), true);
    assert.equal(hasCoAuthorTrailer('feat: x\n\nco-authored-by:A <a@b.c>'), true);
    assert.equal(hasCoAuthorTrailer('feat: x\r\n  Co-Authored-By: A <a@b.c>'), true);
    assert.equal(hasCoAuthorTrailer('feat: x\n\nCo-authored-by is prose here'), false);
    assert.equal(hasCoAuthorTrailer('feat: x\n\nSigned-off-by: A <a@b.c>'), false);
  });

  it('strips the trailer and the blank tail it leaves behind', () => {
    const stripped = stripCoAuthorTrailers('feat: x\n\nBody line.\n\nCo-authored-by: A <a@b.c>\n');
    assert.equal(stripped, 'feat: x\n\nBody line.\n');
  });

  it('treats any address the lease does not own as unowned, not only a noreply one', () => {
    const owned = '12345+OtterBoops@users.noreply.github.com';
    assert.equal(isUnownedIdentity('user@users.noreply.github.com', owned), true);
    assert.equal(isUnownedIdentity('999+stranger@users.noreply.github.com', owned), true);
    // A stranger with an ordinary address is still a stranger.
    assert.equal(isUnownedIdentity('ilya@example.com', owned), true);
    assert.equal(isUnownedIdentity('12345+OtterBoops@users.noreply.github.com', owned), false);
    assert.equal(isUnownedIdentity('12345+OTTERBOOPS@users.noreply.github.com', owned), false);
    assert.equal(isUnownedIdentity('user@users.noreply.github.com', undefined), true);
  });

  it('parses a git log dump into oldest-first commits with the message intact', () => {
    const record = (fields: string[]): string => `${fields.join('\u0000')}\u0000`;
    const stdout =
      record([
        'sha1',
        'tree1',
        'p0',
        'Ada',
        'ada@example.com',
        '2026-01-01T00:00:00+02:00',
        'Ada',
        'ada@example.com',
        '2026-01-01T00:00:00+02:00',
        'feat: one',
      ]) +
      record([
        'sha2',
        'tree2',
        'sha1 p9',
        'Grace',
        'grace@example.com',
        '2026-01-02T00:00:00+02:00',
        'Grace',
        'grace@example.com',
        '2026-01-02T00:00:00+02:00',
        'feat: two\n\nBody\n\nCo-authored-by: A <a@b.c>\n',
      ]);

    const commits = parseBranchCommitLog(stdout);
    assert.equal(commits.length, 2);
    assert.deepEqual(commits[0], {
      sha: 'sha1',
      tree: 'tree1',
      parents: ['p0'],
      authorName: 'Ada',
      authorEmail: 'ada@example.com',
      authorDate: '2026-01-01T00:00:00+02:00',
      committerName: 'Ada',
      committerEmail: 'ada@example.com',
      committerDate: '2026-01-01T00:00:00+02:00',
      message: 'feat: one',
    });
    assert.deepEqual(commits[1]?.parents, ['sha1', 'p9']);
    assert.match(commits[1]?.message ?? '', /Co-authored-by: A <a@b\.c>/);
    assert.deepEqual(parseBranchCommitLog(''), []);
  });

  it('keeps a commit message that contains the old record and field separators in one record', () => {
    const record = (fields: string[]): string => `${fields.join('\u0000')}\u0000`;
    const forged =
      'feat: legit\n\u001e' +
      ['deadbeef', 'treeX', '', 'Eve', 'e@x.y', 'T', 'Eve', 'e@x.y', 'T', 'forged tip'].join(
        '\u001f'
      );
    const stdout = record([
      'sha1',
      'tree1',
      '',
      'Ada',
      'ada@example.com',
      '2026-01-01T00:00:00+02:00',
      'Ada',
      'ada@example.com',
      '2026-01-01T00:00:00+02:00',
      forged,
    ]);

    const commits = parseBranchCommitLog(stdout);
    assert.equal(commits.length, 1, 'a message must never split into a second record');
    assert.equal(commits[0]?.sha, 'sha1');
    assert.match(commits[0]?.message ?? '', /forged tip/);
  });

  it('strips trailers and rewrites a placeholder identity before the branch reaches the remote', async () => {
    const { dir, cleanup } = makeTempDir('runner_attribution_');
    const work = path.join(dir, 'work');
    const remote = path.join(dir, 'remote.git');
    const saved = {
      name: process.env.GIT_AUTHOR_NAME,
      email: process.env.GIT_AUTHOR_EMAIL,
      committerName: process.env.GIT_COMMITTER_NAME,
      committerEmail: process.env.GIT_COMMITTER_EMAIL,
    };
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_NAME;
    delete process.env.GIT_COMMITTER_EMAIL;

    const git = async (
      cwd: string,
      args: string[],
      env?: Record<string, string>
    ): Promise<string> =>
      (
        await defaultExecFileAsync('git', args, {
          cwd,
          timeout: 30000,
          env: { ...process.env, ...env },
        })
      ).stdout;

    const lease = { name: 'OtterBoops', email: '12345+OtterBoops@users.noreply.github.com' };
    const leased = {
      GIT_AUTHOR_NAME: lease.name,
      GIT_AUTHOR_EMAIL: lease.email,
      GIT_COMMITTER_NAME: lease.name,
      GIT_COMMITTER_EMAIL: lease.email,
    };
    let cleanSha = '';
    let baseSha = '';

    try {
      const db = new AppDatabase(path.join(dir, 'test.db'));
      try {
        await git(dir, ['init', '-q', '-b', 'main', work]);
        await git(dir, ['init', '-q', '--bare', remote]);
        await git(work, ['remote', 'add', 'origin', remote.split(path.sep).join('/')]);
        writeFileSync(path.join(work, 'README.md'), 'base\n');
        await git(work, ['add', '-A']);
        await git(work, ['commit', '-q', '-m', 'chore: base'], {
          GIT_AUTHOR_NAME: 'Human',
          GIT_AUTHOR_EMAIL: 'human@example.com',
          GIT_COMMITTER_NAME: 'Human',
          GIT_COMMITTER_EMAIL: 'human@example.com',
        });
        baseSha = (await git(work, ['rev-parse', 'HEAD'])).trim();

        const executor = new TaskExecutor({
          agyBinPath: 'agy',
          dirExistsFn: () => true,
          prPolicy: 'all',
          resolveGithubIdentityFn: async () => lease,
          execFileFn: async (file, args, opts) => {
            if (file === 'agy') {
              // A clean commit the runner must leave alone, then the one an improviser wrote.
              writeFileSync(path.join(work, 'a.txt'), 'a\n');
              await git(work, ['add', '-A']);
              await git(work, ['commit', '-q', '-m', 'feat: add a'], leased);
              cleanSha = (await git(work, ['rev-parse', 'HEAD'])).trim();

              writeFileSync(path.join(work, 'b.txt'), 'b\n');
              await git(work, ['add', '-A']);
              await git(
                work,
                [
                  'commit',
                  '-q',
                  '-m',
                  'feat: add b\n\nCo-authored-by: Stranger <999+stranger@users.noreply.github.com>',
                ],
                {
                  GIT_AUTHOR_NAME: 'User',
                  GIT_AUTHOR_EMAIL: 'user@users.noreply.github.com',
                  GIT_COMMITTER_NAME: 'User',
                  GIT_COMMITTER_EMAIL: 'user@users.noreply.github.com',
                }
              );
              return { stdout: 'Done.', stderr: '' };
            }
            if (file === 'gh') throw new Error('no pull request may be opened for this task');
            return defaultExecFileAsync(file, args, opts);
          },
        });

        const task = new TaskQueue(db).enqueue({
          repositoryName: 'agylity',
          repositoryPath: work,
          prompt: 'Add a and b',
          cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
          prPolicy: 'all',
          pushBranch: true,
          autoCreatePr: false,
        });

        const result = await executor.execute(task, { githubToken: 'ghp_test_token_123' });
        assert.equal(result.success, true, result.error ?? 'the run must succeed');
        assert.ok(result.branchName, 'the pushed branch must be reported');

        const pushed = await git(remote, [
          'log',
          '--reverse',
          `-z`,
          `--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B`,
          result.branchName,
          `^${baseSha}`,
        ]);
        const commits = parseBranchCommitLog(pushed);

        assert.equal(commits.length, 2);
        assert.equal(commits[0]?.sha, cleanSha, 'a clean commit keeps its own id');
        assert.equal(commits[0]?.authorEmail, lease.email);

        const offending = commits[1];
        assert.equal(offending?.authorEmail, lease.email);
        assert.equal(offending?.authorName, lease.name);
        assert.equal(offending?.committerEmail, lease.email);
        assert.equal(offending?.committerName, lease.name);
        assert.doesNotMatch(offending?.message ?? '', /co-authored-by/i);
        assert.match(offending?.message ?? '', /^feat: add b/);
        assert.equal(pushed.includes('user@users.noreply.github.com'), false);
        assert.equal(pushed.includes('stranger@users.noreply.github.com'), false);

        // The rewrite only moved identity: the trees still carry the work under review.
        assert.equal(await git(remote, ['show', `${result.branchName}:a.txt`]), 'a\n');
        assert.equal(await git(remote, ['show', `${result.branchName}:b.txt`]), 'b\n');
      } finally {
        db.close();
      }
    } finally {
      if (saved.name !== undefined) process.env.GIT_AUTHOR_NAME = saved.name;
      if (saved.email !== undefined) process.env.GIT_AUTHOR_EMAIL = saved.email;
      if (saved.committerName !== undefined) process.env.GIT_COMMITTER_NAME = saved.committerName;
      if (saved.committerEmail !== undefined)
        process.env.GIT_COMMITTER_EMAIL = saved.committerEmail;
      cleanup();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Audited bug regression tests                                               */
/* -------------------------------------------------------------------------- */

describe('Runner: audited bug regressions', () => {
  const git = async (cwd: string, args: string[], env?: Record<string, string>): Promise<string> =>
    (
      await defaultExecFileAsync('git', args, {
        cwd,
        timeout: 30000,
        env: { ...process.env, ...env },
      })
    ).stdout;

  const baseCommitEnv = {
    GIT_AUTHOR_NAME: 'Human',
    GIT_AUTHOR_EMAIL: 'human@example.com',
    GIT_COMMITTER_NAME: 'Human',
    GIT_COMMITTER_EMAIL: 'human@example.com',
  };

  it('Bug 1: skips git commit cleanly when the agent committed its work and verification leaves untracked artifacts', async () => {
    const { dir, cleanup } = makeTempDir('runner_bug1_verify_only_');
    const work = path.join(dir, 'work');
    const db = new AppDatabase(path.join(dir, 'test.db'));

    try {
      await git(dir, ['init', '-q', '-b', 'main', work]);
      writeFileSync(path.join(work, 'README.md'), 'base\n');
      await git(work, ['add', '-A']);
      await git(work, ['commit', '-q', '-m', 'chore: base'], baseCommitEnv);

      const { spawnFn } = recordSpawn((call) => {
        if (call.file === 'agy') {
          writeFileSync(path.join(work, 'feature.ts'), 'export const x = 1;\n');
          void git(work, ['add', '-A'])
            .then(() => git(work, ['commit', '-q', '-m', 'feat: add feature'], baseCommitEnv))
            .then(() => finishChild(call.child, 0, 'Committed.\n'));
          return;
        }
        // Verification leaves an untracked artifact behind after the agent's tree was clean.
        writeFileSync(path.join(work, 'verify.log'), 'passed\n');
        finishChild(call.child, 0, 'ok\n');
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: async (file, args, opts) => defaultExecFileAsync(file, args, opts),
      });

      const task = new TaskQueue(db).enqueue({
        repositoryName: 'agylity',
        repositoryPath: work,
        prompt: 'Add feature',
        cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
        verifyCommand: 'npm test',
        prPolicy: 'all',
        pushBranch: false,
        autoCreatePr: false,
      });

      const result = await executor.execute(task);
      assert.equal(result.success, true, result.error ?? 'must not fail with nothing to commit');
      assert.equal(result.noChanges, undefined);
      const committed = (await git(work, ['ls-tree', '-r', '--name-only', 'HEAD']))
        .split('\n')
        .filter(Boolean);
      assert.ok(committed.includes('feature.ts'));
      assert.equal(committed.includes('verify.log'), false);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('Bug 2: stages remaining untracked files in a batch when one vanished before commit', async () => {
    const { dir, cleanup } = makeTempDir('runner_bug2_vanished_');
    const work = path.join(dir, 'work');
    const db = new AppDatabase(path.join(dir, 'test.db'));

    try {
      await git(dir, ['init', '-q', '-b', 'main', work]);
      writeFileSync(path.join(work, 'README.md'), 'base\n');
      await git(work, ['add', '-A']);
      await git(work, ['commit', '-q', '-m', 'chore: base'], baseCommitEnv);

      const { spawnFn } = recordSpawn((call) => {
        if (call.file === 'agy') {
          writeFileSync(path.join(work, 'keep.ts'), 'export const keep = true;\n');
          writeFileSync(path.join(work, 'temp.tmp'), 'ephemeral\n');
          finishChild(call.child, 0, 'Done.\n');
          return;
        }
        // Verification deletes temp.tmp after listUntracked already captured it.
        rmSync(path.join(work, 'temp.tmp'), { force: true });
        finishChild(call.child, 0, 'ok\n');
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: async (file, args, opts) => defaultExecFileAsync(file, args, opts),
      });

      const task = new TaskQueue(db).enqueue({
        repositoryName: 'agylity',
        repositoryPath: work,
        prompt: 'Add keep.ts',
        cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
        verifyCommand: 'npm test',
        prPolicy: 'all',
        pushBranch: false,
        autoCreatePr: false,
      });

      const result = await executor.execute(task);
      assert.equal(result.success, true, result.error ?? 'must succeed');
      const committed = (await git(work, ['ls-tree', '-r', '--name-only', 'HEAD']))
        .split('\n')
        .filter(Boolean);
      assert.ok(
        committed.includes('keep.ts'),
        'keep.ts must not be dropped when temp.tmp vanished'
      );
      assert.equal(committed.includes('temp.tmp'), false);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('Bug 3: listUntracked expands new directories with -uall and skips rename source paths', async () => {
    const { dir, cleanup } = makeTempDir('runner_bug3_uall_');
    const work = path.join(dir, 'work');
    const db = new AppDatabase(path.join(dir, 'test.db'));

    try {
      await git(dir, ['init', '-q', '-b', 'main', work]);
      writeFileSync(path.join(work, 'README.md'), 'base\n');
      await git(work, ['add', '-A']);
      await git(work, ['commit', '-q', '-m', 'chore: base'], baseCommitEnv);

      const { spawnFn } = recordSpawn((call) => {
        if (call.file === 'agy') {
          mkdirSync(path.join(work, 'newdir'), { recursive: true });
          writeFileSync(path.join(work, 'newdir', 'agent.ts'), 'export const a = 1;\n');
          finishChild(call.child, 0, 'Done.\n');
          return;
        }
        // Verification writes a file inside the SAME new directory the agent created.
        writeFileSync(path.join(work, 'newdir', 'verify-artifact.log'), 'noise\n');
        finishChild(call.child, 0, 'ok\n');
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: async (file, args, opts) => defaultExecFileAsync(file, args, opts),
      });

      const task = new TaskQueue(db).enqueue({
        repositoryName: 'agylity',
        repositoryPath: work,
        prompt: 'Create newdir/agent.ts',
        cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
        verifyCommand: 'npm test',
        prPolicy: 'all',
        pushBranch: false,
        autoCreatePr: false,
      });

      const result = await executor.execute(task);
      assert.equal(result.success, true, result.error ?? 'must succeed');
      const committed = (await git(work, ['ls-tree', '-r', '--name-only', 'HEAD']))
        .split('\n')
        .filter(Boolean);
      assert.ok(committed.includes('newdir/agent.ts'));
      assert.equal(
        committed.includes('newdir/verify-artifact.log'),
        false,
        '-uall must expand newdir/ so verification artifacts inside it are not staged'
      );
    } finally {
      db.close();
      cleanup();
    }
  });

  it('Bug 3b: listUntracked skips the source path of a rename entry in -z output', async () => {
    const { dir, cleanup } = makeTempDir('runner_bug3_rename_');
    const { task, db } = enqueueTask(dir, { pushBranch: false, autoCreatePr: false });
    const addedBatches: string[][] = [];

    try {
      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn: recordSpawn((call) => finishChild(call.child, 0, 'Done.\n')).spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: async (file, args) => {
          if (file !== 'git') return { stdout: '', stderr: '' };
          if (args[0] === 'status' && args.includes('-z')) {
            assert.equal(args.includes('-uall'), true, 'listUntracked must pass -uall');
            // Rename source literally starts with `?? ` to catch naive filtering.
            return { stdout: 'R  new.ts\u0000?? old-source.ts\u0000?? real.ts\u0000', stderr: '' };
          }
          if (args[0] === 'status') return { stdout: '?? real.ts\n', stderr: '' };
          if (args[0] === 'add' && args[1] === '--') {
            addedBatches.push([...args.slice(2)]);
            return { stdout: '', stderr: '' };
          }
          if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--quiet') {
            throw Object.assign(new Error('staged'), { code: 1 });
          }
          return { stdout: '', stderr: '' };
        },
      });

      const result = await executor.execute(task);
      assert.equal(result.success, true, result.error ?? 'must succeed');
      assert.deepEqual(addedBatches, [['real.ts']]);
    } finally {
      db.close();
      cleanup();
    }
  });

  it('Bug 4: stripUntrustedAttribution uses --topo-order and resets to rewritten HEAD on skewed-timestamp merges', async () => {
    const { dir, cleanup } = makeTempDir('runner_bug4_topo_');
    const work = path.join(dir, 'work');
    const remote = path.join(dir, 'remote.git');
    const db = new AppDatabase(path.join(dir, 'test.db'));

    try {
      await git(dir, ['init', '-q', '-b', 'main', work]);
      await git(dir, ['init', '-q', '--bare', remote]);
      await git(work, ['remote', 'add', 'origin', remote.split(path.sep).join('/')]);
      writeFileSync(path.join(work, 'README.md'), 'base\n');
      await git(work, ['add', '-A']);
      await git(work, ['commit', '-q', '-m', 'chore: base'], {
        ...baseCommitEnv,
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      });
      const baseSha = (await git(work, ['rev-parse', 'HEAD'])).trim();

      const lease = { name: 'OtterBoops', email: '12345+OtterBoops@users.noreply.github.com' };
      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        prPolicy: 'all',
        resolveGithubIdentityFn: async () => lease,
        execFileFn: async (file, args, opts) => {
          if (file === 'agy') {
            // Create a side branch with a FUTURE timestamp and merge it with an EARLIER timestamp.
            // Without --topo-order, `git log --reverse` places the merge commit before its parent.
            await git(work, ['checkout', '-q', '-b', 'side']);
            writeFileSync(path.join(work, 'side.txt'), 'side\n');
            await git(work, ['add', '-A']);
            await git(
              work,
              ['commit', '-q', '-m', 'feat: side\n\nCo-authored-by: Bot <bot@example.com>'],
              {
                GIT_AUTHOR_NAME: 'Stranger',
                GIT_AUTHOR_EMAIL: 'stranger@example.com',
                GIT_COMMITTER_NAME: 'Stranger',
                GIT_COMMITTER_EMAIL: 'stranger@example.com',
                GIT_AUTHOR_DATE: '2027-06-01T00:00:00Z',
                GIT_COMMITTER_DATE: '2027-06-01T00:00:00Z',
              }
            );
            await git(work, ['checkout', '-q', '-']);
            writeFileSync(path.join(work, 'mainline.txt'), 'mainline\n');
            await git(work, ['add', '-A']);
            await git(work, ['commit', '-q', '-m', 'feat: mainline'], {
              GIT_AUTHOR_NAME: lease.name,
              GIT_AUTHOR_EMAIL: lease.email,
              GIT_COMMITTER_NAME: lease.name,
              GIT_COMMITTER_EMAIL: lease.email,
              GIT_AUTHOR_DATE: '2026-02-01T00:00:00Z',
              GIT_COMMITTER_DATE: '2026-02-01T00:00:00Z',
            });
            await git(work, ['merge', '-q', '--no-ff', 'side', '-m', 'merge: side'], {
              GIT_AUTHOR_NAME: lease.name,
              GIT_AUTHOR_EMAIL: lease.email,
              GIT_COMMITTER_NAME: lease.name,
              GIT_COMMITTER_EMAIL: lease.email,
              GIT_AUTHOR_DATE: '2026-03-01T00:00:00Z',
              GIT_COMMITTER_DATE: '2026-03-01T00:00:00Z',
            });
            return { stdout: 'Done.', stderr: '' };
          }
          if (file === 'gh') throw new Error('no PR');
          return defaultExecFileAsync(file, args, opts);
        },
      });

      const task = new TaskQueue(db).enqueue({
        repositoryName: 'agylity',
        repositoryPath: work,
        prompt: 'Merge side',
        cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
        prPolicy: 'all',
        pushBranch: true,
        autoCreatePr: false,
      });

      const result = await executor.execute(task, { githubToken: 'ghp_test_token_123' });
      assert.equal(result.success, true, result.error ?? 'must succeed');
      assert.ok(result.branchName);

      // Tip of pushed branch must be the merge commit containing BOTH files, not the side parent.
      assert.equal(await git(remote, ['show', `${result.branchName}:side.txt`]), 'side\n');
      assert.equal(await git(remote, ['show', `${result.branchName}:mainline.txt`]), 'mainline\n');
      const tipSubject = (
        await git(remote, ['log', '-1', '--format=%s', result.branchName])
      ).trim();
      assert.equal(tipSubject, 'merge: side');

      const pushedLog = await git(remote, [
        'log',
        '-z',
        '--topo-order',
        '--reverse',
        `--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B`,
        result.branchName,
        `^${baseSha}`,
      ]);
      const commits = parseBranchCommitLog(pushedLog);
      for (const c of commits) {
        assert.equal(c.authorEmail, lease.email);
        assert.equal(c.committerEmail, lease.email);
        assert.doesNotMatch(c.message, /co-authored-by/i);
      }
    } finally {
      db.close();
      cleanup();
    }
  });

  it('Bug 5: ambient GIT_COMMITTER_EMAIL does not override leaseIdentity and skips token lookup when lease provides both', async () => {
    const { dir, cleanup } = makeTempDir('runner_bug5_committer_');
    const { task, db } = enqueueTask(dir, { pushBranch: false, autoCreatePr: false });
    const prevCommitterName = process.env.GIT_COMMITTER_NAME;
    const prevCommitterEmail = process.env.GIT_COMMITTER_EMAIL;
    process.env.GIT_COMMITTER_NAME = 'Ambient Host';
    process.env.GIT_COMMITTER_EMAIL = 'ambient@host.local';

    try {
      let resolveCalls = 0;
      const capturedEnvs: Array<Record<string, string | undefined>> = [];

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        resolveGithubIdentityFn: async () => {
          resolveCalls += 1;
          return { name: 'TokenUser', email: 'token@users.noreply.github.com' };
        },
        execFileFn: async (file, args, opts) => {
          if (file === 'agy') {
            capturedEnvs.push({ ...(opts?.env as Record<string, string | undefined>) });
            return { stdout: 'Done.', stderr: '' };
          }
          if (file === 'git' && args[0] === 'status') return { stdout: '', stderr: '' };
          if (file === 'git' && args[0] === 'rev-list') return { stdout: '0\n', stderr: '' };
          return { stdout: '', stderr: '' };
        },
      });

      await executor.execute(task, {
        githubToken: 'ghp_test_token_123',
        gitIdentity: { name: 'Lease User', email: 'lease@example.com' },
      });

      assert.equal(resolveCalls, 0, 'must skip GitHub identity lookup when lease provides both');
      assert.equal(capturedEnvs[0]?.GIT_AUTHOR_NAME, 'Lease User');
      assert.equal(capturedEnvs[0]?.GIT_AUTHOR_EMAIL, 'lease@example.com');
      assert.equal(capturedEnvs[0]?.GIT_COMMITTER_NAME, 'Lease User');
      assert.equal(capturedEnvs[0]?.GIT_COMMITTER_EMAIL, 'lease@example.com');
    } finally {
      if (prevCommitterName === undefined) delete process.env.GIT_COMMITTER_NAME;
      else process.env.GIT_COMMITTER_NAME = prevCommitterName;
      if (prevCommitterEmail === undefined) delete process.env.GIT_COMMITTER_EMAIL;
      else process.env.GIT_COMMITTER_EMAIL = prevCommitterEmail;
      db.close();
      cleanup();
    }
  });

  it('Bug 6: redacts leased githubToken from cascade continuation prompt and gh error logs', async () => {
    const { dir, cleanup } = makeTempDir('runner_bug6_redaction_');
    const token = 'ghp_secret_cascade_token_987654321';
    const { task, db } = enqueueTask(dir, {
      repositoryName: 'OtterBoops/agylity',
      prPolicy: 'all',
      pushBranch: true,
      autoCreatePr: true,
      cascade: [
        { model: 'gemini-4-argon', effort: 'high' },
        { model: 'gemini-4-hydrogen', effort: 'medium' },
      ],
    });
    const logs: string[] = [];
    const testLogger = createLogger({
      minLevel: 'warn',
      sinks: [(record) => logs.push(record.formatted)],
    });

    try {
      let statusCalls = 0;
      const { spawnFn, calls } = recordSpawn((call, index) => {
        if (index === 0) {
          finishChild(call.child, 1, `TOKEN=${token}\nMODEL_CAPACITY_EXHAUSTED\n`);
        } else {
          finishChild(call.child, 0, 'finished\n');
        }
      });

      const exec = createWorkspaceExecFile({
        status: () => {
          statusCalls += 1;
          return statusCalls === 1 ? '' : ' M src/a.ts\n';
        },
        revList: () => '1\n',
        diffStat: ' src/a.ts | 1 +\n',
        onGh: () => {
          throw new Error(`gh failed with token ${token}`);
        },
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        resolveGithubIdentityFn: async () => ({ name: 'Bot', email: 'bot@example.com' }),
        execFileFn: exec.execFileFn,
        logger: testLogger,
      });

      const result = await executor.execute(task, { githubToken: token });
      assert.equal(result.success, true);
      assert.equal(calls.length, 2);
      const handoff = promptOf(calls[1]);
      assert.equal(handoff.includes(token), false, 'continuation prompt must redact githubToken');
      assert.ok(handoff.includes('[redacted]'));

      assert.ok(logs.some((line) => line.includes('Auto PR creation failed')));
      for (const line of logs) {
        assert.equal(line.includes(token), false, `log leaked token: ${line}`);
      }
    } finally {
      db.close();
      cleanup();
    }
  });

  it('Bug 7: runScheduledAgyUpdate defers while pollOnce is actively long-polling', async () => {
    const { dir, cleanup } = makeTempDir('runner_bug7_poll_toctou_');
    const db = new AppDatabase(path.join(dir, 'test.db'));
    let releasePoll: (() => void) | null = null;
    const finishPoll = (): void => {
      const fn = releasePoll;
      releasePoll = null;
      fn?.();
    };
    let pollArrived = false;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/api/tasks/poll') {
          pollArrived = true;
          releasePoll = () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ task: null }));
          };
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    const updates: string[] = [];

    try {
      const runner = new RemoteSwarmRunner({
        coordinatorUrl: `http://127.0.0.1:${port}`,
        runnerToken: 'agyr_run_test',
        runnerStatePath: path.join(dir, 'runner.json'),
        execFileFn: async () => ({ stdout: '', stderr: '' }),
        agyUpdater: {
          getVersion: async () => null,
          getCachedVersion: () => null,
          invalidate: () => {},
          update: async () => {
            updates.push('update');
            return { before: null, after: null, updated: false };
          },
        },
        logger: quietLogger,
      });

      const polling = runner.pollOnce();
      await waitForCondition(() => pollArrived, 'long-poll request to arrive');

      // While pollOnce is waiting on /api/tasks/poll, scheduled update must defer.
      assert.equal(await runner.runScheduledAgyUpdate(), false);
      assert.deepEqual(updates, []);

      finishPoll();
      await polling;

      assert.equal(await runner.runScheduledAgyUpdate(), true);
      assert.deepEqual(updates, ['update']);
    } finally {
      finishPoll();
      await closeStubServer(server);
      db.close();
      cleanup();
    }
  });

  it('Bug 8: fitStatusPayload bounds JSON-escaped byte length and does not mutate issueUrls', () => {
    const issueUrls = [
      'https://github.com/OtterBoops/agylity/issues/1',
      'https://github.com/OtterBoops/agylity/issues/2',
      'https://github.com/OtterBoops/agylity/issues/3',
    ];
    const originalUrls = [...issueUrls];

    // ANSI escape bytes expand 6x under JSON.stringify (`\u001b`).
    const ansiPayload: Record<string, unknown> = {
      status: 'completed',
      runnerId: 'runner-1',
      output: '\u001b[31m"error"\n'.repeat(10_000),
      issueUrls,
    };
    const fittedAnsi = fitStatusPayload(ansiPayload, STATUS_BODY_MAX_BYTES);
    assert.ok(
      Buffer.byteLength(JSON.stringify(fittedAnsi), 'utf8') <= STATUS_BODY_MAX_BYTES,
      'JSON-escaped payload must fit within maxBytes'
    );

    // Force issueUrls trimming with a tight budget and verify the caller array is not mutated.
    const tightPayload: Record<string, unknown> = {
      status: 'completed',
      runnerId: 'runner-1',
      issueUrls,
    };
    const fittedTight = fitStatusPayload(tightPayload, 120);
    assert.ok(Buffer.byteLength(JSON.stringify(fittedTight), 'utf8') <= 120);
    assert.deepEqual(issueUrls, originalUrls, 'caller issueUrls must not be mutated in place');
  });

  it('Bug 10: runStreamedCommand flushes trailing decoder bytes before constructing commandError', async () => {
    const { dir, cleanup } = makeTempDir('runner_bug10_decoder_');
    const { task, db } = enqueueTask(dir, { pushBranch: false, autoCreatePr: false });

    try {
      const { spawnFn } = recordSpawn((call) => {
        setImmediate(() => {
          // Emit an incomplete 2-byte UTF-8 lead byte (0xc3) on stderr, then close with exit 1.
          // StringDecoder buffers 0xc3 until .end(), which flushes U+FFFD (\ufffd).
          call.child.stderr.emit('data', Buffer.from([0x65, 0x72, 0x72, 0xc3]));
          call.child.emit('close', 1, null);
        });
      });

      const executor = new TaskExecutor({
        agyBinPath: 'agy',
        dirExistsFn: () => true,
        spawnFn,
        killProcessTreeFn: async () => {},
        execFileFn: createWorkspaceExecFile({ status: () => '', revList: () => '0\n' }).execFileFn,
      });

      const result = await executor.execute(task);
      assert.equal(result.success, false);
      assert.ok(
        result.output.includes('err\ufffd') || (result.error ?? '').includes('err\ufffd'),
        'flushed UTF-8 tail must appear in the command error / output'
      );
    } finally {
      db.close();
      cleanup();
    }
  });
});
