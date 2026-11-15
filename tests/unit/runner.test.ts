import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { makeTempDir } from '../e2e/harness/index.js';
import { AppDatabase } from '../../src/storage/db.js';
import { TaskQueue, type SwarmTask } from '../../src/coordinator/queue.js';
import {
  TaskExecutor,
  isCapacityExhaustedOutput,
  parseAgyTelemetry,
  sumAgyTelemetry,
  type SpawnFn,
} from '../../src/coordinator/runner.js';

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
          model: 'gemini-4-argon',
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
        assert.ok(result.branchName.startsWith('agy/'));
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
    model: 'gemini-4-argon',
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
      model: 'gemini-4-argon',
      candidateModels: ['gemini-3.8-flash'],
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
      assert.equal(modelOf(calls[1]), 'gemini-3.8-flash');
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
      model: 'gemini-4-argon',
      candidateModels: ['gemini-3.8-flash'],
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
      assert.equal(modelOf(calls[1]), 'gemini-3.8-flash');
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
      model: 'gemini-4-argon',
      candidateModels: ['gemini-3.8-flash'],
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
      model: 'gemini-4-argon',
      candidateModels: ['gemini-3.8-flash'],
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
