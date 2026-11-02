import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ky from 'ky';
import { defaultExecFileAsync, type ExecFileAsyncFn } from '../sentry/discovery.js';
import { isCliAuthFailure } from '../sentry/client.js';
import { logger, type Logger } from '../logs/logger.js';
import type { RunnerSystemInfo, SwarmTask, SwarmWorkerRecord, TaskStatusPatch } from './queue.js';
import { resolveReasoningEffortForModel } from './models.js';

export interface TaskExecutorOptions {
  agyBinPath?: string;
  timeoutMs?: number;
  execFileFn?: ExecFileAsyncFn;
  dirExistsFn?: (dirPath: string) => boolean;
  logger?: Logger;
  onStatusUpdate?: (patch: TaskStatusPatch & { message?: string }) => Promise<void> | void;
}

export interface TaskExecutionResult {
  success: boolean;
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
  workerId: string;
  workerName: string;
  labels: string[];
  repositories: string[];
  runnerToken: string;
  coordinatorUrl: string;
  registeredAt: string;
}

/**
 * Generates a deterministic, URL-safe Git branch name for an isolated continuation task.
 * Never returns 'main' or 'master'.
 */
const buildGitAuthArgs = (repoUrl?: string): string[] => {
  const ghToken = process.env.GITHUB_TOKEN?.trim();
  if (ghToken && (!repoUrl || repoUrl.startsWith('https://github.com/'))) {
    const basicAuth = Buffer.from(`x-access-token:${ghToken}`, 'utf8').toString('base64');
    return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basicAuth}`];
  }
  return [];
};

export const buildContinuationBranchName = (taskId: string, prompt: string): string => {
  const shortId =
    taskId
      .replace(/^task-\d+-/, '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 8) || 'cont';

  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'work';

  return `antigravity/task-${shortId}-${slug}`;
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

/**
 * Gracefully parses NDJSON and JSON telemetry lines from `agy` stdout.
 * Falls back cleanly to empty metadata if stdout contains only plain text.
 */
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
    } catch {
      // Ignore unparseable non-JSON lines
    }
  }

  if (telemetry.totalTokens === undefined && telemetry.inputTokens !== undefined) {
    telemetry.totalTokens = (telemetry.inputTokens || 0) + (telemetry.outputTokens || 0);
  }

  return telemetry;
};

/**
 * Executes a single SwarmTask using Git branch isolation and the official `agy` CLI binary.
 */
export class TaskExecutor {
  private readonly agyBinPath: string;
  private readonly timeoutMs: number;
  private readonly execFileFn: ExecFileAsyncFn;
  private readonly dirExistsFn: (dirPath: string) => boolean;
  private readonly log: Logger;
  private readonly onStatusUpdate?: (
    patch: TaskStatusPatch & { message?: string }
  ) => Promise<void> | void;

  constructor(options: TaskExecutorOptions = {}) {
    this.agyBinPath = options.agyBinPath || 'agy';
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000; // 30 minutes default
    this.execFileFn = options.execFileFn ?? defaultExecFileAsync;
    this.dirExistsFn = options.dirExistsFn ?? existsSync;
    this.log = options.logger ?? logger.child('worker');
    this.onStatusUpdate = options.onStatusUpdate;
  }

  public async execute(task: SwarmTask): Promise<TaskExecutionResult> {
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
          const rawCloneUrl = task.cloneUrl.trim();
          const gitCloneArgs: string[] = [
            ...buildGitAuthArgs(rawCloneUrl),
            'clone',
            '--',
            rawCloneUrl,
            task.repositoryPath,
          ];

          await this.execFileFn('git', gitCloneArgs, {
            timeout: 120000,
          });
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

    try {
      await this.onStatusUpdate?.({
        status: 'executing',
        branchName,
        message: `Checking out isolated branch ${branchName} (from ${baseBranch}) and launching agy (${task.model})`,
      });

      // 1a. Switch back to the repository's default base branch and fast-forward if possible
      // so sequential tasks on the same runner never stack onto previous task branches.
      try {
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
        } catch {
          // Non-fatal: local repo may not have an upstream remote configured
        }
      } catch (baseCheckoutErr: any) {
        this.log.debug(
          'Base branch checkout (%s) skipped before creating %s: %s',
          baseBranch,
          branchName,
          baseCheckoutErr?.message ?? baseCheckoutErr
        );
      }

      // 1b. Checkout isolated continuation branch from base HEAD
      await this.execFileFn('git', ['checkout', '-B', branchName], {
        cwd,
        timeout: 30000,
      });

      // 2. Dispatch prompt via official `agy` CLI binary with explicit model & effort
      const safeEffort = resolveReasoningEffortForModel(task.model, task.effort);
      const agyArgs: string[] = [
        '-p',
        task.prompt,
        '--mode',
        'auto',
        '--dangerously-skip-permissions',
        '--model',
        task.model,
        '--effort',
        safeEffort,
      ];

      this.log.info(
        'Executing agy task %s in %s on branch %s (model=%s, effort=%s)',
        task.id,
        cwd,
        branchName,
        task.model,
        safeEffort
      );

      const { stdout: agyStdout, stderr: agyStderr } = await this.execFileFn(
        this.agyBinPath,
        agyArgs,
        {
          cwd,
          timeout: this.timeoutMs,
        }
      );

      const combinedOutput = [agyStdout?.trim(), agyStderr?.trim()].filter(Boolean).join('\n');

      // 3. Optional verification command (e.g. "npm test")
      if (task.verifyCommand && task.verifyCommand.trim() !== '') {
        const trimmed = task.verifyCommand.trim();
        if (/[;&|`$><\r\n]/.test(trimmed)) {
          throw new Error('Verification command contains illegal shell metacharacters');
        }
        const parts = trimmed.split(/\s+/);
        const cmd = parts[0]!;
        const cmdArgs = parts.slice(1);
        const ALLOWED_TEST_RUNNERS = new Set([
          'npm',
          'pnpm',
          'yarn',
          'npx',
          'node',
          'pytest',
          'cargo',
          'go',
        ]);
        if (!ALLOWED_TEST_RUNNERS.has(cmd)) {
          throw new Error(
            `Verification command '${cmd}' is not in approved test runner allowlist (${Array.from(ALLOWED_TEST_RUNNERS).join(', ')})`
          );
        }
        await this.execFileFn(cmd, cmdArgs, {
          cwd,
          timeout: 10 * 60 * 1000,
        });
      }

      // 4. Commit changes to continuation branch if working tree is dirty
      let commitsProduced = false;
      try {
        const { stdout: statusOut } = await this.execFileFn('git', ['status', '--porcelain'], {
          cwd,
          timeout: 15000,
        });
        if (statusOut && statusOut.trim() !== '') {
          await this.execFileFn('git', ['add', '-A'], { cwd, timeout: 15000 });
          const authorName = process.env.GIT_AUTHOR_NAME || 'agylity[bot]';
          const authorEmail = process.env.GIT_AUTHOR_EMAIL || 'agylity@users.noreply.github.com';
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

      // Check if any commits exist relative to base branch
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
        } catch {
          // Best effort check
        }
      }

      // Zero-diff branch cleanup: if no commits were produced, delete untouched branch
      if (!commitsProduced) {
        try {
          await this.execFileFn('git', ['checkout', baseBranch], { cwd, timeout: 15000 });
          await this.execFileFn('git', ['branch', '-D', branchName], { cwd, timeout: 15000 });
          this.log.info(
            'Zero diff produced for task %s; cleaned up local branch %s',
            task.id,
            branchName
          );
        } catch {
          // Cleanup best-effort
        }
        return {
          success: true,
          branchName: baseBranch,
          output: combinedOutput,
          durationMs: Date.now() - startMs,
        };
      }

      let prUrl: string | undefined;

      // 5. Push continuation branch to origin if pushBranch is enabled
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
          return {
            success: false,
            branchName,
            output: combinedOutput,
            error: `Git push to origin/${branchName} failed: ${pushErrMsg}`,
            durationMs: Date.now() - startMs,
          };
        }

        // Automatic PR Creation via native gh CLI if autoCreatePr is enabled
        if (task.autoCreatePr) {
          try {
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
                `Automated pull request dispatched by Agylity for task \`${task.id}\`.\n\n### Task Prompt\n${task.prompt}`,
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
      const telemetry = parseAgyTelemetry(agyStdout);
      return {
        success: true,
        branchName,
        prUrl,
        output: combinedOutput,
        durationMs,
        numTurns: telemetry.numTurns,
        totalTokens: telemetry.totalTokens,
        thinkingTokens: telemetry.thinkingTokens,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startMs;
      const errMessage = err?.stderr?.trim() || err?.message || String(err);
      this.log.error('Task %s execution failed: %s', task.id, errMessage);
      const telemetry = parseAgyTelemetry(err?.stdout);
      return {
        success: false,
        branchName,
        output: err?.stdout?.trim() || '',
        error: errMessage,
        durationMs,
        numTurns: telemetry.numTurns,
        totalTokens: telemetry.totalTokens,
        thinkingTokens: telemetry.thinkingTokens,
      };
    }
  }
}

