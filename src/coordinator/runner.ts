import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  promises as fsPromises,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ky from 'ky';
import { defaultExecFileAsync, type ExecFileAsyncFn } from '../sentry/discovery.js';
import { isCliAuthFailure } from '../sentry/client.js';
import { logger, type Logger } from '../logs/logger.js';
import type { RunnerSystemInfo, SwarmRunnerRecord, SwarmTask, TaskStatusPatch } from './queue.js';
import { normalizeCascade, resolveReasoningEffortForModel, type CascadeHop } from './models.js';
import type { PrPolicy } from '../config/schema.js';

const PR_POLICIES: ReadonlySet<string> = new Set(['none', 'docs_only', 'all']);

// An unrecognised policy string (a typo or a blank compose var) must never read as "no restriction".
export const normalizePrPolicy = (value?: string): PrPolicy | undefined => {
  const normalized = value?.trim().toLowerCase();
  return normalized && PR_POLICIES.has(normalized) ? (normalized as PrPolicy) : undefined;
};

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
  branchName: string;
  prUrl?: string;
  output: string;
  error?: string;
  durationMs: number;
  numTurns?: number;
  totalTokens?: number;
  thinkingTokens?: number;
}

export interface PersistedRunnerState {
  runnerId: string;
  runnerName: string;
  labels: string[];
  repositories: string[];
  runnerToken: string;
  coordinatorUrl: string;
  registeredAt: string;
}

// A tokenless runner only fails at push, after burning a full agent run -- fail at boot instead.
export const assertRunnerGitCredentials = (
  repositories: string[] | undefined,
  env: NodeJS.ProcessEnv = process.env
): void => {
  if (env.ALLOW_TOKENLESS_RUNNER?.trim().toLowerCase() === 'true') return;
  const token = env.GITHUB_TOKEN?.trim();
  if (token) return;

  const scope =
    repositories && repositories.length > 0
      ? `scoped to ${repositories.join(', ')}`
      : 'unscoped, so it may claim any repository the coordinator offers';

  throw new Error(
    `GITHUB_TOKEN is not set on this runner (${scope}). Without it the clone is anonymous and ` +
      'git push fails after the task has already spent its quota, so refusing to start. ' +
      'Note that env_file alone does not put a variable in the container environment -- the token ' +
      'must also be named under environment: in compose.yaml. Set ALLOW_TOKENLESS_RUNNER=true to ' +
      'run without a token against a non-GitHub remote.'
  );
};

