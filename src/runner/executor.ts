import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import ky from 'ky';
import { defaultExecFileAsync, type ExecFileAsyncFn } from '../sentry/discovery.js';
import { logger, type Logger } from '../logs/logger.js';
import type { SwarmTask, TaskStatusPatch } from '../coordinator/queue.js';
import {
  modelSupportsEffort,
  normalizeCascade,
  resolveReasoningEffortForModel,
  type CascadeHop,
} from '../coordinator/models.js';
import type { PrPolicy } from '../config/schema.js';
import { resolveTaskTitle } from '../shared/titles.js';
import { resolveGithubRepoSlug } from '../shared/github.js';
import { HEARTBEAT_TAIL_BYTES } from '../shared/contracts.js';
import { AgyStreamFormatter } from './agyStream.js';
import { tailWindow } from '../shared/text.js';
import { stripUntrustedAttribution } from './attribution.js';
import {
  AGYLITY_FOOTER_MARKER,
  AGYLITY_FOOTER_TAIL_RE,
  agylityFooter,
  buildPrompt,
  buildPullRequestBody,
} from './prompt.js';
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
  /** Optional hook for resolving git author identity from a leased GitHub token (overridable in tests). */
  resolveGithubIdentityFn?: (token: string) => Promise<{ name: string; email: string } | undefined>;
}

export interface TaskExecuteOptions {
  signal?: AbortSignal;
  onOutput?: (tail: string) => void;
  /** Leased from the coordinator for this task only; never read from the runner's own environment. */
  githubToken?: string;
  /** The coordinator's configured commit identity, when it has one: dashboard override, then its env. */
  gitIdentity?: { name?: string; email?: string };
}

export type SpawnFn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface TaskExecutionResult {
  success: boolean;
  noChanges?: boolean;
  /** `null` reports that a branch was discarded, which clears the column rather than leaving it. */
  branchName?: string | null;
  prUrl?: string;
  /** GitHub issues filed by the run, which are the deliverable when the branch stayed empty. */
  issueUrls?: string[];
  /** The title the deliverable earned, which the coordinator settles onto the row. */
  resolvedTitle?: string;
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

const ISSUE_DELIVERABLE_LIMIT = 50;
const ISSUE_DELIVERABLE_MAX_URLS = 10;
const finiteNumber = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

// Tolerates non-JSON lines: `agy` interleaves human-readable output with the NDJSON telemetry.
export const parseAgyTelemetry = (stdout?: string): TaskExecutionTelemetry => {
  if (!stdout || !stdout.trim()) return {};
  const telemetry: TaskExecutionTelemetry = {};

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, any>;
      // `stream-json` wraps each payload one level down; a plain JSON line is its own payload.
      const payload: Record<string, any> =
        (parsed.result as Record<string, any>) ??
        (parsed.step_update as Record<string, any>) ??
        parsed;
      // Only the final result carries the run's aggregate usage, so it outranks a step's numbers.
      const aggregated = parsed.event === 'result';
      const take = (key: keyof TaskExecutionTelemetry, value: unknown): void => {
        const numeric = finiteNumber(value);
        if (numeric === undefined) return;
        if (aggregated || telemetry[key] === undefined) {
          (telemetry as Record<string, unknown>)[key] = numeric;
        }
      };

      if (!telemetry.conversationId && typeof payload.conversation_id === 'string') {
        telemetry.conversationId = payload.conversation_id;
      }
      take('numTurns', payload.num_turns ?? payload.turns);

      const usage = (payload.usage ?? payload.token_usage) as Record<string, any> | undefined;
      if (usage && typeof usage === 'object') {
        take('inputTokens', usage.input_tokens);
        take('outputTokens', usage.output_tokens);
        take('thinkingTokens', usage.thinking_tokens);
        take('totalTokens', usage.total_tokens);
      }
      take('totalTokens', payload.total_tokens);
    } catch {}
  }

  if (telemetry.totalTokens === undefined && telemetry.inputTokens !== undefined) {
    telemetry.totalTokens = (telemetry.inputTokens || 0) + (telemetry.outputTokens || 0);
  }

  return telemetry;
};

const STREAM_EMIT_INTERVAL_MS = 1000;
const STREAM_EMIT_BYTES = 4096;
const KILL_GRACE_MS = 2000;
const KILL_POLL_MS = 100;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const combineOutput = (stdout?: string, stderr?: string): string =>
  [stdout?.trim(), stderr?.trim()].filter(Boolean).join('\n');

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

const FLAG_REJECTION_RE =
  /unknown flag|flag provided but not defined|unknown shorthand|invalid argument/i;
const AGY_USAGE_ERROR_MAX_BYTES = 1024;

const scanAgyStdout = (stdout: string): { sawStreamEvent: boolean; status: string } => {
  let sawStreamEvent = false;
  const status: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, any>;
    } catch {
      continue;
    }
    if (typeof parsed.event !== 'string') continue;
    sawStreamEvent = true;
    if (parsed.event !== 'result' || !parsed.result || typeof parsed.result !== 'object') continue;
    for (const key of ['status', 'error', 'state']) {
      const value = parsed.result[key];
      if (typeof value === 'string') status.push(value);
    }
  }
  return { sawStreamEvent, status: status.join('\n') };
};

const capacityFailureSurface = (err: any): string => {
  const stdout = typeof err?.stdout === 'string' ? err.stdout : '';
  const stderr = typeof err?.stderr === 'string' ? err.stderr : '';
  const { sawStreamEvent, status } = scanAgyStdout(stdout);
  // Stream-json stdout is the agent's own narration; only its final result status is the CLI's.
  return [stderr, sawStreamEvent ? status : stdout].filter(Boolean).join('\n');
};