export interface RemoteSwarmWorkerOptions {
  coordinatorUrl: string;
  workerId?: string;
  workerName?: string;
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
  executor?: TaskExecutor;
  logger?: Logger;
}

/**
 * Outbound long-polling swarm runner client (`agylity-worker`) that exchanges
 * one-time registration tokens (`agyr_reg_...`) for persistent runner credentials (`agyr_run_...`),
 * pulls tasks from `/api/tasks/poll`, and reports execution progress to `/api/tasks/:id/status`.
 */
export class RemoteSwarmWorker {
  private readonly options: RemoteSwarmWorkerOptions;
  private readonly executor: TaskExecutor;
  private readonly log: Logger;
  private workerId: string;
  private workerName: string;
  private labels: string[];
  private repositories?: string[];
  private runnerToken?: string;
  private currentExecutingTaskId: string | null = null;
  public isRunning = false;
  private abortController: AbortController | null = null;
  private authOkUntil = 0;
  private authBlockedUntil = 0;
  private warnedAuthRequired = false;

  constructor(options: RemoteSwarmWorkerOptions) {
    this.options = options;
    this.workerId = options.workerId?.trim() || `runner-${os.hostname()}`;
    this.workerName = options.workerName?.trim() || this.workerId;
    this.labels = options.labels ?? [];
    this.repositories = options.repositories;
    this.runnerToken = options.runnerToken?.trim() || undefined;
    this.log = options.logger ?? logger.child(`runner:${this.workerId}`);
    this.executor =
      options.executor ??
      new TaskExecutor({
        agyBinPath: options.agyBinPath || 'agy',
        execFileFn: options.execFileFn,
        logger: this.log,
        onStatusUpdate: async (status) => {
          if (this.currentExecutingTaskId) {
            await this.reportStatus(
              this.options.coordinatorUrl?.replace(/\/+$/, '') || 'http://127.0.0.1:8484',
              this.buildAuthHeaders(),
              this.currentExecutingTaskId,
              {
                status: status.status,
                workerId: this.workerId,
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

  public getWorkerId(): string {
    return this.workerId;
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
      if (parsed.workerId && typeof parsed.workerId === 'string') {
        this.workerId = parsed.workerId;
      }
      if (parsed.workerName && typeof parsed.workerName === 'string') {
        this.workerName = parsed.workerName;
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

  /**
   * Exchanges a one-time `registrationToken` (`agyr_reg_...`) for a persistent `runnerToken` (`agyr_run_...`)
   * if this runner does not already have a persistent token.
   */
  public async registerIfNeeded(): Promise<SwarmWorkerRecord | null> {
    if (this.runnerToken) {
      return null;
    }

    const regToken = this.options.registrationToken?.trim();
    if (!regToken) {
      return null;
    }

    const baseUrl = this.options.coordinatorUrl.replace(/\/+$/, '');
    const res = await ky
      .post(`${baseUrl}/api/workers/register`, {
        json: {
          registrationToken: regToken,
          workerId: this.options.workerId?.trim(),
          workerName: this.options.workerName?.trim() || undefined,
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
      .json<{ worker: SwarmWorkerRecord; runnerToken: string }>();

    this.workerId = res.worker.workerId;
    this.workerName = res.worker.name;
    this.labels = res.worker.labels;
    if (res.worker.repositories.length > 0) {
      this.repositories = res.worker.repositories;
    }
    this.runnerToken = res.runnerToken;

    this.savePersistedState({
      workerId: this.workerId,
      workerName: this.workerName,
      labels: this.labels,
      repositories: this.repositories ?? [],
      runnerToken: this.runnerToken,
      coordinatorUrl: baseUrl,
      registeredAt: res.worker.registeredAt,
    });

    this.log.info(
      'Successfully registered runner "%s" (%s, labels=%s)',
      this.workerName,
      this.workerId,
      this.labels.join(',') || 'none'
    );

    return res.worker;
  }

  private buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const token = this.runnerToken || this.options.sharedSecret?.trim();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      headers['x-agylity-worker-token'] = token;
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
          workerId: this.workerId,
          workerName: this.workerName,
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

    await this.reportStatus(baseUrl, headers, task.id, {
      status: 'executing',
      workerId: this.workerId,
      message: `Runner ${this.workerName} (${this.workerId}) executing task on ${task.repositoryName}`,
    });

    const heartbeatTimer = setInterval(() => {
      void this.reportStatus(baseUrl, headers, task.id, {
        status: 'executing',
        workerId: this.workerId,
      });
    }, 30000);
    heartbeatTimer.unref?.();

    this.currentExecutingTaskId = task.id;
    let result: TaskExecutionResult;
    try {
      result = await this.executor.execute(task);
    } finally {
      clearInterval(heartbeatTimer);
      this.currentExecutingTaskId = null;
    }

    await this.reportStatus(baseUrl, headers, task.id, {
      status: result.success ? 'completed' : 'failed',
      workerId: this.workerId,
      branchName: result.branchName,
      output: result.output,
      error: result.error,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      totalTokens: result.totalTokens,
      thinkingTokens: result.thinkingTokens,
    });

    return task;
  }

  /**
   * Starts the continuous outbound long-poll loop until `stop()` is called.
   */
  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.abortController = new AbortController();

    await this.registerIfNeeded();

    const idleIntervalMs = this.options.idlePollIntervalMs ?? 2000;
    this.log.info(
      'Starting outbound swarm runner loop (%s -> %s)',
      this.workerId,
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
        this.log.warn('Poll cycle error on runner %s: %s', this.workerId, err?.message ?? err);
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

  private async reportStatus(
    baseUrl: string,
    headers: Record<string, string>,
    taskId: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    try {
      await ky.post(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/status`, {
        headers,
        json: payload,
        retry: 0,
      });
    } catch (err: any) {
      this.log.warn('Failed to report status for task %s: %s', taskId, err?.message ?? err);
    }
  }

  public stop(): void {
    this.isRunning = false;
    this.abortController?.abort();
  }
}
