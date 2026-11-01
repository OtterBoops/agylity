import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ky from 'ky';
import { defaultExecFileAsync, type ExecFileAsyncFn } from '../sentry/discovery.js';
import { logger, type Logger } from '../logs/logger.js';
import type { RunnerSystemInfo, SwarmTask, SwarmWorkerRecord, TaskStatusPatch } from './queue.js';
import type { WorkerMode } from './models.js';

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
  output: string;
  error?: string;
  durationMs: number;
}

export interface PersistedRunnerState {
  workerId: string;
  workerName: string;
  workerMode: WorkerMode;
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
          let authCloneUrl = task.cloneUrl.trim();
          const ghToken = process.env.GITHUB_TOKEN?.trim();
          if (ghToken && authCloneUrl.startsWith('https://github.com/')) {
            authCloneUrl = authCloneUrl.replace(
              'https://github.com/',
              `https://x-access-token:${ghToken}@github.com/`
            );
          }
          await this.execFileFn('git', ['clone', authCloneUrl, task.repositoryPath], {
            timeout: 120000,
          });
        } catch (cloneErr: any) {
          const errMsg = `Failed to clone repository from ${task.cloneUrl}: ${cloneErr?.message || cloneErr}`;
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
          await this.execFileFn('git', ['pull', '--ff-only'], {
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
      const agyArgs: string[] = [
        '-p',
        task.prompt,
        '--mode',
        'auto',
        '--dangerously-skip-permissions',
        '--model',
        task.model,
        '--effort',
        task.effort || 'high',
      ];

      this.log.info(
        'Executing agy task %s in %s on branch %s (model=%s, effort=%s)',
        task.id,
        cwd,
        branchName,
        task.model,
        task.effort || 'high'
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
        const parts = task.verifyCommand.trim().split(/\s+/);
        const cmd = parts[0]!;
        const cmdArgs = parts.slice(1);
        await this.execFileFn(cmd, cmdArgs, {
          cwd,
          timeout: 10 * 60 * 1000,
        });
      }

      // 4. Commit and push continuation branch if pushBranch is enabled
      if (task.pushBranch) {
        try {
          const { stdout: statusOut } = await this.execFileFn('git', ['status', '--porcelain'], {
            cwd,
            timeout: 15000,
          });
          if (statusOut && statusOut.trim() !== '') {
            await this.execFileFn('git', ['add', '-A'], { cwd, timeout: 15000 });
            await this.execFileFn(
              'git',
              ['commit', '-m', `Complete Antigravity continuation task ${task.id}`],
              {
                cwd,
                timeout: 30000,
                env: {
                  ...process.env,
                  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'agylity[bot]',
                  GIT_AUTHOR_EMAIL:
                    process.env.GIT_AUTHOR_EMAIL || 'agylity@users.noreply.github.com',
                  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'agylity[bot]',
                  GIT_COMMITTER_EMAIL:
                    process.env.GIT_COMMITTER_EMAIL || 'agylity@users.noreply.github.com',
                },
              }
            );
          }
          await this.execFileFn('git', ['push', '-u', 'origin', branchName], {
            cwd,
            timeout: 60000,
          });
        } catch (gitPushErr: any) {
          this.log.debug(
            'Git commit/push step skipped or non-fatal warning on %s: %s',
            branchName,
            gitPushErr?.message ?? gitPushErr
          );
        }
      }

      const durationMs = Date.now() - startMs;
      return {
        success: true,
        branchName,
        output: combinedOutput,
        durationMs,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startMs;
      const errMessage = err?.stderr?.trim() || err?.message || String(err);
      this.log.error('Task %s execution failed: %s', task.id, errMessage);
      return {
        success: false,
        branchName,
        output: err?.stdout?.trim() || '',
        error: errMessage,
        durationMs,
      };
    }
  }
}

export interface RemoteSwarmWorkerOptions {
  coordinatorUrl: string;
  workerId?: string;
  workerName?: string;
  workerMode?: WorkerMode;
  labels?: string[];
  repositories?: string[];
  registrationToken?: string;
  runnerToken?: string;
  sharedSecret?: string;
  runnerStatePath?: string;
  agyBinPath?: string;
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
  private workerMode: WorkerMode;
  private labels: string[];
  private repositories?: string[];
  private runnerToken?: string;
  public isRunning = false;
  private abortController: AbortController | null = null;

  constructor(options: RemoteSwarmWorkerOptions) {
    this.options = options;
    this.workerId = options.workerId?.trim() || `runner-${os.hostname()}`;
    this.workerName = options.workerName?.trim() || this.workerId;
    this.workerMode = options.workerMode ?? 'headless';
    this.labels = options.labels ?? [];
    this.repositories = options.repositories;
    this.runnerToken = options.runnerToken?.trim() || undefined;
    this.log = options.logger ?? logger.child(`runner:${this.workerId}`);
    this.executor =
      options.executor ??
      new TaskExecutor({
        agyBinPath: options.agyBinPath || 'agy',
        logger: this.log,
      });

    this.loadPersistedState();
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
        parsed.workerMode === 'headless' ||
        parsed.workerMode === 'visible' ||
        parsed.workerMode === 'any'
      ) {
        this.workerMode = parsed.workerMode;
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
          workerMode: this.options.workerMode,
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
    this.workerMode = res.worker.workerMode;
    this.labels = res.worker.labels;
    if (res.worker.repositories.length > 0) {
      this.repositories = res.worker.repositories;
    }
    this.runnerToken = res.runnerToken;

    this.savePersistedState({
      workerId: this.workerId,
      workerName: this.workerName,
      workerMode: this.workerMode,
      labels: this.labels,
      repositories: this.repositories ?? [],
      runnerToken: this.runnerToken,
      coordinatorUrl: baseUrl,
      registeredAt: res.worker.registeredAt,
    });

    this.log.info(
      'Successfully registered runner "%s" (%s, mode=%s, labels=%s)',
      this.workerName,
      this.workerId,
      this.workerMode,
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
    await this.registerIfNeeded();

    const baseUrl = this.options.coordinatorUrl.replace(/\/+$/, '');
    const headers = this.buildAuthHeaders();

    const res = await ky
      .post(`${baseUrl}/api/tasks/poll`, {
        headers,
        json: {
          workerId: this.workerId,
          workerName: this.workerName,
          workerMode: this.workerMode,
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

    let result: TaskExecutionResult;
    try {
      result = await this.executor.execute(task);
    } finally {
      clearInterval(heartbeatTimer);
    }

    await this.reportStatus(baseUrl, headers, task.id, {
      status: result.success ? 'completed' : 'failed',
      workerId: this.workerId,
      branchName: result.branchName,
      output: result.output,
      error: result.error,
      durationMs: result.durationMs,
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
      'Starting outbound swarm runner loop (%s -> %s, mode=%s)',
      this.workerId,
      this.options.coordinatorUrl,
      this.workerMode
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