const tokenizeCommand = (value: string): string[] => {
  const tokens: string[] = [];
  let current = '';
  let openQuote: '"' | "'" | null = null;
  let tokenOpen = false;
  for (const char of value) {
    if (openQuote) {
      if (char === openQuote) openQuote = null;
      else current += char;
      tokenOpen = true;
      continue;
    }
    if (char === '"' || char === "'") {
      openQuote = char;
      tokenOpen = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenOpen) {
        tokens.push(current);
        current = '';
        tokenOpen = false;
      }
      continue;
    }
    current += char;
    tokenOpen = true;
  }
  if (openQuote) throw new Error(`Verification command has an unterminated ${openQuote} quote`);
  if (tokenOpen) tokens.push(current);
  return tokens;
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
    tailWindow(ctx.tail, 2000),
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

// Resolves the GitHub token owner's git identity so squash-merges match the repo owner cleanly
// without triggering GitHub's automatic `Co-authored-by:` trailer.
const defaultResolveGithubIdentity = async (
  token: string
): Promise<{ name: string; email: string } | undefined> => {
  try {
    const user = await ky
      .get('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'agylity-runner',
        },
        timeout: 10000,
        retry: 0,
      })
      .json<{ id?: number; login?: string; name?: string | null; email?: string | null }>();
    const login = typeof user.login === 'string' ? user.login.trim() : '';
    const name = (typeof user.name === 'string' ? user.name.trim() : '') || login;
    const explicitEmail = typeof user.email === 'string' ? user.email.trim() : '';
    const noreplyEmail =
      typeof user.id === 'number' && Number.isFinite(user.id) && login
        ? `${user.id}+${login}@users.noreply.github.com`
        : '';
    const email = explicitEmail || noreplyEmail;
    if (!name || !email) return undefined;
    return { name, email };
  } catch {
    return undefined;
  }
};

