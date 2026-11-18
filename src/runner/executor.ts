import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultExecFileAsync, type ExecFileAsyncFn } from '../sentry/discovery.js';
import { logger, type Logger } from '../logs/logger.js';
import type { SwarmTask, TaskStatusPatch } from '../coordinator/queue.js';
import {
  normalizeCascade,
  resolveReasoningEffortForModel,
  type CascadeHop,
} from '../coordinator/models.js';
import type { PrPolicy } from '../config/schema.js';
import { buildGitAuthArgs, redactGitSecrets } from './git.js';
import {
  ALLOWED_TEST_RUNNERS,
  INLINE_CODE_FLAGS,
  buildContinuationBranchName,
  isDocumentationFile,
  normalizePrPolicy,
} from './policy.js';

export interface TaskExecutorOptions {
  agyBinPath?: string;
  timeoutMs?: number;
  execFileFn?: ExecFileAsyncFn;
  spawnFn?: SpawnFn;
  killProcessTreeFn?: (pid: number) => Promise<void>;
  dirExistsFn?: (dirPath: string) => boolean;
  logger?: Logger;
  prPolicy?: PrPolicy;
  onStatusUpdate?: (patch: TaskStatusPatch & { message?: string }) => Promise<void> | void;
  /** Upstream capacity exhaustion fails over along this chain, which must carry the whole viable chain. */
  cascade?: CascadeHop[];
  mirrorCacheDir?: string;
  useMirrorCache?: boolean;
}

export interface TaskExecuteOptions {
  signal?: AbortSignal;
  onOutput?: (tail: string) => void;
}

export type SpawnFn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface TaskExecutionResult {
  success: boolean;
  noChanges?: boolean;
  branchName?: string;
  prUrl?: string;
  output: string;
  error?: string;
  durationMs: number;
  numTurns?: number;
  totalTokens?: number;
  thinkingTokens?: number;
}

export interface TaskExecutionTelemetry {
  conversationId?: string;
  numTurns?: number;
  totalTokens?: number;
  thinkingTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

const finiteNumber = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

// Tolerates non-JSON lines: `agy` interleaves human-readable output with the NDJSON telemetry.
export const parseAgyTelemetry = (stdout?: string): TaskExecutionTelemetry => {
  if (!stdout || !stdout.trim()) return {};
  const telemetry: TaskExecutionTelemetry = {};

  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.conversation_id && !telemetry.conversationId) {
        telemetry.conversationId = String(parsed.conversation_id);
      }
      if (parsed.num_turns !== undefined && telemetry.numTurns === undefined) {
        telemetry.numTurns = finiteNumber(parsed.num_turns);
      } else if (parsed.turns !== undefined && telemetry.numTurns === undefined) {
        telemetry.numTurns = finiteNumber(parsed.turns);
      }

      const usage = parsed.usage || parsed.token_usage;
      if (usage && typeof usage === 'object') {
        if (usage.input_tokens !== undefined && telemetry.inputTokens === undefined) {
          telemetry.inputTokens = finiteNumber(usage.input_tokens);
        }
        if (usage.output_tokens !== undefined && telemetry.outputTokens === undefined) {
          telemetry.outputTokens = finiteNumber(usage.output_tokens);
        }
        if (usage.thinking_tokens !== undefined && telemetry.thinkingTokens === undefined) {
          telemetry.thinkingTokens = finiteNumber(usage.thinking_tokens);
        }
        if (usage.total_tokens !== undefined && telemetry.totalTokens === undefined) {
          telemetry.totalTokens = finiteNumber(usage.total_tokens);
        }
      }
      if (parsed.total_tokens !== undefined && telemetry.totalTokens === undefined) {
        telemetry.totalTokens = finiteNumber(parsed.total_tokens);
      }
    } catch {}
  }

  if (telemetry.totalTokens === undefined && telemetry.inputTokens !== undefined) {
    telemetry.totalTokens = (telemetry.inputTokens || 0) + (telemetry.outputTokens || 0);
  }

  return telemetry;
};

const STREAM_TAIL_BYTES = 16384;
const STREAM_EMIT_INTERVAL_MS = 1000;
const STREAM_EMIT_BYTES = 4096;
const KILL_GRACE_MS = 2000;
const KILL_POLL_MS = 100;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const commandError = (
  message: string,
  detail: { stdout?: string; stderr?: string; code?: number | null; signal?: string | null } = {}
): Error => Object.assign(new Error(message), detail);

export const isCapacityExhaustedOutput = (text: string | undefined): boolean => {
  if (!text) return false;
  const normalized = text.toLowerCase().replace(/[_-]+/g, ' ');
  if (/(^|[^0-9])429([^0-9]|$)/.test(normalized)) return true;
  return (
    normalized.includes('model capacity exhausted') ||
    normalized.includes('resource exhausted') ||
    normalized.includes('capacity exhausted') ||
    normalized.includes('too many requests') ||
    normalized.includes('overloaded')
  );
};

export interface CapacityContinuationContext {
  failedModel: string;
  statusShort: string;
  diffStat: string;
  tail: string;
  originalPrompt: string;
}