const buildGitAuthArgs = (repoUrl?: string): string[] => {
  const ghToken = process.env.GITHUB_TOKEN?.trim();
  if (ghToken && (!repoUrl || repoUrl.startsWith('https://github.com/'))) {
    const basicAuth = Buffer.from(`x-access-token:${ghToken}`, 'utf8').toString('base64');
    return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basicAuth}`];
  }
  return [];
};

// Never returns 'main' or 'master'.
export const buildContinuationBranchName = (taskId: string, prompt: string): string => {
  const shortId =
    taskId
      .replace(/^task-\d+-/, '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 8) || 'cont';

  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean);

  let slug = '';
  for (const word of words) {
    const candidate = slug ? `${slug}-${word}` : word;
    if (candidate.length > 32) break;
    slug = candidate;
  }

  return `agy/${shortId}-${slug || 'work'}`;
};

const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkdn', '.txt', '.rst', '.adoc']);

const DOC_SPECIAL_BASENAMES = new Set([
  'license',
  'licence',
  'notice',
  'copying',
  'authors',
  'contributors',
  'changelog',
  'changes',
  'code_of_conduct',
  'contributing',
  'security',
]);

export const isDocumentationFile = (filePath: string): boolean => {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const baseName = path.basename(normalized);
  const ext = path.extname(baseName).toLowerCase();
  const nameWithoutExt = ext
    ? baseName.slice(0, -ext.length).toLowerCase()
    : baseName.toLowerCase();

  if (nameWithoutExt.startsWith('readme') || DOC_SPECIAL_BASENAMES.has(nameWithoutExt)) {
    if (!ext || DOC_EXTENSIONS.has(ext)) return true;
  }

  if (DOC_EXTENSIONS.has(ext)) {
    return true;
  }

  if (normalized.startsWith('docs/') || normalized.startsWith('doc/')) {
    const docAssetExts = new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp']);
    if (docAssetExts.has(ext)) return true;
  }

  return false;
};

export const collectRunnerSystemInfo = (): RunnerSystemInfo => ({
  hostname: os.hostname(),
  platform: process.platform,
  arch: process.arch,
});

export interface TaskExecutionTelemetry {
  conversationId?: string;
  numTurns?: number;
  totalTokens?: number;
  thinkingTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

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
        telemetry.numTurns = Number(parsed.num_turns);
      } else if (parsed.turns !== undefined && telemetry.numTurns === undefined) {
        telemetry.numTurns = Number(parsed.turns);
      }

      const usage = parsed.usage || parsed.token_usage;
      if (usage && typeof usage === 'object') {
        if (usage.input_tokens !== undefined && telemetry.inputTokens === undefined) {
          telemetry.inputTokens = Number(usage.input_tokens);
        }
        if (usage.output_tokens !== undefined && telemetry.outputTokens === undefined) {
          telemetry.outputTokens = Number(usage.output_tokens);
        }
        if (usage.thinking_tokens !== undefined && telemetry.thinkingTokens === undefined) {
          telemetry.thinkingTokens = Number(usage.thinking_tokens);
        }
        if (usage.total_tokens !== undefined && telemetry.totalTokens === undefined) {
          telemetry.totalTokens = Number(usage.total_tokens);
        }
      }
      if (parsed.total_tokens !== undefined && telemetry.totalTokens === undefined) {
        telemetry.totalTokens = Number(parsed.total_tokens);
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
        clearTimeout(timeoutTimer);
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

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        void ensureKilled().then(() => {
          settle(
            commandError(`Command timed out after ${options.timeoutMs}ms: ${file}`, {
              stdout: stdoutChunks.join(''),
              stderr: stderrChunks.join(''),
              code: null,
              signal: 'SIGKILL',
            })
          );
        });
      }, options.timeoutMs);

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

  public async execute(
    task: SwarmTask,
    options: TaskExecuteOptions = {}
  ): Promise<TaskExecutionResult> {
    const startMs = Date.now();
    const branchName = task.branchName || buildContinuationBranchName(task.id, task.prompt);

    if (branchName === 'main' || branchName === 'master') {
      return {
        success: false,
        branchName,
        output: '',
        error: 'Branch isolation invariant violation: refusing to execute directly on main/master',
        durationMs: Date.now() - startMs,
      };
    }

    if (!this.dirExistsFn(task.repositoryPath)) {
      if (task.cloneUrl && task.cloneUrl.trim() !== '') {
        try {
          await this.onStatusUpdate?.({
            status: 'executing',
            branchName,
            message: `Cloning repository from ${task.cloneUrl} into ${task.repositoryPath}`,
          });
          mkdirSync(path.dirname(task.repositoryPath), { recursive: true });
          await this.cloneRepository(task.cloneUrl.trim(), task.repositoryPath);
        } catch (cloneErr: any) {
          let errStr = cloneErr?.message || String(cloneErr);
          const ghToken = process.env.GITHUB_TOKEN?.trim();
          if (ghToken && ghToken.length >= 6) {
            errStr = errStr.split(ghToken).join('[redacted]');
            const basicAuth = Buffer.from(`x-access-token:${ghToken}`, 'utf8').toString('base64');
            errStr = errStr.split(basicAuth).join('[redacted]');
          }
          const errMsg = `Failed to clone repository from ${task.cloneUrl}: ${errStr}`;
          this.log.error(errMsg);
          return {
            success: false,
            branchName,
            output: '',
            error: errMsg,
            durationMs: Date.now() - startMs,
          };
        }
      } else {
        const errMsg = `Target repository directory does not exist: ${task.repositoryPath} (and no cloneUrl configured)`;
        this.log.error(errMsg);
        return {
          success: false,
          branchName,
          output: '',
          error: errMsg,
          durationMs: Date.now() - startMs,
        };
      }
    }

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

      // Fast-forward the base branch first so sequential tasks never stack onto previous task branches.
      try {
        // `/repos/<id>` can be a real working copy, so uncommitted state is stashed, never deleted.
        const { stdout: dirtyOut } = await this.execFileFn('git', ['status', '--porcelain'], {
          cwd,
          timeout: 15000,
        });
        if (dirtyOut && dirtyOut.trim() !== '') {
          await this.execFileFn(
            'git',
            ['stash', 'push', '--include-untracked', '-m', `agylity ${task.id}`],
            { cwd, timeout: 30000 }
          );
          this.log.warn('Stashed uncommitted changes in %s before task %s', cwd, task.id);
        }
        await this.execFileFn('git', ['checkout', baseBranch], {
          cwd,
          timeout: 30000,
        });
        try {
          const gitPullArgs = [...buildGitAuthArgs(task.cloneUrl), 'pull', '--ff-only'];
          await this.execFileFn('git', gitPullArgs, {
            cwd,
            timeout: 30000,
          });
        } catch {}
      } catch (baseCheckoutErr: any) {
        this.log.debug(
          'Base branch checkout (%s) skipped before creating %s: %s',
          baseBranch,
          branchName,
          baseCheckoutErr?.message ?? baseCheckoutErr
        );
      }

      await this.execFileFn('git', ['checkout', '-B', branchName], {
        cwd,
        timeout: 30000,
      });

      const primaryHop: CascadeHop = {
        model: task.model,
        effort: resolveReasoningEffortForModel(task.model, task.effort),
      };
      const safeEffort = primaryHop.effort;
      const tierLabel = task.tier || 'immediate';
      const attributionSuffix = `\n\n[Instruction: If you create or edit any GitHub PR or Issue description directly, keep it minimal: simply append a footer: "---\n*Dispatched via Agylity (${tierLabel}) with \`${task.model}\` (${safeEffort} reasoning) — please review carefully.*". Never mention runner hostnames, internal server paths, or worker IDs.]`;
      const effectivePrompt = `${task.prompt}${attributionSuffix}`;

      const attemptTelemetry: TaskExecutionTelemetry[] = [];
      const attemptedModels = new Set<string>([primaryHop.model]);
      let attemptHop: CascadeHop = primaryHop;
      let attemptPrompt = effectivePrompt;
      let agyFailure: any = null;

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
            signal: options.signal,
            onOutput: options.onOutput,
          });
          capturedTelemetryRaw = streamed.stdout || '';
          capturedOutput = [streamed.stdout?.trim(), streamed.stderr?.trim()]
            .filter(Boolean)
            .join('\n');
          attemptTelemetry.push(parseAgyTelemetry(capturedTelemetryRaw));
          agyFailure = null;
          break;
        } catch (agyErr: any) {
          capturedTelemetryRaw = agyErr?.stdout || '';
          const attemptOutput = [agyErr?.stdout?.trim(), agyErr?.stderr?.trim()]
            .filter(Boolean)
            .join('\n');
          capturedOutput = attemptOutput;
          attemptTelemetry.push(parseAgyTelemetry(capturedTelemetryRaw));
          agyFailure = agyErr;

          const failureText = [attemptOutput, agyErr?.message ?? ''].filter(Boolean).join('\n');
          if (options.signal?.aborted || !isCapacityExhaustedOutput(failureText)) break;

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

          attemptPrompt = partial.dirty
            ? `${buildCapacityContinuationPrompt({
                failedModel: attemptHop.model,
                statusShort: partial.statusShort,
                diffStat: partial.diffStat,
                tail: attemptOutput,
                originalPrompt: task.prompt,
              })}${attributionSuffix}`
            : effectivePrompt;
          attemptHop = nextHop;
        }
      }

      if (agyFailure) throw agyFailure;

      telemetry = sumAgyTelemetry(attemptTelemetry);

      const combinedOutput = capturedOutput;

      // A coarse test-runner allowlist, not a sandbox.
      if (task.verifyCommand && task.verifyCommand.trim() !== '') {
        const trimmed = task.verifyCommand.trim();
        if (/[;&|`$><\r\n]/.test(trimmed)) {
          throw new Error('Verification command contains illegal shell metacharacters');
        }
        const parts = trimmed.split(/\s+/);
        const cmd = parts[0]!;
        const cmdArgs = parts.slice(1);
        const ALLOWED_TEST_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'pytest', 'cargo', 'go']);
        if (!ALLOWED_TEST_RUNNERS.has(cmd)) {
          throw new Error(
            `Verification command '${cmd}' is not in approved test runner allowlist (${Array.from(ALLOWED_TEST_RUNNERS).join(', ')})`
          );
        }
        if (cmdArgs.some((arg) => arg === '-e' || arg === '--eval' || arg === '-c')) {
          throw new Error('Verification command must not use an inline-code flag (-e/--eval/-c)');
        }
        try {
          await this.runStreamedCommand(cmd, cmdArgs, {
            cwd,
            timeoutMs: 10 * 60 * 1000,
            signal: options.signal,
          });
        } catch (verifyErr: any) {
          const vMsg =
            verifyErr?.stderr?.trim() ||
            verifyErr?.stdout?.trim() ||
            verifyErr?.message ||
            String(verifyErr);
          throw new Error(`Verification command failed (${trimmed}): ${vMsg}`);
        }
      }

      let commitsProduced = false;
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
          commitsProduced = true;
        }
      } catch (commitErr: any) {
        this.log.warn(
          'Failed to commit working tree changes on %s: %s',
          branchName,
          commitErr?.message ?? commitErr
        );
      }

      if (!commitsProduced) {
        try {
          const { stdout: revCount } = await this.execFileFn(
            'git',
            ['rev-list', '--count', `${baseBranch}..HEAD`],
            { cwd, timeout: 10000 }
          );
          if (parseInt(revCount.trim(), 10) > 0) {
            commitsProduced = true;
          }
        } catch {}
      }

      if (!commitsProduced) {
        try {
          await this.execFileFn('git', ['checkout', baseBranch], { cwd, timeout: 15000 });
          await this.execFileFn('git', ['branch', '-D', branchName], { cwd, timeout: 15000 });
          this.log.info(
            'Zero diff produced for task %s; cleaned up local branch %s',
            task.id,
            branchName
          );
        } catch {}
        return {
          success: true,
          noChanges: true,
          branchName,
          output: combinedOutput,
          durationMs: Date.now() - startMs,
          numTurns: telemetry.numTurns,
          totalTokens: telemetry.totalTokens,
          thinkingTokens: telemetry.thinkingTokens,
        };
      }

      let prUrl: string | undefined;

      const agentRun = task.tier !== 'immediate';
      const effectivePrPolicy: PrPolicy =
        normalizePrPolicy(task.prPolicy) ?? this.prPolicy ?? 'all';

      if (agentRun) {
        if (effectivePrPolicy === 'none') {
          this.log.info(
            'Autonomous PR policy is "none": suppressing branch push and PR creation for task %s on %s',
            task.id,
            branchName
          );
          try {
            await this.execFileFn('git', ['checkout', baseBranch], { cwd, timeout: 15000 });
            await this.execFileFn('git', ['branch', '-D', branchName], { cwd, timeout: 15000 });
          } catch {}
          return {
            success: true,
            noChanges: true,
            branchName,
            output: `${combinedOutput}\n\n[Policy Guard] Autonomous PR suppressed: PR policy is 'none'.`,
            durationMs: Date.now() - startMs,
            numTurns: telemetry.numTurns,
            totalTokens: telemetry.totalTokens,
            thinkingTokens: telemetry.thinkingTokens,
          };
        }

        if (effectivePrPolicy === 'docs_only') {
          let nonDocFiles: string[] = [];
          try {
            const { stdout: diffOut } = await this.execFileFn(
              'git',
              ['diff', '--name-only', `${baseBranch}..HEAD`],
              { cwd, timeout: 15000 }
            );
            const changedFiles = diffOut
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            nonDocFiles = changedFiles.filter((f) => !isDocumentationFile(f));
          } catch (diffErr: any) {
            this.log.warn(
              'Failed to inspect commit diff for bot policy check on %s: %s',
              branchName,
              diffErr?.message ?? diffErr
            );
          }

          if (nonDocFiles.length > 0) {
            this.log.info(
              'Autonomous PR policy "docs_only" blocked PR for task %s on %s (non-doc files modified: %s)',
              task.id,
              branchName,
              nonDocFiles.join(', ')
            );
            try {
              await this.execFileFn('git', ['checkout', baseBranch], { cwd, timeout: 15000 });
              await this.execFileFn('git', ['branch', '-D', branchName], { cwd, timeout: 15000 });
            } catch {}
            return {
              success: true,
              noChanges: true,
              branchName,
              output: `${combinedOutput}\n\n[Policy Guard] Autonomous PR suppressed: PR policy is 'docs_only', so only documentation changes ship. Code modifications must be submitted as GitHub Issues.\nNon-doc files modified: ${nonDocFiles.join(', ')}`,
              durationMs: Date.now() - startMs,
              numTurns: telemetry.numTurns,
              totalTokens: telemetry.totalTokens,
              thinkingTokens: telemetry.thinkingTokens,
            };
          }
        }
      }

      if (task.pushBranch) {
        try {
          const gitPushArgs = [
            ...buildGitAuthArgs(task.cloneUrl),
            'push',
            '-u',
            'origin',
            branchName,
          ];
          await this.execFileFn('git', gitPushArgs, {
            cwd,
            timeout: 60000,
          });
        } catch (gitPushErr: any) {
          let pushErrMsg = gitPushErr?.message ?? String(gitPushErr);
          const ghToken = process.env.GITHUB_TOKEN?.trim();
          if (ghToken && ghToken.length >= 6) {
            const basicAuth = Buffer.from(`x-access-token:${ghToken}`, 'utf8').toString('base64');
            pushErrMsg = pushErrMsg
              .split(ghToken)
              .join('[redacted]')
              .split(basicAuth)
              .join('[redacted]');
          }
          this.log.error('Git push failed on %s: %s', branchName, pushErrMsg);
          const noToken = !process.env.GITHUB_TOKEN?.trim();
          return {
            success: false,
            branchName,
            output: combinedOutput,
            error: noToken
              ? `Git push to origin/${branchName} failed: ${pushErrMsg} (this runner has no GITHUB_TOKEN set)`
              : `Git push to origin/${branchName} failed: ${pushErrMsg}`,
            durationMs: Date.now() - startMs,
            numTurns: telemetry.numTurns,
            totalTokens: telemetry.totalTokens,
            thinkingTokens: telemetry.thinkingTokens,
          };
        }

        if (task.autoCreatePr) {
          try {
            const effort = task.effort || safeEffort;
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
                cwd,
                timeout: 30000,
                env: {
                  ...process.env,
                  GITHUB_TOKEN: process.env.GITHUB_TOKEN?.trim() || '',
                },
              }
            );
            const match = prOut.match(/https:\/\/github\.com\/[^\s]+/);
            if (match) {
              prUrl = match[0].trim();
              this.log.info('Created pull request for %s: %s', branchName, prUrl);
            }
          } catch (prErr: any) {
            this.log.warn(
              'Auto PR creation failed for %s: %s',
              branchName,
              prErr?.message ?? prErr
            );
          }
        }
      }

      const durationMs = Date.now() - startMs;
      return {
        success: true,
        branchName,
        prUrl,
        output: capturedOutput,
        durationMs,
        numTurns: telemetry.numTurns,
        totalTokens: telemetry.totalTokens,
        thinkingTokens: telemetry.thinkingTokens,
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

export interface RemoteSwarmRunnerOptions {
  coordinatorUrl: string;
  runnerId?: string;
  runnerName?: string;
  labels?: string[];
  repositories?: string[];
  registrationToken?: string;
  runnerToken?: string;
  sharedSecret?: string;
  runnerStatePath?: string;
  agyBinPath?: string;
  execFileFn?: ExecFileAsyncFn;
  pollTimeoutMs?: number;
  idlePollIntervalMs?: number;
  prPolicy?: PrPolicy;
  executor?: TaskExecutor;
  logger?: Logger;
}

export class RemoteSwarmRunner {
  private readonly options: RemoteSwarmRunnerOptions;
  private readonly executor: TaskExecutor;
  private readonly log: Logger;
  private runnerId: string;
  private runnerName: string;
  private labels: string[];
  private repositories?: string[];
  private runnerToken?: string;
  private currentExecutingTaskId: string | null = null;
  public isRunning = false;
  private abortController: AbortController | null = null;
  private taskAbortController: AbortController | null = null;
  private authOkUntil = 0;
  private authBlockedUntil = 0;
  private warnedAuthRequired = false;

  constructor(options: RemoteSwarmRunnerOptions) {
    this.options = options;
    // os.hostname() is the container id, so identity must persist across container recreation.
    this.runnerName = options.runnerName?.trim() || `runner-${os.hostname()}`;
    this.runnerId = options.runnerId?.trim() || this.runnerName;
    this.labels = options.labels ?? [];
    this.repositories = options.repositories;
    this.runnerToken = options.runnerToken?.trim() || undefined;
    this.log = options.logger ?? logger.child(`runner:${this.runnerId}`);
    this.executor =
      options.executor ??
      new TaskExecutor({
        agyBinPath: options.agyBinPath || 'agy',
        execFileFn: options.execFileFn,
        logger: this.log,
        prPolicy: options.prPolicy,
        onStatusUpdate: async (status) => {
          if (this.currentExecutingTaskId) {
            await this.reportStatus(
              this.options.coordinatorUrl?.replace(/\/+$/, '') || 'http://127.0.0.1:8484',
              this.buildAuthHeaders(),
              this.currentExecutingTaskId,
              {
                status: status.status,
                runnerId: this.runnerId,
                branchName: status.branchName,
                message: status.message,
              }
            );
          }
        },
      });

    this.loadPersistedState();
  }

  public async checkAuthPreClaim(): Promise<boolean> {
    const now = Date.now();
    if (now < this.authBlockedUntil) {
      return false;
    }
    if (now < this.authOkUntil) {
      return true;
    }

    try {
      const execFile = this.options.execFileFn ?? defaultExecFileAsync;
      const agyBin = this.options.agyBinPath || 'agy';
      await execFile(agyBin, ['--output-format', 'json', 'models'], {
        timeout: 10000,
        windowsHide: true,
      });
      this.authOkUntil = now + 5 * 60 * 1000;
      this.authBlockedUntil = 0;
      if (this.warnedAuthRequired) {
        this.log.info('Antigravity CLI authenticated; resuming swarm task polling');
        this.warnedAuthRequired = false;
      }
      return true;
    } catch (err: unknown) {
      if (isCliAuthFailure(err)) {
        this.authBlockedUntil = now + 30 * 1000;
        this.authOkUntil = 0;
        if (!this.warnedAuthRequired) {
          this.warnedAuthRequired = true;
          this.log.warn(
            '[Blocked] Antigravity CLI is unauthenticated. Pausing swarm task polling until signed in (run: docker exec -it agylity agy)'
          );
        }
        return false;
      }
      return true;
    }
  }

  public getRunnerId(): string {
    return this.runnerId;
  }

  public getRunnerToken(): string | undefined {
    return this.runnerToken;
  }

  private loadPersistedState(): void {
    const statePath = this.options.runnerStatePath;
    if (!statePath || !existsSync(statePath)) return;

    try {
      const raw = readFileSync(statePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedRunnerState>;
      if (parsed.runnerToken && typeof parsed.runnerToken === 'string') {
        this.runnerToken = parsed.runnerToken;
      }
      if (parsed.runnerId && typeof parsed.runnerId === 'string') {
        this.runnerId = parsed.runnerId;
      }
      if (parsed.runnerName && typeof parsed.runnerName === 'string') {
        this.runnerName = parsed.runnerName;
      }
      if (
        Array.isArray(parsed.labels) &&
        (!this.options.labels || this.options.labels.length === 0)
      ) {
        this.labels = parsed.labels.map(String);
      }
      if (
        Array.isArray(parsed.repositories) &&
        (!this.options.repositories || this.options.repositories.length === 0)
      ) {
        this.repositories = parsed.repositories.map(String);
      }
    } catch (err: any) {
      this.log.warn(
        'Failed to load persisted runner state from %s: %s',
        statePath,
        err?.message ?? err
      );
    }
  }

  private savePersistedState(state: PersistedRunnerState): void {
    const statePath = this.options.runnerStatePath;
    if (!statePath) return;

    try {
      mkdirSync(path.dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(state, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (err: any) {
      this.log.warn('Failed to persist runner state to %s: %s', statePath, err?.message ?? err);
    }
  }

  public async registerIfNeeded(): Promise<SwarmRunnerRecord | null> {
    if (this.runnerToken) {
      return null;
    }

    const regToken = this.options.registrationToken?.trim();
    if (!regToken) {
      return null;
    }

    const baseUrl = this.options.coordinatorUrl.replace(/\/+$/, '');
    const res = await ky
      .post(`${baseUrl}/api/runners/register`, {
        json: {
          registrationToken: regToken,
          runnerId: this.options.runnerId?.trim(),
          runnerName: this.options.runnerName?.trim() || undefined,
          labels:
            this.options.labels && this.options.labels.length > 0 ? this.options.labels : undefined,
          repositories:
            this.options.repositories && this.options.repositories.length > 0
              ? this.options.repositories
              : undefined,
          systemInfo: collectRunnerSystemInfo(),
        },
        retry: 0,
        timeout: 15000,
      })
      .json<{ runner: SwarmRunnerRecord; runnerToken: string }>();

    this.runnerId = res.runner.runnerId;
    this.runnerName = res.runner.name;
    this.labels = res.runner.labels;
    if (res.runner.repositories.length > 0) {
      this.repositories = res.runner.repositories;
    }
    this.runnerToken = res.runnerToken;

    this.savePersistedState({
      runnerId: this.runnerId,
      runnerName: this.runnerName,
      labels: this.labels,
      repositories: this.repositories ?? [],
      runnerToken: this.runnerToken,
      coordinatorUrl: baseUrl,
      registeredAt: res.runner.registeredAt,
    });

    this.log.info(
      'Successfully registered runner "%s" (%s, labels=%s)',
      this.runnerName,
      this.runnerId,
      this.labels.join(',') || 'none'
    );

    return res.runner;
  }

  private buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const token = this.runnerToken || this.options.sharedSecret?.trim();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      headers['x-agylity-runner-token'] = token;
    }
    return headers;
  }

  public async pollOnce(): Promise<SwarmTask | null> {
    const isAuthed = await this.checkAuthPreClaim();
    if (!isAuthed) {
      return null;
    }

    await this.registerIfNeeded();

    const baseUrl = this.options.coordinatorUrl.replace(/\/+$/, '');
    const headers = this.buildAuthHeaders();

    const res = await ky
      .post(`${baseUrl}/api/tasks/poll`, {
        headers,
        json: {
          runnerId: this.runnerId,
          runnerName: this.runnerName,
          labels: this.labels,
          repositories: this.repositories,
          systemInfo: collectRunnerSystemInfo(),
          timeoutMs: this.options.pollTimeoutMs ?? 0,
        },
        retry: 0,
        timeout: (this.options.pollTimeoutMs ?? 0) + 10000,
        signal: this.abortController?.signal,
      })
      .json<{ task: SwarmTask | null }>();

    const task = res?.task ?? null;
    if (!task) return null;

    const taskAbort = new AbortController();
    this.taskAbortController = taskAbort;
    let outputTail = '';

    const acceptedClaim = await this.reportStatus(baseUrl, headers, task.id, {
      status: 'executing',
      runnerId: this.runnerId,
      message: `Runner ${this.runnerName} (${this.runnerId}) executing task on ${task.repositoryName}`,
    });
    if (!acceptedClaim) taskAbort.abort();

    const heartbeatTimer = setInterval(() => {
      void this.reportHeartbeat(baseUrl, headers, task.id, outputTail).then((leaseOk) => {
        if (!leaseOk) taskAbort.abort();
      });
    }, 10000);
    heartbeatTimer.unref?.();

    this.currentExecutingTaskId = task.id;
    let result: TaskExecutionResult;
    try {
      result = await this.executor.execute(task, {
        signal: taskAbort.signal,
        onOutput: (tail) => {
          outputTail = tail;
        },
      });
    } finally {
      clearInterval(heartbeatTimer);
      this.currentExecutingTaskId = null;
      if (this.taskAbortController === taskAbort) this.taskAbortController = null;
    }

    if (!acceptedClaim && taskAbort.signal.aborted) {
      return task;
    }

    await this.reportStatus(baseUrl, headers, task.id, {
      status: result.noChanges ? 'no_changes' : result.success ? 'completed' : 'failed',
      runnerId: this.runnerId,
      branchName: result.branchName,
      prUrl: result.prUrl,
      output: result.output,
      error: result.error,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      totalTokens: result.totalTokens,
      thinkingTokens: result.thinkingTokens,
    });

    return task;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    assertRunnerGitCredentials(this.options.repositories);
    this.isRunning = true;
    this.abortController = new AbortController();

    try {
      await this.registerIfNeeded();
    } catch (err: any) {
      this.log.warn(
        'Initial runner registration failed for %s; retrying in the poll loop: %s',
        this.runnerId,
        err?.message ?? err
      );
    }

    const idleIntervalMs = this.options.idlePollIntervalMs ?? 2000;
    this.log.info(
      'Starting outbound swarm runner loop (%s -> %s)',
      this.runnerId,
      this.options.coordinatorUrl
    );

    while (this.isRunning && !this.abortController.signal.aborted) {
      try {
        const claimed = await this.pollOnce();
        if (!this.isRunning || this.abortController.signal.aborted) break;
        if (!claimed && idleIntervalMs > 0) {
          await this.sleep(idleIntervalMs);
        }
      } catch (err: any) {
        if (!this.isRunning || this.abortController.signal.aborted) break;
        this.log.warn('Poll cycle error on runner %s: %s', this.runnerId, err?.message ?? err);
        await this.sleep(Math.max(idleIntervalMs, 3000));
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.abortController?.signal;
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async reportHeartbeat(
    baseUrl: string,
    headers: Record<string, string>,
    taskId: string,
    outputTail: string
  ): Promise<boolean> {
    try {
      const res = await ky.post(`${baseUrl}/api/runner/heartbeat`, {
        headers,
        json: { taskId, runnerId: this.runnerId, outputTail: outputTail || undefined },
        retry: 0,
        timeout: 15000,
        throwHttpErrors: false,
      });
      if (res.status === 409) {
        this.log.debug('Heartbeat refused for task %s; it is no longer ours', taskId);
        return false;
      }
      if (!res.ok) {
        // A coordinator hiccup is not a cancelled task: never abort real work over it.
        this.log.warn('Heartbeat for task %s returned HTTP %d', taskId, res.status);
      }
      return true;
    } catch (err: any) {
      this.log.warn('Heartbeat failed for task %s: %s', taskId, err?.message ?? err);
      return true;
    }
  }

  private async reportStatus(
    baseUrl: string,
    headers: Record<string, string>,
    taskId: string,
    payload: Record<string, unknown>
  ): Promise<boolean> {
    try {
      const res = await ky.post(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/status`, {
        headers,
        json: payload,
        retry: 0,
      });
      try {
        const body = await res.json<{ leaseOk?: boolean }>();
        return body?.leaseOk !== false;
      } catch {
        return true;
      }
    } catch (err: any) {
      if (err?.response?.status === 409) {
        this.log.debug(
          'Coordinator refused the status patch for task %s (already terminal)',
          taskId
        );
        return false;
      }
      this.log.warn('Failed to report status for task %s: %s', taskId, err?.message ?? err);
      return true;
    }
  }

  public stop(): void {
    this.isRunning = false;
    this.abortController?.abort();
    this.taskAbortController?.abort();
  }
}
