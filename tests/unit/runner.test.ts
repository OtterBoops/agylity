import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { makeTempDir } from '../e2e/harness/index.js';
import { createLogger } from '../../src/logs/logger.js';
import { AppDatabase } from '../../src/storage/db.js';
import { TaskQueue, type SwarmTask } from '../../src/coordinator/queue.js';
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

const TELEMETRY_LINE = '{"num_turns":4,"usage":{"total_tokens":1234,"thinking_tokens":321}}';

describe('Unit Tests: Runner telemetry preservation (Workstream 2)', () => {
  /* ==================================================================== */
  /* 1. Zero-diff execute() keeps the agy telemetry it already captured    */
  /* ==================================================================== */
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
        assert.equal(result.branchName, undefined);
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
  });

  /* ==================================================================== */
  /* 2. parseAgyTelemetry line handling                                   */
  /* ==================================================================== */
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
    if (cmd === 'diff' && args[1] === '--stat')
      return { stdout: options.diffStat ?? '', stderr: '' };
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

  it('pushes the branch and reports the pull request URL the CLI printed', async () => {
    const { result, exec } = await runWithWorkspace(
      {},
      { onGh: () => 'https://github.com/OtterBoops/agylity/pull/42\n' }
    );

    assert.equal(result.success, true);
    assert.equal(result.prUrl, 'https://github.com/OtterBoops/agylity/pull/42');
    assert.equal(exec.pushed(), true);
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

  it('reports a rejected push as a failed run and names the missing credential', async () => {
    const previous = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
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
      assert.match(String(result.error), /no GITHUB_TOKEN set/);
    } finally {
      if (previous !== undefined) process.env.GITHUB_TOKEN = previous;
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

  it('suppresses an autonomous branch outright under the none policy', async () => {
    const { result, exec } = await runWithWorkspace({ tier: 'routine', prPolicy: 'none' });

    assert.equal(result.success, true);
    assert.equal(result.noChanges, true);
    assert.match(String(result.output), /PR policy is 'none'/);
    assert.equal(exec.pushed(), false);
    assert.equal(exec.has('-D'), true);
  });

  it('never applies the autonomous policy to an immediate dispatch', async () => {
    const { result, exec } = await runWithWorkspace({ prPolicy: 'none' });

    assert.equal(result.success, true);
    assert.equal(result.noChanges, undefined);
    assert.equal(exec.pushed(), true);
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