export const buildCapacityContinuationPrompt = (ctx: CapacityContinuationContext): string =>
  [
    '[CONTINUATION CONTEXT]',
    `A previous attempt with model ${ctx.failedModel} was interrupted by upstream capacity exhaustion after making partial progress. Do not redo completed work; finish the remaining work.`,
    '',
    'Current git status:',
    ctx.statusShort || '(clean)',
    '',
    'Diff summary:',
    ctx.diffStat || '(no diff)',
    '',
    'Tail of the interrupted output:',
    ctx.tail.slice(-2000),
    '',
    'Original task:',
    ctx.originalPrompt,
  ].join('\n');

const hasTelemetryValues = (telemetry: TaskExecutionTelemetry): boolean =>
  telemetry.numTurns !== undefined ||
  telemetry.totalTokens !== undefined ||
  telemetry.thinkingTokens !== undefined;

export const sumAgyTelemetry = (attempts: TaskExecutionTelemetry[]): TaskExecutionTelemetry => {
  const sumOf = (key: 'numTurns' | 'totalTokens' | 'thinkingTokens'): number | undefined => {
    const values = attempts
      .map((attempt) => attempt[key])
      .filter((value): value is number => typeof value === 'number');
    return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  return {
    numTurns: sumOf('numTurns'),
    totalTokens: sumOf('totalTokens'),
    thinkingTokens: sumOf('thinkingTokens'),
  };
};

// The child is a group leader, so its whole process group dies with it, `sh -c` grandchildren too.
export const defaultKillProcessTree = async (pid: number): Promise<void> => {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      try {
        const killer = nodeSpawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.once('close', () => resolve());
        killer.once('error', () => resolve());
      } catch {
        resolve();
      }
    });
    return;
  }

  const groupAlive = (): boolean => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const signalGroup = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {}
  };

  if (!groupAlive()) return;
  signalGroup('SIGTERM');
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline) {
    await delay(KILL_POLL_MS);
    if (!groupAlive()) return;
  }
  signalGroup('SIGKILL');
};

export const spawnFromExecFileFn =
  (execFileFn: ExecFileAsyncFn): SpawnFn =>
  (file, args, options) => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdoutStream = new EventEmitter();
    const stderrStream = new EventEmitter();
    Object.assign(child, {
      pid: undefined,
      stdout: stdoutStream,
      stderr: stderrStream,
      kill: () => true,
    });

    const emitChunk = (stream: EventEmitter, chunk: unknown): void => {
      if (typeof chunk === 'string' && chunk !== '') stream.emit('data', chunk);
    };

    void execFileFn(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      windowsHide: options.windowsHide,
    })
      .then(({ stdout, stderr }) => {
        emitChunk(stdoutStream, stdout);
        emitChunk(stderrStream, stderr);
        child.emit('close', 0, null);
      })
      .catch((err: any) => {
        emitChunk(stdoutStream, err?.stdout);
        emitChunk(stderrStream, err?.stderr);
        child.emit('close', typeof err?.code === 'number' ? err.code : 1, null);
      });

    return child;
  };

export class TaskExecutor {
  private readonly agyBinPath: string;
  private readonly timeoutMs: number;
  private readonly execFileFn: ExecFileAsyncFn;
  private readonly spawnFn: SpawnFn;
  private readonly killProcessTreeFn: (pid: number) => Promise<void>;
  private readonly dirExistsFn: (dirPath: string) => boolean;
  private readonly log: Logger;
  private readonly prPolicy: PrPolicy;
  private readonly cascade?: CascadeHop[];
  private readonly mirrorCacheDir: string;
  private readonly useMirrorCache: boolean;
  private readonly onStatusUpdate?: (
    patch: TaskStatusPatch & { message?: string }
  ) => Promise<void> | void;

  constructor(options: TaskExecutorOptions = {}) {
    this.agyBinPath = options.agyBinPath || 'agy';
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    this.execFileFn = options.execFileFn ?? defaultExecFileAsync;
    this.spawnFn =
      options.spawnFn ?? (options.execFileFn ? spawnFromExecFileFn(options.execFileFn) : nodeSpawn);
    this.killProcessTreeFn = options.killProcessTreeFn ?? defaultKillProcessTree;
    this.dirExistsFn = options.dirExistsFn ?? existsSync;
    this.log = options.logger ?? logger.child('runner');
    this.prPolicy =
      normalizePrPolicy(options.prPolicy) ?? normalizePrPolicy(process.env.PR_POLICY) ?? 'all';
    this.cascade = options.cascade;
    this.mirrorCacheDir = options.mirrorCacheDir ?? path.join(os.tmpdir(), 'agylity-repo-mirrors');
    this.useMirrorCache = options.useMirrorCache !== false;
    this.onStatusUpdate = options.onStatusUpdate;
  }

  private async killTree(child: ChildProcess): Promise<void> {
    const pid = child.pid;
    if (!pid) return;
    try {
      await this.killProcessTreeFn(pid);
    } catch (err: any) {
      this.log.debug('Failed to kill process tree %s: %s', pid, err?.message ?? err);
    }
  }

