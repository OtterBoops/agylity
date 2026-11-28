import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { type PrPolicy } from '../shared/contracts.js';
import { resolveTaskTitle } from '../shared/titles.js';
import { resolveGithubRepoSlug } from '../shared/github.js';
import { AgyStreamFormatter } from './agyStream.js';
import { stripUntrustedAttribution } from './attribution.js';
import { ensureRepository, type RepositoryDeps } from './repository.js';
import {
  applyPrPolicy,
  discardBranch,
  openPullRequest,
  pushTaskBranch,
  type PublishDeps,
} from './publish.js';
import {
  commitWorkingTree,
  countCommitsAhead,
  gitStatusPorcelain,
  listUntracked,
  type CommitDeps,
} from './commit.js';
import {
  AGY_USAGE_ERROR_MAX_BYTES,
  FLAG_REJECTION_RE,
  buildCapacityContinuationPrompt,
  capacityFailureSurface,
  hasTelemetryValues,
  isCapacityExhaustedOutput,
  parseAgyTelemetry,
  scanAgyStdout,
  sumAgyTelemetry,
  type TaskExecutionTelemetry,
} from './cascade.js';
export type { CapacityContinuationContext, TaskExecutionTelemetry } from './cascade.js';
export {
  buildCapacityContinuationPrompt,
  isCapacityExhaustedOutput,
  parseAgyTelemetry,
  sumAgyTelemetry,
} from './cascade.js';
import {
  combineOutput,
  type ExecDeps,
  type SpawnFn,
  runStreamedCommand,
  defaultKillProcessTree,
  spawnFromExecFileFn,
} from './exec.js';
export type { SpawnFn } from './exec.js';
export { defaultKillProcessTree, spawnFromExecFileFn } from './exec.js';
import { AGYLITY_FOOTER_MARKER, buildPrompt } from './prompt.js';
import { buildGitAuthArgs, redactGitSecrets } from './git.js';
import {
  ALLOWED_TEST_RUNNERS,
  INLINE_CODE_FLAGS,
  buildContinuationBranchName,
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

/** A failed attempt carries the agent's own last words, which the caller surfaces. */
interface AttemptError extends Error {
  agyText?: string;
}

export interface TaskExecuteOptions {
  signal?: AbortSignal;
  onOutput?: (tail: string) => void;
  /** Leased from the coordinator for this task only; never read from the runner's own environment. */
  githubToken?: string;
  /** The coordinator's configured commit identity, when it has one: dashboard override, then its env. */
  gitIdentity?: { name?: string; email?: string };
}

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

// GitHub allows 256; a PR title carries the issue subject, which the 72-char task-title budget truncates.
const PR_TITLE_MAX_LENGTH = 200;
const ISSUE_DELIVERABLE_LIMIT = 50;
const ISSUE_DELIVERABLE_MAX_URLS = 10;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

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
        if (err && typeof err === 'object') (err as AttemptError).agyText = formatter.text;
        throw err;
      }
      this.log.warn('agy rejected --output-format stream-json; retrying this attempt in text mode');
      const streamed = await this.runStreamedCommand(this.agyBinPath, args, options);
      return { ...streamed, text: '' };
    }
  }

  private execDeps(): ExecDeps {
    return { spawn: this.spawnFn, log: this.log, killProcessTree: this.killProcessTreeFn };
  }

  private runStreamedCommand(
    file: string,
    args: readonly string[],
    options: Parameters<typeof runStreamedCommand>[2]
  ): Promise<{ stdout: string; stderr: string }> {
    return runStreamedCommand(file, args, options, this.execDeps());
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
  private repositoryDeps(): RepositoryDeps {
    return {
      execFile: this.execFileFn,
      log: this.log,
      dirExists: this.dirExistsFn,
      mirrorCacheDir: this.mirrorCacheDir,
      useMirrorCache: this.useMirrorCache,
    };
  }

  private async ensureRepository(
    task: SwarmTask,
    branchName: string,
    startMs: number,
    githubToken: string | undefined
  ): Promise<TaskExecutionResult | null> {
    const { error } = await ensureRepository(
      {
        repositoryPath: task.repositoryPath,
        cloneUrl: task.cloneUrl,
        githubToken,
        onCloning: async (cloneUrl) => {
          await this.onStatusUpdate?.({
            status: 'executing',
            branchName,
            message: `Cloning repository from ${cloneUrl} into ${task.repositoryPath}`,
          });
        },
      },
      this.repositoryDeps()
    );
    return error ? this.failureResult(branchName, startMs, error) : null;
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
  private commitDeps(): CommitDeps {
    return { execFile: this.execFileFn, log: this.log };
  }

  private gitStatusPorcelain(cwd: string): Promise<string> {
    return gitStatusPorcelain(cwd, this.commitDeps());
  }

  private listUntracked(cwd: string): Promise<string[]> {
    return listUntracked(cwd, this.commitDeps());
  }

  private countCommitsAhead(cwd: string, baseBranch: string): Promise<number> {
    return countCommitsAhead(cwd, baseBranch, this.commitDeps());
  }

  private commitWorkingTree(
    task: SwarmTask,
    branchName: string,
    baseBranch: string,
    gitIdentityEnv: Record<string, string>,
    untrackedPaths: readonly string[]
  ): Promise<{ commitsProduced: boolean; deliverableTitle?: string; commitError?: string }> {
    return commitWorkingTree(
      {
        repositoryPath: task.repositoryPath,
        title: task.title,
        prompt: task.prompt,
        branchName,
        baseBranch,
        gitIdentityEnv,
        untrackedPaths,
      },
      this.commitDeps()
    );
  }

  private publishDeps(): PublishDeps {
    return { execFile: this.execFileFn, log: this.log };
  }

  private discardBranch(cwd: string, baseBranch: string, branchName: string): Promise<void> {
    return discardBranch(cwd, baseBranch, branchName, this.publishDeps());
  }

  private pushTaskBranch(
    task: SwarmTask,
    branchName: string,
    githubToken: string | undefined
  ): Promise<string | null> {
    return pushTaskBranch(
      {
        repositoryPath: task.repositoryPath,
        cloneUrl: task.cloneUrl,
        branchName,
        githubToken,
      },
      this.publishDeps()
    );
  }

  private openPullRequest(
    task: SwarmTask,
    branchName: string,
    baseBranch: string,
    hop: CascadeHop,
    githubToken: string | undefined,
    title: string,
    capturedOutput: string
  ): Promise<string | undefined> {
    return openPullRequest(
      {
        repositoryPath: task.repositoryPath,
        branchName,
        baseBranch,
        hop,
        githubToken,
        title,
        capturedOutput,
        tier: task.tier || 'immediate',
        issueNumber: task.originIssueNumber,
        prompt: task.prompt,
      },
      this.publishDeps()
    );
  }

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
    const suppressed = await applyPrPolicy(
      {
        repositoryPath: task.repositoryPath,
        branchName: context.branchName,
        baseBranch: context.baseBranch,
        prPolicy: context.prPolicy,
        githubToken: context.githubToken,
        taskId: task.id,
      },
      this.publishDeps()
    );
    if (!suppressed) return null;
    return this.noChangesResult(
      `${context.output}\n\n${suppressed.detail}`,
      context.startMs,
      context.telemetry
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
          const prTitle = resolveTaskTitle(prTitleSource, task.prompt, PR_TITLE_MAX_LENGTH);
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