const BRANCH_REF_FORBIDDEN = /[\s~^:?*\[\\\u0000-\u001f\u007f]/;

// Git's ref rules that matter before one is handed to clone/checkout/push: no leading '-', no control
// characters, no '..', no '@{', and nothing that leaves a dangling path segment.
const isUsableBranchRef = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 255 &&
  !value.startsWith('-') &&
  !value.startsWith('/') &&
  !value.startsWith('.') &&
  !BRANCH_REF_FORBIDDEN.test(value) &&
  !value.includes('..') &&
  !value.includes('@{') &&
  !value.includes('//') &&
  !value.endsWith('/') &&
  !value.endsWith('.') &&
  !value.endsWith('.lock');

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
  private readonly resolveGithubIdentityFn: (
    token: string
  ) => Promise<{ name: string; email: string } | undefined>;
  private readonly githubIdentityCache = new Map<string, { name: string; email: string } | null>();
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
    // Resolved config reaches the executor through options; reading the raw env here would ignore a
    // dashboard override and let an unvalidated value through.
    this.prPolicy = normalizePrPolicy(options.prPolicy) ?? 'all';
    this.cascade = options.cascade;
    this.mirrorCacheDir = options.mirrorCacheDir ?? path.join(os.tmpdir(), 'agylity-repo-mirrors');
    this.useMirrorCache = options.useMirrorCache !== false;
    this.resolveGithubIdentityFn = options.resolveGithubIdentityFn ?? defaultResolveGithubIdentity;
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

  // Stream-json is the only way the pane sees progress mid-run; a binary that rejects the flag
  // still gets its attempt, in text mode.
  private async runAgy(
    args: readonly string[],
    options: {
      cwd: string;
      timeoutMs: number;
      signal?: AbortSignal | undefined;
      onOutput?: ((tail: string) => void) | undefined;
      redactTokens?: readonly (string | undefined)[] | undefined;
      env?: NodeJS.ProcessEnv;
    }
  ): Promise<{ stdout: string; stderr: string; text: string }> {
    const formatter = new AgyStreamFormatter();
    try {
      const streamed = await this.runStreamedCommand(
        this.agyBinPath,
        [...args, '--output-format', 'stream-json'],
        { ...options, streamFormatter: formatter }
      );
      return { ...streamed, text: formatter.text };
    } catch (err: any) {
      const stderr = typeof err?.stderr === 'string' ? err.stderr : '';
      const stdout = typeof err?.stdout === 'string' ? err.stdout : '';
      const rejectedFlag =
        !options.signal?.aborted &&
        !scanAgyStdout(stdout).sawStreamEvent &&
        stderr.length <= AGY_USAGE_ERROR_MAX_BYTES &&
        FLAG_REJECTION_RE.test(stderr);
      if (!rejectedFlag) {
        if (err && typeof err === 'object') (err as any).agyText = formatter.text;
        throw err;
      }
      this.log.warn('agy rejected --output-format stream-json; retrying this attempt in text mode');
      const streamed = await this.runStreamedCommand(this.agyBinPath, args, options);
      return { ...streamed, text: '' };
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
      redactTokens?: readonly (string | undefined)[] | undefined;
      streamFormatter?: AgyStreamFormatter | undefined;
    }
  ): Promise<{ stdout: string; stderr: string }> {
    const signal = options.signal;
    const redactTokens = options.redactTokens ?? [];
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
          // No child of the runner may inherit a credential; the lease is passed explicitly.
          GITHUB_TOKEN: '',
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

      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let decodersFlushed = false;

      const flushDecoders = (): void => {
        if (decodersFlushed) return;
        decodersFlushed = true;
        const stdoutTail = stdoutDecoder.end();
        if (stdoutTail) {
          stdoutChunks.push(stdoutTail);
          const display = options.streamFormatter
            ? options.streamFormatter.feed(stdoutTail)
            : stdoutTail;
          if (display) {
            tail = redactGitSecrets(tailWindow(tail + display, HEARTBEAT_TAIL_BYTES), redactTokens);
            pendingEmit += display.length;
          }
        }
        const formatterTail = options.streamFormatter?.flush() ?? '';
        if (formatterTail) {
          tail = redactGitSecrets(
            tailWindow(tail + formatterTail, HEARTBEAT_TAIL_BYTES),
            redactTokens
          );
          pendingEmit += formatterTail.length;
        }
        const stderrTail = stderrDecoder.end();
        if (stderrTail) {
          stderrChunks.push(stderrTail);
          tail = redactGitSecrets(
            tailWindow(tail + stderrTail, HEARTBEAT_TAIL_BYTES),
            redactTokens
          );
          pendingEmit += stderrTail.length;
        }
      };

      const settle = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        flushDecoders();
        flushOutput();
        const stdout = stdoutChunks.join('');
        const stderr = stderrChunks.join('');
        // A child that exited on its own owns no live tree, so only a forced stop needs the kill.
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }
        void ensureKilled().then(() => reject(error));
      };

      const appendChunk = (chunk: unknown, sink: string[], decoder: StringDecoder): void => {
        const text =
          typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? decoder.write(chunk) : '';
        if (!text) return;
        sink.push(text);
        const display =
          sink === stdoutChunks && options.streamFormatter
            ? options.streamFormatter.feed(text)
            : text;
        tail = redactGitSecrets(tailWindow(tail + display, HEARTBEAT_TAIL_BYTES), redactTokens);
        pendingEmit += display.length;
        const now = Date.now();
        if (
          options.onOutput &&
          (pendingEmit >= STREAM_EMIT_BYTES || now - lastEmitMs >= STREAM_EMIT_INTERVAL_MS)
        ) {
          lastEmitMs = now;
          flushOutput();
        }
      };

      // A forced stop must reap the tree before the error reaches the caller, so both paths wait on it.
      const killAndSettle = (error: Error): void => {
        void ensureKilled().then(() => settle(error));
      };

      const onAbort = (): void => {
        aborted = true;
        flushDecoders();
        killAndSettle(
          commandError(`Command aborted: ${file} was killed after the abort signal fired`, {
            stdout: stdoutChunks.join(''),
            stderr: stderrChunks.join(''),
            signal: 'SIGKILL',
          })
        );
      };

      // A non-positive budget means no timeout: setTimeout(0) would kill the child on the next tick.
      const requestedTimeoutMs = Number(options.timeoutMs);
      const timeoutMs =
        Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0 ? requestedTimeoutMs : 0;
      const timeoutTimer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              flushDecoders();
              killAndSettle(
                commandError(`Command timed out after ${timeoutMs}ms: ${file}`, {
                  stdout: stdoutChunks.join(''),
                  stderr: stderrChunks.join(''),
                  code: null,
                  signal: 'SIGKILL',
                })
              );
            }, timeoutMs)
          : null;

      child.stdout?.on('data', (chunk: Buffer | string) =>
        appendChunk(chunk, stdoutChunks, stdoutDecoder)
      );
      child.stderr?.on('data', (chunk: Buffer | string) =>
        appendChunk(chunk, stderrChunks, stderrDecoder)
      );

      child.once('error', (err: Error) => {
        settle(commandError(`Failed to run ${file}: ${err?.message ?? err}`));
      });

      child.once('close', (code: number | null, closeSignal: NodeJS.Signals | null) => {
        if (aborted) return;
        if (timedOut) return;
        flushDecoders();
        const stdout = stdoutChunks.join('');
        const stderr = stderrChunks.join('');
        if (code === 0) {
          settle(null);
          return;
        }
        const detail = tailWindow(stderr.trim() || stdout.trim(), 4000);
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

  private async cloneRepository(
    rawCloneUrl: string,
    targetPath: string,
    githubToken: string | undefined
  ): Promise<void> {
    const authArgs = buildGitAuthArgs(rawCloneUrl, githubToken);
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
        // The mirror is a private remote too, so its refresh carries the same credentials as the clone.
        await this.execFileFn('git', [...authArgs, 'fetch', '--prune'], {
          cwd: mirrorPath,
          timeout: 120000,
        });
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

  /** Raw porcelain status, tail-trimmed only: the leading column is meaningful to the next model. */
  private async gitStatusPorcelain(cwd: string): Promise<string> {
    const { stdout } = await this.execFileFn('git', ['status', '--porcelain'], {
      cwd,
      timeout: 15000,
    });
    return stdout.replace(/\s+$/, '');
  }

  /** Untracked files as git spells them: `-uall` expands new directories and `-z` preserves spaces/quotes. */
  private async listUntracked(cwd: string): Promise<string[]> {
    const { stdout } = await this.execFileFn('git', ['status', '--porcelain', '-z', '-uall'], {
      cwd,
      timeout: 15000,
    });
    const entries = stdout.split('\u0000');
    const untracked: string[] = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (!entry) continue;
      if (entry.startsWith('?? ')) {
        untracked.push(entry.slice(3));
        continue;
      }
      // Renames and copies emit a second NUL-terminated entry carrying the source path.
      const x = entry[0];
      const y = entry[1];
      if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
        i += 1;
      }
    }
    return untracked;
  }

  /** Commits on HEAD that `baseBranch` does not have. */
  private async countCommitsAhead(cwd: string, baseBranch: string): Promise<number> {
    const { stdout } = await this.execFileFn(
      'git',
      ['rev-list', '--count', `${baseBranch}..HEAD`],
      { cwd, timeout: 10000 }
    );
    return parseInt(stdout.trim(), 10) || 0;
  }

  private async inspectPartialWork(
    cwd: string,
    baseBranch: string
  ): Promise<{ dirty: boolean; statusShort: string; diffStat: string }> {
    let statusShort = '';
    let diffStat = '';
    let aheadOfBase = 0;

    try {
      statusShort = await this.gitStatusPorcelain(cwd);
    } catch {}

    try {
      aheadOfBase = await this.countCommitsAhead(cwd, baseBranch);
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

  /** The terminal result for a run with nothing to ship; a null branch clears the stored column. */
  private noChangesResult(
    output: string,
    startMs: number,
    telemetry: TaskExecutionTelemetry
  ): TaskExecutionResult {
    return {
      success: true,
      noChanges: true,
      branchName: null,
      output,
      durationMs: Date.now() - startMs,
      ...this.telemetryFields(telemetry),
    };
  }

  /** Clones the task repository into place, or returns the failure that replaces the whole run. */
  private async ensureRepository(
    task: SwarmTask,
    branchName: string,
    startMs: number,
    githubToken: string | undefined
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
      await this.cloneRepository(cloneUrl, task.repositoryPath, githubToken);
      return null;
    } catch (cloneErr: any) {
      // A half-written clone must not survive: the next run would see the directory and skip cloning.
      await this.removeCloneTarget(task.repositoryPath);
      const errMsg = `Failed to clone repository from ${cloneUrl}: ${redactGitSecrets(
        cloneErr?.message || String(cloneErr),
        [githubToken]
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
    baseBranch: string,
    githubToken: string | undefined
  ): Promise<void> {
    const cwd = task.repositoryPath;
    try {
      const dirtyOut = await this.gitStatusPorcelain(cwd);
      if (dirtyOut !== '') {
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
        const gitPullArgs = [...buildGitAuthArgs(task.cloneUrl, githubToken), 'pull', '--ff-only'];
        await this.execFileFn('git', gitPullArgs, { cwd, timeout: 30000 });
      } catch (pullErr: unknown) {
        this.log.warn(
          'Fast-forward pull on %s failed before task %s (branching from local %s): %s',
          baseBranch,
          task.id,
          baseBranch,
          redactGitSecrets(pullErr instanceof Error ? pullErr.message : String(pullErr), [
            githubToken,
          ])
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

  private async resolveGitIdentityEnv(
    githubToken?: string,
    fallbackName?: string,
    leaseIdentity?: { name?: string; email?: string }
  ): Promise<{ env: Record<string, string>; owned: { name: string; email: string } }> {
    // Dashboard override, then the coordinator's env (both arrive on the lease), then this host's env,
    // then the account behind the token.
    const leaseName = leaseIdentity?.name?.trim();
    const leaseEmail = leaseIdentity?.email?.trim();
    const envAuthorName = leaseName || process.env.GIT_AUTHOR_NAME?.trim();
    const envAuthorEmail = leaseEmail || process.env.GIT_AUTHOR_EMAIL?.trim();
    let resolved: { name: string; email: string } | undefined;

    // Query the token's GitHub account only when name or email is still missing after lease/env.
    if (githubToken && (!envAuthorName || !envAuthorEmail)) {
      const cacheKey = createHash('sha256').update(githubToken).digest('hex');
      if (this.githubIdentityCache.has(cacheKey)) {
        resolved = this.githubIdentityCache.get(cacheKey) ?? undefined;
      } else {
        resolved = await this.resolveGithubIdentityFn(githubToken);
        this.githubIdentityCache.set(cacheKey, resolved ?? null);
      }
    }

    const authorName = envAuthorName || resolved?.name || fallbackName || 'Agylity Runner';
    const authorEmail = envAuthorEmail || resolved?.email || 'noreply@agylity.local';
    return {
      env: {
        GIT_AUTHOR_NAME: authorName,
        GIT_AUTHOR_EMAIL: authorEmail,
        // Keep committer aligned with the owned identity so ambient GIT_COMMITTER_* never
        // overrides leaseIdentity or triggers self-inflicted attribution rewrites.
        GIT_COMMITTER_NAME: authorName,
        GIT_COMMITTER_EMAIL: authorEmail,
      },
      // The identity this run actually commits as is the one the guard treats as owned.
      owned: { name: authorName, email: authorEmail },
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
      githubToken?: string | undefined;
      gitIdentityEnv: Record<string, string>;
    }
  ): Promise<{
    output: string;
    lastStdout: string;
    telemetry: TaskExecutionTelemetry;
    failure: unknown;
    /** The hop whose attempt produced `output`, which a failover can move off the primary. */
    executedHop: CascadeHop;
  }> {
    const { cwd, branchName, baseBranch, prompt, policySuffix, attributionSuffix } = context;
    const attemptTelemetry: TaskExecutionTelemetry[] = [];
    const attemptedModels = new Set<string>([context.primaryHop.model]);
    let attemptHop = context.primaryHop;
    let attemptPrompt = prompt;
    // The hop that actually ran, with the effort its model reports rather than the configured one.
    let executedHop: CascadeHop = context.primaryHop;
    let output = '';
    let lastStdout = '';
    let failure: unknown = null;

    for (;;) {
      const attemptModel = attemptHop.model;
      const attemptEffort = resolveReasoningEffortForModel(attemptHop.model, attemptHop.effort);
      executedHop = { model: attemptModel, effort: attemptEffort };
      // A model with no effort variants rejects `--effort`, so the flag is absent, not defaulted.
      const supportsEffort = modelSupportsEffort(attemptModel);
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
        ...(supportsEffort ? ['--effort', attemptEffort] : []),
      ];

      this.log.info(
        'Executing agy task %s in %s on branch %s (model=%s, effort=%s)',
        task.id,
        cwd,
        branchName,
        attemptModel,
        supportsEffort ? attemptEffort : 'none'
      );

      try {
        const streamed = await this.runAgy(agyArgs, {
          cwd,
          timeoutMs: this.timeoutMs,
          signal: context.signal,
          onOutput: context.onOutput,
          redactTokens: [context.githubToken],
          // The lease is the only credential the child sees; the empty fallback keeps a stale
          // GITHUB_TOKEN inherited from the runner environment out of the agent's reach.
          // Provide a deterministic git identity so `agy` never hits "Author identity unknown"
          // inside a container and improvises a third-party `@users.noreply.github.com` email.
          env: {
            ...context.gitIdentityEnv,
            GITHUB_TOKEN: context.githubToken ?? '',
          },
        });
        lastStdout = streamed.stdout || '';
        output = combineOutput(streamed.text || streamed.stdout, streamed.stderr);
        attemptTelemetry.push(parseAgyTelemetry(lastStdout));
        failure = null;
        break;
      } catch (agyErr: any) {
        lastStdout = agyErr?.stdout || '';
        const attemptOutput = redactGitSecrets(
          combineOutput(agyErr?.agyText || agyErr?.stdout, agyErr?.stderr),
          [context.githubToken]
        );
        output = attemptOutput;
        attemptTelemetry.push(parseAgyTelemetry(lastStdout));
        failure = agyErr;

        const failureText = capacityFailureSurface(agyErr);
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

    return {
      output,
      lastStdout,
      telemetry: sumAgyTelemetry(attemptTelemetry),
      failure,
      executedHop,
    };
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

    const [cmd, ...cmdArgs] = tokenizeCommand(trimmed);
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

    this.log.info('Running verification for %s: %s', cwd, trimmed);
    const verifyStartedAt = Date.now();
    try {
      await this.runStreamedCommand(cmd, cmdArgs, { cwd, timeoutMs: VERIFY_TIMEOUT_MS, signal });
      this.log.info('Verification passed for %s in %dms', cwd, Date.now() - verifyStartedAt);
    } catch (verifyErr: any) {
      const message =
        verifyErr?.stderr?.trim() ||
        verifyErr?.stdout?.trim() ||
        verifyErr?.message ||
        String(verifyErr);
      throw new Error(`Verification command failed (${trimmed}): ${message}`);
    }
  }

  /**
   * Commits whatever the agent left behind, or reports that the branch holds no work.
   *
   * The subject of a commit the agent wrote itself is the run's deliverable title; the runner's own
   * fallback commit is not, because that message is derived from the dispatch, not from the work.
   */
  private async commitWorkingTree(
    task: SwarmTask,
    branchName: string,
    baseBranch: string,
    gitIdentityEnv: Record<string, string>,
    untrackedPaths: readonly string[]
  ): Promise<{ commitsProduced: boolean; deliverableTitle?: string; commitError?: string }> {
    const cwd = task.repositoryPath;
    const deliverableTitle = await this.authoredCommitSubject(cwd, baseBranch);
    let committed = false;
    let commitError: string | undefined;

    try {
      const statusOut = await this.gitStatusPorcelain(cwd);
      if (statusOut !== '') {
        await this.execFileFn('git', ['add', '-u'], { cwd, timeout: 15000 });
        await this.stageUntrackedPaths(cwd, untrackedPaths);
        if (await this.hasStagedChanges(cwd)) {
          await this.execFileFn(
            'git',
            ['commit', '-m', resolveTaskTitle(task.title, task.prompt)],
            {
              cwd,
              timeout: 30000,
              env: {
                ...process.env,
                ...gitIdentityEnv,
              },
            }
          );
          committed = true;
          this.log.info('Committed the working tree on %s', branchName);
        }
      }
    } catch (commitErr: any) {
      commitError = commitErr?.stderr?.trim() || commitErr?.message || String(commitErr);
      this.log.error('Failed to commit working tree changes on %s: %s', branchName, commitError);
    }

    if (commitError) return { commitsProduced: false, deliverableTitle, commitError };
    if (committed) return { commitsProduced: true, deliverableTitle };

    try {
      return {
        commitsProduced: (await this.countCommitsAhead(cwd, baseBranch)) > 0,
        deliverableTitle,
      };
    } catch {
      return { commitsProduced: false, deliverableTitle };
    }
  }

  /** Stages untracked paths in batches, falling back per-file if one vanished or is ignored. */
  private async stageUntrackedPaths(cwd: string, untrackedPaths: readonly string[]): Promise<void> {
    for (let index = 0; index < untrackedPaths.length; index += 50) {
      const batch = untrackedPaths.slice(index, index + 50);
      try {
        await this.execFileFn('git', ['add', '--', ...batch], { cwd, timeout: 15000 });
      } catch {
        for (const filePath of batch) {
          try {
            await this.execFileFn('git', ['add', '--', filePath], { cwd, timeout: 15000 });
          } catch (addErr: any) {
            this.log.warn(
              'Skipped an untracked path that could not be staged (%s): %s',
              filePath,
              addErr?.message
            );
          }
        }
      }
    }
  }

  /** Returns true when the index has staged changes (`git diff --cached --quiet` exits 1). */
  private async hasStagedChanges(cwd: string): Promise<boolean> {
    try {
      await this.execFileFn('git', ['diff', '--cached', '--quiet'], { cwd, timeout: 15000 });
      return false;
    } catch {
      return true;
    }
  }

  /** The newest subject among commits the agent wrote, or undefined when the branch is still clean. */
  private async authoredCommitSubject(
    cwd: string,
    baseBranch: string
  ): Promise<string | undefined> {
    try {
      if ((await this.countCommitsAhead(cwd, baseBranch)) <= 0) return undefined;

      const { stdout: subject } = await this.execFileFn(
        'git',
        ['log', '-1', '--format=%s', `${baseBranch}..HEAD`],
        { cwd, timeout: 10000 }
      );
      return subject.trim() || undefined;
    } catch {
      return undefined;
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

  private async pushTaskBranch(
    task: SwarmTask,
    branchName: string,
    githubToken: string | undefined
  ): Promise<string | null> {
    try {
      const gitPushArgs = [
        ...buildGitAuthArgs(task.cloneUrl, githubToken),
        'push',
        '-u',
        'origin',
        branchName,
      ];
      await this.execFileFn('git', gitPushArgs, {
        cwd: task.repositoryPath,
        timeout: 60000,
      });
      this.log.info('Pushed %s to origin', branchName);
      return null;
    } catch (gitPushErr: any) {
      const pushErrMsg = redactGitSecrets(gitPushErr?.message ?? String(gitPushErr), [githubToken]);
      this.log.error('Git push failed on %s: %s', branchName, pushErrMsg);
      return githubToken
        ? `Git push to origin/${branchName} failed: ${pushErrMsg}`
        : `Git push to origin/${branchName} failed: ${pushErrMsg} (the coordinator leased no GitHub token for this task)`;
    }
  }

  /** Opens the pull request for a pushed branch, returning its URL when one was reported. */
  private async openPullRequest(
    task: SwarmTask,
    branchName: string,
    baseBranch: string,
    hop: CascadeHop,
    githubToken: string | undefined,
    title: string,
    capturedOutput: string
  ): Promise<string | undefined> {
    try {
      const tierLabel = task.tier || 'immediate';
      // A failover hop is the model that actually wrote the branch, so the footer names that one.
      const effortNote = modelSupportsEffort(hop.model) ? ` (${hop.effort} reasoning)` : '';
      // First, so the footer check still sees the prompt's own tail.
      const closes = task.originIssueNumber ? `Closes #${task.originIssueNumber}\n\n` : '';
      const rawBody = `${closes}${buildPullRequestBody(task, title, capturedOutput)}`;
      // Avoid stacking a second Agylity footer when the source prompt/output already ends with one.
      const hasDispatchFooter = AGYLITY_FOOTER_TAIL_RE.test(rawBody);
      const prBody = hasDispatchFooter
        ? rawBody
        : [rawBody, '', '---', agylityFooter(tierLabel, hop.model, effortNote)].join('\n');

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
          title,
          '--body',
          prBody,
        ],
        {
          cwd: task.repositoryPath,
          timeout: 30000,
          env: { ...process.env, GITHUB_TOKEN: githubToken ?? '' },
        }
      );
      const match = prOut.match(/https:\/\/github\.com\/[^\s]+/);
      if (!match) return undefined;
      this.log.info('Created pull request for %s: %s', branchName, match[0]);
      return match[0].trim();
    } catch (prErr: any) {
      this.log.warn(
        'Auto PR creation failed for %s: %s',
        branchName,
        redactGitSecrets(prErr?.message ?? String(prErr), [githubToken])
      );
      return undefined;
    }
  }

  /**
   * Applies the PR policy to a finished branch.
   *
   * Returns the terminal result when the policy suppresses the branch, or null when the branch may
   * be pushed. Every tier is policed: a human dispatch is a request for this work, not permission to
   * bypass the configured policy.
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
      githubToken?: string | undefined;
    }
  ): Promise<TaskExecutionResult | null> {
    const { branchName, baseBranch, output, prPolicy, telemetry, startMs, githubToken } = context;

    const suppress = async (detail: string): Promise<TaskExecutionResult> => {
      await this.discardBranch(task.repositoryPath, baseBranch, branchName);
      return this.noChangesResult(`${output}\n\n${detail}`, startMs, telemetry);
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
        ['diff', '--name-only', '-z', `${baseBranch}..HEAD`],
        { cwd: task.repositoryPath, timeout: 15000 }
      );
      nonDocFiles = diffOut
        .split(/[\0\r\n]+/)
        .map((file) => file.trim())
        .filter(Boolean)
        .filter((file) => !isDocumentationFile(file));
    } catch (diffErr: any) {
      this.log.warn(
        'Failed to inspect commit diff for bot policy check on %s: %s',
        branchName,
        diffErr?.message ?? diffErr
      );
      // An uninspectable diff cannot prove the branch is docs-only, so the gate stays shut.
      return suppress(
        `[Policy Guard] Autonomous PR suppressed: PR policy is 'docs_only' and the commit diff could not be inspected (${redactGitSecrets(
          diffErr?.message ?? String(diffErr),
          [githubToken]
        )}).`
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

  private taskGithubRepoSlug(task: SwarmTask): Promise<string | undefined> {
    return resolveGithubRepoSlug(
      { cloneUrl: task.cloneUrl, name: task.repositoryName, path: task.repositoryPath },
      this.execFileFn
    );
  }

  /**
   * Finds the GitHub issues this run filed, which are the deliverable of a zero-diff run.
   *
   * The listing is ground truth from the GitHub API: issues created at or after the run started that
   * carry the Agylity footer. A URL the agent merely mentions in prose is not evidence it created
   * anything, so prose is never scraped.
   */
  private async collectIssueDeliverables(
    task: SwarmTask,
    sinceMs: number,
    githubToken: string | undefined
  ): Promise<Array<{ url: string; title: string }>> {
    const slug = await this.taskGithubRepoSlug(task);
    if (!slug) {
      this.log.warn(
        'Cannot resolve a GitHub owner/repo slug for %s; no issue deliverable can be reported',
        task.id
      );
      return [];
    }

    let stdout = '';
    try {
      const listing = await this.execFileFn(
        'gh',
        [
          'issue',
          'list',
          '--repo',
          slug,
          '--state',
          'all',
          '--limit',
          String(ISSUE_DELIVERABLE_LIMIT),
          '--json',
          'number,title,url,body,createdAt',
        ],
        {
          cwd: task.repositoryPath,
          timeout: 20000,
          env: { ...process.env, GITHUB_TOKEN: githubToken ?? '' },
        }
      );
      stdout = listing.stdout || '';
    } catch (listErr: unknown) {
      this.log.warn(
        'Could not query GitHub issues for %s: %s',
        slug,
        redactGitSecrets(listErr instanceof Error ? listErr.message : String(listErr), [
          githubToken,
        ])
      );
      return [];
    }

    let parsed: unknown = [];
    try {
      parsed = stdout.trim() ? JSON.parse(stdout) : [];
    } catch (parseErr: unknown) {
      this.log.warn(
        'Could not parse the GitHub issue listing for %s: %s',
        slug,
        parseErr instanceof Error ? parseErr.message : String(parseErr)
      );
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    const created: Array<{ url: string; title: string; createdAt: number }> = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as { url?: unknown; title?: unknown; body?: unknown; createdAt?: unknown };
      const url = typeof entry.url === 'string' ? entry.url.trim() : '';
      const title = typeof entry.title === 'string' ? entry.title.trim() : '';
      const body = typeof entry.body === 'string' ? entry.body : '';
      const createdAt = typeof entry.createdAt === 'string' ? Date.parse(entry.createdAt) : NaN;
      if (!url || !Number.isFinite(createdAt) || createdAt < sinceMs) continue;
      if (!body.includes(AGYLITY_FOOTER_MARKER)) continue;
      if (created.some((existing) => existing.url === url)) continue;
      created.push({ url, title, createdAt });
    }

    return created
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, ISSUE_DELIVERABLE_MAX_URLS)
      .map((entry) => ({ url: entry.url, title: entry.title }));
  }

  public async execute(
    task: SwarmTask,
    options: TaskExecuteOptions = {}
  ): Promise<TaskExecutionResult> {
    const startMs = Date.now();
    // Scoped to this call so nothing can leak the lease into a later task on the same executor.
    const githubToken = options.githubToken?.trim() || undefined;
    const branchName =
      task.branchName ||
      buildContinuationBranchName(task.id, resolveTaskTitle(task.title, task.prompt));

    // A stored branch name can arrive from a runner report, so it has to be a usable ref before any
    // clone, checkout or push spends a run on it.
    const unusableBranch = !isUsableBranchRef(branchName);
    if (branchName === 'main' || branchName === 'master' || unusableBranch) {
      return this.failureResult(
        branchName,
        startMs,
        unusableBranch
          ? `Branch isolation invariant violation: '${branchName}' is not a usable git branch name`
          : 'Branch isolation invariant violation: refusing to execute directly on main/master'
      );
    }

    // A human-typed title on a human tier outranks the deliverable; a routine's own name is kept on
    // `origin_title`, so its runs always settle from what they produced.
    const hasExplicitTitleOverride =
      task.tier !== 'routine' &&
      Boolean(task.title?.trim()) &&
      task.title.trim() !== resolveTaskTitle(undefined, task.prompt);
    let resolvedTitle: string | undefined;

    const repositoryFailure = await this.ensureRepository(task, branchName, startMs, githubToken);
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

      await this.prepareBranch(task, branchName, baseBranch, githubToken);

      const primaryHop: CascadeHop = {
        model: task.model,
        effort: resolveReasoningEffortForModel(task.model, task.effort),
      };
      const tierLabel = task.tier || 'immediate';
      const effectivePrPolicy: PrPolicy =
        normalizePrPolicy(task.prPolicy) ?? this.prPolicy ?? 'all';
      const { prompt, policySuffix, attributionSuffix } = buildPrompt(
        task,
        effectivePrPolicy,
        tierLabel,
        modelSupportsEffort(task.model) ? primaryHop.effort : undefined
      );

      const { env: gitIdentityEnv, owned: ownedIdentity } = await this.resolveGitIdentityEnv(
        githubToken,
        task.requestedBy,
        options.gitIdentity
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
        githubToken,
        gitIdentityEnv,
      });
      capturedOutput = redactGitSecrets(agent.output, [githubToken]);
      capturedTelemetryRaw = agent.lastStdout;
      telemetry = agent.telemetry;
      if (agent.failure) throw agent.failure;

      // Read the agent's own untracked files before verification, so its artifacts cannot be committed.
      const agentUntracked = await this.listUntracked(cwd);
      if (task.verifyCommand && task.verifyCommand.trim() !== '') {
        await this.runVerification(task.verifyCommand, cwd, options.signal);
      }

      const commit = await this.commitWorkingTree(
        task,
        branchName,
        baseBranch,
        gitIdentityEnv,
        agentUntracked
      );
      if (commit.commitError) {
        return {
          success: false,
          branchName,
          output: capturedOutput,
          error: redactGitSecrets(
            `Failed to commit the working tree on ${branchName}: ${commit.commitError}`,
            [githubToken]
          ),
          durationMs: Date.now() - startMs,
          ...this.telemetryFields(telemetry),
        };
      }
      if (!commit.commitsProduced) {
        await this.discardBranch(cwd, baseBranch, branchName);
        const issues = await this.collectIssueDeliverables(task, startMs, githubToken);
        const issueUrls = issues.map((issue) => issue.url);
        if (issueUrls.length > 0) {
          const issueTitle =
            issues.length === 1
              ? (issues[0]?.title ?? '')
              : `${issues[0]?.title ?? ''} (+${issues.length - 1})`;
          if (!hasExplicitTitleOverride) {
            resolvedTitle = resolveTaskTitle(issueTitle, task.prompt);
          }
          this.log.info(
            'Task %s produced no commits but filed %d GitHub issue(s); reporting them as the deliverable',
            task.id,
            issueUrls.length
          );
          return {
            success: true,
            branchName: null,
            issueUrls,
            resolvedTitle,
            output:
              `${capturedOutput}\n\n[Deliverable] Filed GitHub issues: ${issueUrls.join(' ')}`.trim(),
            durationMs: Date.now() - startMs,
            ...this.telemetryFields(telemetry),
          };
        }
        this.log.info(
          'Zero diff produced for task %s; cleaned up local branch %s',
          task.id,
          branchName
        );
        return this.noChangesResult(capturedOutput, startMs, telemetry);
      }

      const suppression = await this.applyPrPolicy(task, {
        branchName,
        baseBranch,
        output: capturedOutput,
        prPolicy: effectivePrPolicy,
        telemetry,
        startMs,
        githubToken,
      });
      if (suppression) return suppression;

      // The work that actually shipped names the task; only a human-typed title outranks it.
      if (!hasExplicitTitleOverride && commit.deliverableTitle) {
        resolvedTitle = resolveTaskTitle(commit.deliverableTitle, task.prompt);
      }

      let finalBranchName = branchName;
      if (!hasExplicitTitleOverride && resolvedTitle) {
        const nextBranchName = buildContinuationBranchName(task.id, resolvedTitle);
        if (nextBranchName !== branchName) {
          try {
            await this.execFileFn('git', ['branch', '-m', branchName, nextBranchName], {
              cwd,
              timeout: 15000,
            });
            finalBranchName = nextBranchName;
          } catch (renameErr: any) {
            this.log.warn(
              'Could not rename %s to %s in %s; keeping the original branch: %s',
              branchName,
              nextBranchName,
              cwd,
              renameErr?.message ?? renameErr
            );
          }
        }
      }

      let prUrl: string | undefined;
      if (task.pushBranch) {
        // Nothing unowned reaches the remote: the guard runs before the leased token can push.
        await stripUntrustedAttribution(cwd, baseBranch, ownedIdentity, {
          execFile: this.execFileFn,
          log: this.log,
        });
        const pushError = await this.pushTaskBranch(task, finalBranchName, githubToken);
        if (pushError) {
          return {
            success: false,
            branchName: finalBranchName,
            resolvedTitle,
            output: capturedOutput,
            error: pushError,
            durationMs: Date.now() - startMs,
            ...this.telemetryFields(telemetry),
          };
        }

        if (task.autoCreatePr) {
          // GitHub PR titles accept up to 256 chars, so keep full commit subjects (e.g. with issue
          // references at the tail) instead of clipping them to the 72-char dashboard row budget.
          const prTitleSource = hasExplicitTitleOverride
            ? task.title
            : (commit.deliverableTitle ?? resolvedTitle ?? task.title);
          const prTitle = resolveTaskTitle(prTitleSource, task.prompt, 200);
          prUrl = await this.openPullRequest(
            task,
            finalBranchName,
            baseBranch,
            agent.executedHop,
            githubToken,
            prTitle,
            capturedOutput
          );
        }
      }

      return {
        success: true,
        branchName: finalBranchName,
        prUrl,
        resolvedTitle,
        output: capturedOutput,
        durationMs: Date.now() - startMs,
        ...this.telemetryFields(telemetry),
      };
    } catch (err: any) {
      const durationMs = Date.now() - startMs;
      // Git stderr can carry a remote URL with an embedded credential, so it is redacted before any sink.
      const errMessage = redactGitSecrets(err?.stderr?.trim() || err?.message || String(err), [
        githubToken,
      ]);
      this.log.error('Task %s execution failed: %s', task.id, errMessage);
      if (err?.stdout || err?.stderr) {
        const extra = redactGitSecrets(
          [err.stdout?.trim(), err.stderr?.trim()].filter(Boolean).join('\n'),
          [githubToken]
        );
        if (extra && !capturedOutput.includes(extra)) {
          capturedOutput = capturedOutput ? `${capturedOutput}\n\n${extra}` : extra;
        }
      }
      const failureTelemetry = hasTelemetryValues(telemetry)
        ? telemetry
        : parseAgyTelemetry(capturedTelemetryRaw || err?.stdout);
      const failureOutput = redactGitSecrets(capturedOutput || String(err?.stdout ?? '').trim(), [
        githubToken,
      ]);
      return {
        success: false,
        branchName,
        output: failureOutput,
        error: errMessage,
        durationMs,
        ...this.telemetryFields(failureTelemetry),
      };
    }
  }
}