  private async runStreamedCommand(
    file: string,
    args: readonly string[],
    options: {
      cwd: string;
      timeoutMs: number;
      env?: NodeJS.ProcessEnv;
      signal?: AbortSignal | undefined;
      onOutput?: ((tail: string) => void) | undefined;
    }
  ): Promise<{ stdout: string; stderr: string }> {
    const signal = options.signal;
    if (signal?.aborted) {
      throw commandError(`Command aborted before start: ${file}`);
    }

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let tail = '';
    let pendingEmit = 0;
    let lastEmitMs = Date.now();

    let child: ChildProcess;
    try {
      child = this.spawnFn(file, args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.env,
          // Windows only: agy's update check flashes a console window there.
          ...(process.platform === 'win32' ? { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (err: any) {
      throw commandError(`Failed to start ${file}: ${err?.message ?? err}`);
    }

    return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let killPromise: Promise<void> | null = null;

      const ensureKilled = (): Promise<void> => {
        killPromise ??= this.killTree(child);
        return killPromise;
      };

      const flushOutput = (): void => {
        if (!options.onOutput || pendingEmit <= 0) return;
        pendingEmit = 0;
        try {
          options.onOutput(tail);
        } catch {
          // A dead heartbeat must not fail the run.
        }
      };

      const cleanup = (): void => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        signal?.removeEventListener('abort', onAbort);
      };

      const settle = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        flushOutput();
        const stdout = stdoutChunks.join('');
        const stderr = stderrChunks.join('');
        void ensureKilled().then(() => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      };

      const appendChunk = (chunk: unknown, sink: string[]): void => {
        const text =
          typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
        if (!text) return;
        sink.push(text);
        tail = (tail + text).slice(-STREAM_TAIL_BYTES);
        pendingEmit += text.length;
        const now = Date.now();
        if (
          options.onOutput &&
          (pendingEmit >= STREAM_EMIT_BYTES || now - lastEmitMs >= STREAM_EMIT_INTERVAL_MS)
        ) {
          lastEmitMs = now;
          flushOutput();
        }
      };

      const onAbort = (): void => {
        aborted = true;
        void ensureKilled().then(() => {
          settle(
            commandError(`Command aborted: ${file} was killed after the abort signal fired`, {
              stdout: stdoutChunks.join(''),
              stderr: stderrChunks.join(''),
              signal: 'SIGKILL',
            })
          );
        });
      };

      // A non-positive budget means no timeout: setTimeout(0) would kill the child on the next tick.
      const requestedTimeoutMs = Number(options.timeoutMs);
      const timeoutMs =
        Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0 ? requestedTimeoutMs : 0;
      const timeoutTimer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              void ensureKilled().then(() => {
                settle(
                  commandError(`Command timed out after ${timeoutMs}ms: ${file}`, {
                    stdout: stdoutChunks.join(''),
                    stderr: stderrChunks.join(''),
                    code: null,
                    signal: 'SIGKILL',
                  })
                );
              });
            }, timeoutMs)
          : null;

      child.stdout?.on('data', (chunk: Buffer | string) => appendChunk(chunk, stdoutChunks));
      child.stderr?.on('data', (chunk: Buffer | string) => appendChunk(chunk, stderrChunks));

      child.once('error', (err: Error) => {
        settle(commandError(`Failed to run ${file}: ${err?.message ?? err}`));
      });

      child.once('close', (code: number | null, closeSignal: NodeJS.Signals | null) => {
        if (aborted) return;
        if (timedOut) return;
        const stdout = stdoutChunks.join('');
        const stderr = stderrChunks.join('');
        if (code === 0) {
          settle(null);
          return;
        }
        const detail = (stderr.trim() || stdout.trim()).slice(-4000);
        settle(
          commandError(
            `Command failed: ${file} (exit ${code ?? closeSignal ?? 'unknown'})${detail ? `\n${detail}` : ''}`,
            { stdout, stderr, code, signal: closeSignal }
          )
        );
      });

      signal?.addEventListener('abort', onAbort, { once: true });
      // An abort that landed between the entry check and this listener would otherwise never be seen.
      if (signal?.aborted) onAbort();
    });
  }

  private resolveMirrorPath(rawCloneUrl: string): string | null {
    if (!this.useMirrorCache) return null;
    const digest = createHash('sha256').update(rawCloneUrl).digest('hex');
    return path.join(this.mirrorCacheDir, `${digest}.git`);
  }

  private async cloneRepository(rawCloneUrl: string, targetPath: string): Promise<void> {
    const authArgs = buildGitAuthArgs(rawCloneUrl);
    const mirrorPath = this.resolveMirrorPath(rawCloneUrl);

    if (mirrorPath) {
      try {
        await this.syncMirror(rawCloneUrl, mirrorPath, authArgs);
        await this.execFileFn(
          'git',
          [
            ...authArgs,
            'clone',
            '--reference-if-able',
            mirrorPath,
            '--dissociate',
            '--',
            rawCloneUrl,
            targetPath,
          ],
          { timeout: 120000 }
        );
        return;
      } catch (mirrorErr: any) {
        this.log.debug(
          'Mirror reference clone failed for %s; falling back to plain clone: %s',
          rawCloneUrl,
          mirrorErr?.message ?? mirrorErr
        );
        await this.removeCloneTarget(targetPath);
      }
    }

    await this.execFileFn('git', [...authArgs, 'clone', '--', rawCloneUrl, targetPath], {
      timeout: 120000,
    });
  }

  private async syncMirror(
    rawCloneUrl: string,
    mirrorPath: string,
    authArgs: string[]
  ): Promise<void> {
    if (existsSync(path.join(mirrorPath, 'HEAD'))) {
      try {
        await this.execFileFn('git', ['fetch', '--prune'], { cwd: mirrorPath, timeout: 120000 });
      } catch (fetchErr: any) {
        this.log.debug(
          'Mirror fetch failed for %s; using the existing mirror: %s',
          rawCloneUrl,
          fetchErr?.message ?? fetchErr
        );
      }
      return;
    }

    mkdirSync(path.dirname(mirrorPath), { recursive: true });
    try {
      await this.execFileFn(
        'git',
        [...authArgs, 'clone', '--bare', '--', rawCloneUrl, mirrorPath],
        {
          timeout: 180000,
        }
      );
    } catch (bareErr) {
      await this.removeCloneTarget(mirrorPath);
      throw bareErr;
    }
  }

  private async removeCloneTarget(targetPath: string): Promise<void> {
    try {
      await fsPromises.rm(targetPath, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 150,
      });
    } catch (rmErr: any) {
      this.log.debug(
        'Failed to remove partial clone at %s: %s',
        targetPath,
        rmErr?.message ?? rmErr
      );
    }
  }

  private async inspectPartialWork(
    cwd: string,
    baseBranch: string
  ): Promise<{ dirty: boolean; statusShort: string; diffStat: string }> {
    let statusShort = '';
    let diffStat = '';
    let aheadOfBase = 0;

    try {
      const { stdout } = await this.execFileFn('git', ['status', '--porcelain'], {
        cwd,
        timeout: 15000,
      });
      // Trailing whitespace only: the porcelain leading column is meaningful to the next model.
      statusShort = stdout.replace(/\s+$/, '');
    } catch {}

    try {
      const { stdout } = await this.execFileFn(
        'git',
        ['rev-list', '--count', `${baseBranch}..HEAD`],
        { cwd, timeout: 10000 }
      );
      aheadOfBase = parseInt(stdout.trim(), 10) || 0;
    } catch {}

    const dirty = statusShort !== '' || aheadOfBase > 0;
    if (dirty) {
      try {
        const { stdout } = await this.execFileFn('git', ['diff', '--stat'], {
          cwd,
          timeout: 15000,
        });
        diffStat = stdout.trim();
      } catch {}
    }

    return { dirty, statusShort, diffStat };
  }

  private pickNextCandidateHop(
    task: SwarmTask,
    failedModel: string,
    attempted: Set<string>
  ): CascadeHop | undefined {
    const chain = normalizeCascade(
      task.cascade?.length ? task.cascade : (this.cascade ?? []),
      failedModel
    );
    const failedIndex = chain.findIndex((hop) => hop.model === failedModel);
    const ordered =
      failedIndex === -1
        ? chain
        : [...chain.slice(failedIndex + 1), ...chain.slice(0, failedIndex)];
    return ordered.find((hop) => hop.model !== failedModel && !attempted.has(hop.model));
  }

  private failureResult(
    branchName: string,
    startMs: number,
    error: string,
    output = ''
  ): TaskExecutionResult {
    return { success: false, branchName, output, error, durationMs: Date.now() - startMs };
  }

  private telemetryFields(
    telemetry: TaskExecutionTelemetry
  ): Pick<TaskExecutionResult, 'numTurns' | 'totalTokens' | 'thinkingTokens'> {
    return {
      numTurns: telemetry.numTurns,
      totalTokens: telemetry.totalTokens,
      thinkingTokens: telemetry.thinkingTokens,
    };
  }

  /** Clones the task repository into place, or returns the failure that replaces the whole run. */
  private async ensureRepository(
    task: SwarmTask,
    branchName: string,
    startMs: number
  ): Promise<TaskExecutionResult | null> {
    if (this.dirExistsFn(task.repositoryPath)) return null;

    const cloneUrl = task.cloneUrl?.trim() ?? '';
    if (!cloneUrl) {
      const errMsg = `Target repository directory does not exist: ${task.repositoryPath} (and no cloneUrl configured)`;
      this.log.error(errMsg);
      return this.failureResult(branchName, startMs, errMsg);
    }

    try {
      await this.onStatusUpdate?.({
        status: 'executing',
        branchName,
        message: `Cloning repository from ${cloneUrl} into ${task.repositoryPath}`,
      });
      mkdirSync(path.dirname(task.repositoryPath), { recursive: true });
      await this.cloneRepository(cloneUrl, task.repositoryPath);
      return null;
    } catch (cloneErr: any) {
      // A half-written clone must not survive: the next run would see the directory and skip cloning.
      await this.removeCloneTarget(task.repositoryPath);
      const errMsg = `Failed to clone repository from ${cloneUrl}: ${redactGitSecrets(
        cloneErr?.message || String(cloneErr)
      )}`;
      this.log.error(errMsg);
      return this.failureResult(branchName, startMs, errMsg);
    }
  }

  /**
   * Returns the working copy to the base branch and cuts the task branch off it.
   *
   * `/repos/<id>` can be a real working copy, so uncommitted state is stashed, never discarded, and
   * the task branch is still created when the fast-forward fails, since an unreachable remote must
   * not cancel a run that could otherwise succeed.
   */
  private async prepareBranch(
    task: SwarmTask,
    branchName: string,
    baseBranch: string
  ): Promise<void> {
    const cwd = task.repositoryPath;
    try {
      const { stdout: dirtyOut } = await this.execFileFn('git', ['status', '--porcelain'], {
        cwd,
        timeout: 15000,
      });
      if (dirtyOut && dirtyOut.trim() !== '') {
        const { stdout: stashOut } = await this.execFileFn(
          'git',
          ['stash', 'push', '--include-untracked', '-m', `agylity ${task.id}`],
          { cwd, timeout: 30000 }
        );
        this.log.warn(
          'Stashed uncommitted changes in %s before task %s as "%s"; the stash is never popped automatically',
          cwd,
          task.id,
          (stashOut ?? '').trim() || `agylity ${task.id}`
        );
      }
      await this.execFileFn('git', ['checkout', baseBranch], { cwd, timeout: 30000 });
      try {
        const gitPullArgs = [...buildGitAuthArgs(task.cloneUrl), 'pull', '--ff-only'];
        await this.execFileFn('git', gitPullArgs, { cwd, timeout: 30000 });
      } catch (pullErr: unknown) {
        this.log.warn(
          'Fast-forward pull on %s failed before task %s (branching from local %s): %s',
          baseBranch,
          task.id,
          baseBranch,
          redactGitSecrets(pullErr instanceof Error ? pullErr.message : String(pullErr))
        );
      }
    } catch (baseCheckoutErr: unknown) {
      this.log.debug(
        'Base branch checkout (%s) skipped before creating %s: %s',
        baseBranch,
        branchName,
        baseCheckoutErr instanceof Error ? baseCheckoutErr.message : String(baseCheckoutErr)
      );
    }

    await this.execFileFn('git', ['checkout', '-B', branchName], { cwd, timeout: 30000 });
  }

  private buildPrompt(
    task: SwarmTask,
    prPolicy: PrPolicy,
    tierLabel: string,
    effort: CascadeHop['effort']
  ): { prompt: string; policySuffix: string; attributionSuffix: string } {
    const policySuffix =
      prPolicy === 'issues_only'
        ? `\n\n[Policy: Issues Only — Do NOT modify repository files, push branches, or open pull requests. Report findings and proposed fixes as GitHub Issues only.]`
        : '';
    const attributionSuffix = `\n\n[Instruction: If you create or edit any GitHub PR or Issue description directly, keep it minimal: simply append a footer: "---\n*Dispatched via Agylity (${tierLabel}) with \`${task.model}\` (${effort} reasoning) — please review carefully.*". Never mention runner hostnames, internal server paths, or worker IDs.]`;
    return {
      prompt: `${task.prompt}${policySuffix}${attributionSuffix}`,
      policySuffix,
      attributionSuffix,
    };
  }

  /**
   * Runs the agent, failing over along the cascade while upstream reports capacity exhaustion.
   *
   * Only capacity exhaustion fails over: every other error ends the run on the attempt that
   * produced it, because a second model would burn quota on the same broken task.
   */
  private async runAgentWithCascade(
    task: SwarmTask,
    context: {
      cwd: string;
      branchName: string;
      baseBranch: string;
      prompt: string;
      policySuffix: string;
      attributionSuffix: string;
      primaryHop: CascadeHop;
      signal?: AbortSignal | undefined;
      onOutput?: ((tail: string) => void) | undefined;
    }
  ): Promise<{
    output: string;
    lastStdout: string;
    telemetry: TaskExecutionTelemetry;
    failure: unknown;
  }> {
    const { cwd, branchName, baseBranch, prompt, policySuffix, attributionSuffix } = context;
    const attemptTelemetry: TaskExecutionTelemetry[] = [];
    const attemptedModels = new Set<string>([context.primaryHop.model]);
    let attemptHop = context.primaryHop;
    let attemptPrompt = prompt;
    let output = '';
    let lastStdout = '';
    let failure: unknown = null;

    for (;;) {
      const attemptModel = attemptHop.model;
      const attemptEffort = resolveReasoningEffortForModel(attemptHop.model, attemptHop.effort);
      // Unprivileged containers reject agy's nested Linux namespace sandbox with EPERM on fork/exec.
      const agyArgs: string[] = [
        '-p',
        attemptPrompt,
        '--mode',
        'auto',
        '--dangerously-skip-permissions',
        '--settings',
        '{"enableTerminalSandbox":false}',
        '--model',
        attemptModel,
        '--effort',
        attemptEffort,
      ];

      this.log.info(
        'Executing agy task %s in %s on branch %s (model=%s, effort=%s)',
        task.id,
        cwd,
        branchName,
        attemptModel,
        attemptEffort
      );

      try {
        const streamed = await this.runStreamedCommand(this.agyBinPath, agyArgs, {
          cwd,
          timeoutMs: this.timeoutMs,
          signal: context.signal,
          onOutput: context.onOutput,
        });
        lastStdout = streamed.stdout || '';
        output = [streamed.stdout?.trim(), streamed.stderr?.trim()].filter(Boolean).join('\n');
        attemptTelemetry.push(parseAgyTelemetry(lastStdout));
        failure = null;
        break;
      } catch (agyErr: any) {
        lastStdout = agyErr?.stdout || '';
        const attemptOutput = [agyErr?.stdout?.trim(), agyErr?.stderr?.trim()]
          .filter(Boolean)
          .join('\n');
        output = attemptOutput;
        attemptTelemetry.push(parseAgyTelemetry(lastStdout));
        failure = agyErr;

        const failureText = [attemptOutput, agyErr?.message ?? ''].filter(Boolean).join('\n');
        if (context.signal?.aborted || !isCapacityExhaustedOutput(failureText)) break;

        const nextHop = this.pickNextCandidateHop(task, attemptHop.model, attemptedModels);
        if (!nextHop) {
          this.log.warn(
            'Model %s exhausted capacity and no untried hop remains for task %s',
            attemptHop.model,
            task.id
          );
          break;
        }

        attemptedModels.add(nextHop.model);
        const partial = await this.inspectPartialWork(cwd, baseBranch);
        this.log.warn(
          'Model %s (effort=%s) hit capacity exhaustion; falling back to %s (effort=%s, %s) for task %s',
          attemptHop.model,
          attemptEffort,
          nextHop.model,
          nextHop.effort,
          partial.dirty ? 'continuation handoff' : 'clean retry',
          task.id
        );

        // The policy and attribution suffixes are part of the brief, so a handoff prompt keeps them.
        attemptPrompt = partial.dirty
          ? `${buildCapacityContinuationPrompt({
              failedModel: attemptHop.model,
              statusShort: partial.statusShort,
              diffStat: partial.diffStat,
              tail: attemptOutput,
              originalPrompt: task.prompt,
            })}${policySuffix}${attributionSuffix}`
          : prompt;
        attemptHop = nextHop;
      }
    }

    return { output, lastStdout, telemetry: sumAgyTelemetry(attemptTelemetry), failure };
  }

  /** Runs the task's verification command, which must be a bare invocation of an approved runner. */
  private async runVerification(
    verifyCommand: string,
    cwd: string,
    signal?: AbortSignal
  ): Promise<void> {
    const trimmed = verifyCommand.trim();
    if (/[;&|`$><\r\n]/.test(trimmed)) {
      throw new Error('Verification command contains illegal shell metacharacters');
    }

    const [cmd, ...cmdArgs] = trimmed.split(/\s+/);
    if (!cmd || !ALLOWED_TEST_RUNNERS.has(cmd)) {
      throw new Error(
        `Verification command '${cmd ?? ''}' is not in approved test runner allowlist (${Array.from(
          ALLOWED_TEST_RUNNERS
        ).join(', ')})`
      );
    }
    if (cmdArgs.some((arg) => INLINE_CODE_FLAGS.has(arg))) {
      throw new Error('Verification command must not use an inline-code flag (-e/--eval/-c)');
    }

    try {
      await this.runStreamedCommand(cmd, cmdArgs, { cwd, timeoutMs: VERIFY_TIMEOUT_MS, signal });
    } catch (verifyErr: any) {
      const message =
        verifyErr?.stderr?.trim() ||
        verifyErr?.stdout?.trim() ||
        verifyErr?.message ||
        String(verifyErr);
      throw new Error(`Verification command failed (${trimmed}): ${message}`);
    }
  }

  /** Commits whatever the agent left behind, or reports that the branch holds no work. */
  private async commitWorkingTree(
    task: SwarmTask,
    branchName: string,
    baseBranch: string
  ): Promise<boolean> {
    const cwd = task.repositoryPath;
    let committed = false;

    try {
      const { stdout: statusOut } = await this.execFileFn('git', ['status', '--porcelain'], {
        cwd,
        timeout: 15000,
      });
      if (statusOut && statusOut.trim() !== '') {
        await this.execFileFn('git', ['add', '-A'], { cwd, timeout: 15000 });
        const authorName = process.env.GIT_AUTHOR_NAME || task.requestedBy || 'User';
        const authorEmail = process.env.GIT_AUTHOR_EMAIL || 'user@users.noreply.github.com';
        await this.execFileFn(
          'git',
          ['commit', '-m', `Complete Antigravity continuation task ${task.id}`],
          {
            cwd,
            timeout: 30000,
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: authorName,
              GIT_AUTHOR_EMAIL: authorEmail,
              GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || authorName,
              GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || authorEmail,
            },
          }
        );
        committed = true;
      }
    } catch (commitErr: any) {
      this.log.warn(
        'Failed to commit working tree changes on %s: %s',
        branchName,
        commitErr?.message ?? commitErr
      );
    }

    if (committed) return true;

    try {
      const { stdout: revCount } = await this.execFileFn(
        'git',
        ['rev-list', '--count', `${baseBranch}..HEAD`],
        { cwd, timeout: 10000 }
      );
      return parseInt(revCount.trim(), 10) > 0;
    } catch {
      return false;
    }
  }

  /** Leaves the working copy on the base branch and drops the task branch. */
  private async discardBranch(cwd: string, baseBranch: string, branchName: string): Promise<void> {
    try {
      await this.execFileFn('git', ['checkout', baseBranch], { cwd, timeout: 15000 });
      await this.execFileFn('git', ['branch', '-D', branchName], { cwd, timeout: 15000 });
    } catch {}
  }

  /** Returns the failure message for a rejected push, or null once the branch is upstream. */
  private async pushTaskBranch(task: SwarmTask, branchName: string): Promise<string | null> {
    try {
      const gitPushArgs = [...buildGitAuthArgs(task.cloneUrl), 'push', '-u', 'origin', branchName];
      await this.execFileFn('git', gitPushArgs, {
        cwd: task.repositoryPath,
        timeout: 60000,
      });
      return null;
    } catch (gitPushErr: any) {
      const pushErrMsg = redactGitSecrets(gitPushErr?.message ?? String(gitPushErr));
      this.log.error('Git push failed on %s: %s', branchName, pushErrMsg);
      return !process.env.GITHUB_TOKEN?.trim()
        ? `Git push to origin/${branchName} failed: ${pushErrMsg} (this runner has no GITHUB_TOKEN set)`
        : `Git push to origin/${branchName} failed: ${pushErrMsg}`;
    }
  }

  /** Opens the pull request for a pushed branch, returning its URL when one was reported. */
  private async openPullRequest(
    task: SwarmTask,
    branchName: string,
    baseBranch: string,
    effort: string
  ): Promise<string | undefined> {
    try {
      const tierLabel = task.tier || 'immediate';
      const prBody = [
        task.prompt,
        '',
        '---',
        `*Dispatched via Agylity (${tierLabel}) with \`${task.model}\` (${effort} reasoning) — please review carefully.*`,
      ].join('\n');

      const { stdout: prOut } = await this.execFileFn(
        'gh',
        [
          'pr',
          'create',
          '--base',
          baseBranch,
          '--head',
          branchName,
          '--title',
          `[Agylity] Task ${task.id}: ${task.prompt.slice(0, 70)}`,
          '--body',
          prBody,
        ],
        {
          cwd: task.repositoryPath,
          timeout: 30000,
          env: {
            ...process.env,
            GITHUB_TOKEN: process.env.GITHUB_TOKEN?.trim() || '',
          },
        }
      );
      const match = prOut.match(/https:\/\/github\.com\/[^\s]+/);
      if (!match) return undefined;
      this.log.info('Created pull request for %s: %s', branchName, match[0]);
      return match[0].trim();
    } catch (prErr: any) {
      this.log.warn('Auto PR creation failed for %s: %s', branchName, prErr?.message ?? prErr);
      return undefined;
    }
  }

  /**
   * Applies the autonomous PR policy to a finished branch.
   *
   * Returns the terminal result when the policy suppresses the branch, or null when the branch may
   * be pushed. An immediate dispatch is a human asking for exactly this work, so it is never policed.
   */
  private async applyPrPolicy(
    task: SwarmTask,
    context: {
      branchName: string;
      baseBranch: string;
      output: string;
      prPolicy: PrPolicy;
      telemetry: TaskExecutionTelemetry;
      startMs: number;
    }
  ): Promise<TaskExecutionResult | null> {
    const { branchName, baseBranch, output, prPolicy, telemetry, startMs } = context;
    if (task.tier === 'immediate') return null;

    const suppress = async (detail: string): Promise<TaskExecutionResult> => {
      await this.discardBranch(task.repositoryPath, baseBranch, branchName);
      return {
        success: true,
        noChanges: true,
        branchName: undefined,
        output: `${output}\n\n${detail}`,
        durationMs: Date.now() - startMs,
        ...this.telemetryFields(telemetry),
      };
    };

    if (prPolicy === 'none' || prPolicy === 'issues_only') {
      const policyGuardMsg =
        prPolicy === 'issues_only'
          ? "[Policy Guard] Autonomous PR suppressed: PR policy is 'issues_only' (no code changes or PRs allowed; report findings as GitHub Issues)."
          : "[Policy Guard] Autonomous PR suppressed: PR policy is 'none'.";
      this.log.info(
        'Autonomous PR policy is "%s": suppressing branch push and PR creation for task %s on %s',
        prPolicy,
        task.id,
        branchName
      );
      return suppress(policyGuardMsg);
    }

    if (prPolicy !== 'docs_only') return null;

    let nonDocFiles: string[] = [];
    try {
      const { stdout: diffOut } = await this.execFileFn(
        'git',
        ['diff', '--name-only', `${baseBranch}..HEAD`],
        { cwd: task.repositoryPath, timeout: 15000 }
      );
      nonDocFiles = diffOut
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((file) => !isDocumentationFile(file));
    } catch (diffErr: any) {
      this.log.warn(
        'Failed to inspect commit diff for bot policy check on %s: %s',
        branchName,
        diffErr?.message ?? diffErr
      );
    }

    if (nonDocFiles.length === 0) return null;

    this.log.info(
      'Autonomous PR policy "docs_only" blocked PR for task %s on %s (non-doc files modified: %s)',
      task.id,
      branchName,
      nonDocFiles.join(', ')
    );
    return suppress(
      `[Policy Guard] Autonomous PR suppressed: PR policy is 'docs_only', so only documentation changes ship. Code modifications must be submitted as GitHub Issues.\nNon-doc files modified: ${nonDocFiles.join(', ')}`
    );
  }

  public async execute(
    task: SwarmTask,
    options: TaskExecuteOptions = {}
  ): Promise<TaskExecutionResult> {
    const startMs = Date.now();
    const branchName = task.branchName || buildContinuationBranchName(task.id, task.prompt);

    if (branchName === 'main' || branchName === 'master') {
      return this.failureResult(
        branchName,
        startMs,
        'Branch isolation invariant violation: refusing to execute directly on main/master'
      );
    }

    const repositoryFailure = await this.ensureRepository(task, branchName, startMs);
    if (repositoryFailure) return repositoryFailure;

    const cwd = task.repositoryPath;
    const baseBranch = (task.defaultBranch || 'main').trim() || 'main';
    let capturedOutput = '';
    let capturedTelemetryRaw = '';
    let telemetry: TaskExecutionTelemetry = {};

    try {
      await this.onStatusUpdate?.({
        status: 'executing',
        branchName,
        message: `Checking out isolated branch ${branchName} (from ${baseBranch}) and launching agy (${task.model})`,
      });

      await this.prepareBranch(task, branchName, baseBranch);

      const primaryHop: CascadeHop = {
        model: task.model,
        effort: resolveReasoningEffortForModel(task.model, task.effort),
      };
      const tierLabel = task.tier || 'immediate';
      const effectivePrPolicy: PrPolicy =
        normalizePrPolicy(task.prPolicy) ?? this.prPolicy ?? 'all';
      const { prompt, policySuffix, attributionSuffix } = this.buildPrompt(
        task,
        effectivePrPolicy,
        tierLabel,
        primaryHop.effort
      );

      const agent = await this.runAgentWithCascade(task, {
        cwd,
        branchName,
        baseBranch,
        prompt,
        policySuffix,
        attributionSuffix,
        primaryHop,
        signal: options.signal,
        onOutput: options.onOutput,
      });
      capturedOutput = agent.output;
      capturedTelemetryRaw = agent.lastStdout;
      telemetry = agent.telemetry;
      if (agent.failure) throw agent.failure;

      if (task.verifyCommand && task.verifyCommand.trim() !== '') {
        await this.runVerification(task.verifyCommand, cwd, options.signal);
      }

      const commitsProduced = await this.commitWorkingTree(task, branchName, baseBranch);
      if (!commitsProduced) {
        await this.discardBranch(cwd, baseBranch, branchName);
        this.log.info(
          'Zero diff produced for task %s; cleaned up local branch %s',
          task.id,
          branchName
        );
        return {
          success: true,
          noChanges: true,
          branchName: undefined,
          output: capturedOutput,
          durationMs: Date.now() - startMs,
          ...this.telemetryFields(telemetry),
        };
      }

      const suppression = await this.applyPrPolicy(task, {
        branchName,
        baseBranch,
        output: capturedOutput,
        prPolicy: effectivePrPolicy,
        telemetry,
        startMs,
      });
      if (suppression) return suppression;

      let prUrl: string | undefined;
      if (task.pushBranch) {
        const pushError = await this.pushTaskBranch(task, branchName);
        if (pushError) {
          return {
            success: false,
            branchName,
            output: capturedOutput,
            error: pushError,
            durationMs: Date.now() - startMs,
            ...this.telemetryFields(telemetry),
          };
        }

        if (task.autoCreatePr) {
          prUrl = await this.openPullRequest(
            task,
            branchName,
            baseBranch,
            task.effort || primaryHop.effort
          );
        }
      }

      return {
        success: true,
        branchName,
        prUrl,
        output: capturedOutput,
        durationMs: Date.now() - startMs,
        ...this.telemetryFields(telemetry),
      };
    } catch (err: any) {
      const durationMs = Date.now() - startMs;
      const errMessage = err?.stderr?.trim() || err?.message || String(err);
      this.log.error('Task %s execution failed: %s', task.id, errMessage);
      if (err?.stdout || err?.stderr) {
        const extra = [err.stdout?.trim(), err.stderr?.trim()].filter(Boolean).join('\n');
        if (extra && !capturedOutput.includes(extra)) {
          capturedOutput = capturedOutput ? `${capturedOutput}\n\n${extra}` : extra;
        }
      }
      const failureTelemetry = hasTelemetryValues(telemetry)
        ? telemetry
        : parseAgyTelemetry(capturedTelemetryRaw || err?.stdout);
      return {
        success: false,
        branchName,
        output: capturedOutput || err?.stdout?.trim() || '',
        error: errMessage,
        durationMs,
        numTurns: failureTelemetry.numTurns,
        totalTokens: failureTelemetry.totalTokens,
        thinkingTokens: failureTelemetry.thinkingTokens,
      };
    }
  }
}
