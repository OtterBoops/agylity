import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ky from 'ky';
import { defaultExecFileAsync, type ExecFileAsyncFn } from '../sentry/discovery.js';
import { isCliAuthFailure } from '../sentry/client.js';
import { logger, type Logger } from '../logs/logger.js';
import type { RunnerSystemInfo, SwarmRunnerRecord, SwarmTask } from '../coordinator/queue.js';
import type { PrPolicy } from '../config/schema.js';
import { TaskExecutor, type TaskExecutionResult } from './executor.js';
import { warnLegacyGithubToken } from './git.js';
import { AgyUpdater, type AgyUpdaterLike } from '../agy/updater.js';

// The coordinator rejects a JSON body over 64 KB, so an untruncated run output would turn a
// finished task into a 413 and a lease-expiry failure.
export const STATUS_BODY_MAX_BYTES = 56 * 1024;

const clipReportText = (text: string, budgetBytes: number): string => {
  if (budgetBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= budgetBytes) return text;

  const marker = '\n\n[... middle of the output truncated by the runner ...]\n\n';
  let keep = Math.floor((budgetBytes - Buffer.byteLength(marker, 'utf8')) / 2);
  // Slice lengths are UTF-16 units, so the byte budget is re-measured and halved until it holds.
  for (let attempt = 0; keep > 0 && attempt < 12; attempt++) {
    const head = text.slice(0, keep).replace(/\s+$/, '');
    const tail = text.slice(text.length - keep).replace(/^\s+/, '');
    const candidate = `${head}${marker}${tail}`;
    if (Buffer.byteLength(candidate, 'utf8') <= budgetBytes) return candidate;
    keep = Math.floor(keep / 2);
  }
  return '';
};

export const fitStatusPayload = (
  payload: Record<string, unknown>,
  maxBytes: number = STATUS_BODY_MAX_BYTES
): Record<string, unknown> => {
  const bytesOf = (value: Record<string, unknown>): number =>
    Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytesOf(payload) <= maxBytes) return payload;

  const fitted: Record<string, unknown> = { ...payload };
  for (const key of ['output', 'error'] as const) {
    if (typeof fitted[key] !== 'string' || fitted[key] === '') continue;
    fitted[key] = '';
    fitted[key] = clipReportText(String(payload[key]), maxBytes - bytesOf(fitted) - 32);
    if (bytesOf(fitted) <= maxBytes) break;
    delete fitted[key];
  }
  return fitted;
};

export interface PersistedRunnerState {
  runnerId: string;
  runnerName: string;
  labels: string[];
  repositories: string[];
  runnerToken: string;
  coordinatorUrl: string;
  registeredAt: string;
}

interface PollResponse {
  task: SwarmTask | null;
  credentialsAvailable?: boolean;
  leaseBlocked?: 'missing_github_token';
  githubToken?: string;
}

export const collectRunnerSystemInfo = (agyVersion?: string | null): RunnerSystemInfo => ({
  hostname: os.hostname(),
  platform: process.platform,
  arch: process.arch,
  agyVersion: agyVersion ?? null,
});

const HEARTBEAT_INTERVAL_MS = 10000;
const STATUS_REPORT_ATTEMPTS = 2;
const CREDENTIAL_REJECT_BACKOFF_MS = 60_000;

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
  agyUpdateIntervalHours?: number;
  agyUpdater?: AgyUpdaterLike;
  prPolicy?: PrPolicy;
  executor?: TaskExecutor;
  logger?: Logger;
}

export class RemoteSwarmRunner {
  private readonly options: RemoteSwarmRunnerOptions;
  private readonly executor: TaskExecutor;
  private readonly log: Logger;
  private readonly agyUpdater: AgyUpdaterLike;
  private readonly agyUpdateIntervalHours: number;
  private agyUpdateTimer: NodeJS.Timeout | null = null;
  private agyUpdateInFlight = false;
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
  private credentialRejectedUntil = 0;
  private warnedCredentialRejected = false;
  private warnedMissingLeaseCredential = false;

  constructor(options: RemoteSwarmRunnerOptions) {
    this.options = options;
    // os.hostname() is the container id, so identity must persist across container recreation.
    this.runnerName = options.runnerName?.trim() || `runner-${os.hostname()}`;
    this.runnerId = options.runnerId?.trim() || this.runnerName;
    this.labels = options.labels ?? [];
    this.repositories = options.repositories;
    this.runnerToken = options.runnerToken?.trim() || undefined;
    this.log = options.logger ?? logger.child(`runner:${this.runnerId}`);
    this.agyUpdateIntervalHours = options.agyUpdateIntervalHours ?? 24;
    this.agyUpdater =
      options.agyUpdater ??
      new AgyUpdater({
        agyBinPath: options.agyBinPath || 'agy',
        execFileFn: options.execFileFn,
        logger: this.log.child('agy'),
      });
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
              this.baseUrl() || 'http://127.0.0.1:8484',
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

  /** The configured coordinator base URL without a trailing slash. */
  private baseUrl(): string {
    return this.options.coordinatorUrl.replace(/\/+$/, '');
  }

  private loadPersistedState(): void {
    const statePath = this.options.runnerStatePath;
    if (!statePath || !existsSync(statePath)) return;

    try {
      const raw = readFileSync(statePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedRunnerState>;
      // An explicit flag or env var must outrank the file, or a rotated credential can never take effect.
      if (!this.runnerToken && typeof parsed.runnerToken === 'string' && parsed.runnerToken) {
        this.runnerToken = parsed.runnerToken;
      }
      if (
        !this.options.runnerId?.trim() &&
        typeof parsed.runnerId === 'string' &&
        parsed.runnerId
      ) {
        this.runnerId = parsed.runnerId;
      }
      if (
        !this.options.runnerName?.trim() &&
        typeof parsed.runnerName === 'string' &&
        parsed.runnerName
      ) {
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

    const baseUrl = this.baseUrl();
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
          systemInfo: collectRunnerSystemInfo(this.agyUpdater?.getCachedVersion?.() ?? null),
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
    // A rejected credential cannot fix itself: polling on would only repeat the same 401.
    if (Date.now() < this.credentialRejectedUntil) return null;

    const isAuthed = await this.checkAuthPreClaim();
    if (!isAuthed) {
      return null;
    }

    await this.withCredentialTracking(() => this.registerIfNeeded());

    const baseUrl = this.baseUrl();
    const headers = this.buildAuthHeaders();

    const res = await this.withCredentialTracking(() =>
      ky
        .post(`${baseUrl}/api/tasks/poll`, {
          headers,
          json: {
            runnerId: this.runnerId,
            runnerName: this.runnerName,
            labels: this.labels,
            repositories: this.repositories,
            systemInfo: collectRunnerSystemInfo(this.agyUpdater?.getCachedVersion?.() ?? null),
            timeoutMs: this.options.pollTimeoutMs ?? 0,
          },
          retry: 0,
          timeout: (this.options.pollTimeoutMs ?? 0) + 10000,
          signal: this.abortController?.signal,
        })
        .json<PollResponse>()
    );

    this.credentialRejectedUntil = 0;
    this.warnedCredentialRejected = false;
    this.noteCoordinatorCredentials(res.credentialsAvailable, res.leaseBlocked);
    const task = res.task;
    if (!task) return null;

    const taskAbort = new AbortController();
    this.taskAbortController = taskAbort;
    let outputTail = '';
    // Marked busy before the claim is announced: the idle gate and the status callback both key off
    // this id, and an update must never run between the executing report and the executor starting.
    this.currentExecutingTaskId = task.id;

    const acceptedClaim = await this.reportStatus(baseUrl, headers, task.id, {
      status: 'executing',
      runnerId: this.runnerId,
      message: `Runner ${this.runnerName} (${this.runnerId}) executing task on ${task.repositoryName}`,
    });
    if (!acceptedClaim) taskAbort.abort();

    let heartbeatInFlight = false;
    const heartbeatTimer = setInterval(() => {
      // A slow beat must not stack up behind itself and multiply failure reports.
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void this.reportHeartbeat(baseUrl, headers, task.id, outputTail)
        .then((leaseOk) => {
          if (!leaseOk) taskAbort.abort();
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();

    let result: TaskExecutionResult;
    try {
      result = await this.executor.execute(task, {
        signal: taskAbort.signal,
        onOutput: (tail) => {
          outputTail = tail;
        },
        // Held in memory for this task only: the lease is never written to runner.json or a log.
        githubToken: res.githubToken,
      });
    } finally {
      clearInterval(heartbeatTimer);
      this.currentExecutingTaskId = null;
      if (this.taskAbortController === taskAbort) this.taskAbortController = null;
    }

    if (!acceptedClaim && taskAbort.signal.aborted) {
      return task;
    }

    await this.reportStatus(
      baseUrl,
      headers,
      task.id,
      {
        status: result.noChanges ? 'no_changes' : result.success ? 'completed' : 'failed',
        runnerId: this.runnerId,
        // `branchName` may be null: the coordinator clears the column for a discarded branch.
        branchName: result.branchName,
        prUrl: result.prUrl,
        issueUrls: result.issueUrls,
        title: result.resolvedTitle,
        output: result.output,
        error: result.error,
        durationMs: result.durationMs,
        numTurns: result.numTurns,
        totalTokens: result.totalTokens,
        thinkingTokens: result.thinkingTokens,
      },
      { attempts: STATUS_REPORT_ATTEMPTS }
    );

    return task;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    warnLegacyGithubToken(this.log);
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

    this.scheduleAgyUpdateTimer();

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

  /**
   * Surfaces the one coordinator-side misconfiguration that strands GitHub work: with no token
   * configured, every GitHub-remote task is withheld and this runner would otherwise just idle.
   */
  private noteCoordinatorCredentials(
    credentialsAvailable: boolean | undefined,
    leaseBlocked: 'missing_github_token' | undefined
  ): void {
    if (credentialsAvailable !== false) {
      this.warnedMissingLeaseCredential = false;
      return;
    }
    if (this.warnedMissingLeaseCredential) return;
    this.warnedMissingLeaseCredential = true;
    this.log.error(
      leaseBlocked === 'missing_github_token'
        ? 'Coordinator has no GitHub token configured: GitHub-remote tasks cannot be leased until one is set in the dashboard settings'
        : 'Coordinator reports no GitHub token configured: GitHub work will be refused until one is set in the dashboard settings'
    );
  }

  private scheduleAgyUpdateTimer(): void {
    if (this.agyUpdateTimer) {
      clearTimeout(this.agyUpdateTimer);
      this.agyUpdateTimer = null;
    }
    if (!(this.agyUpdateIntervalHours > 0)) return;

    // setTimeout overflows above 2^31-1 ms and fires immediately, so the delay is clamped.
    const intervalMs = Math.min(this.agyUpdateIntervalHours * 3600 * 1000, 2_147_483_647);
    const arm = (): void => {
      this.agyUpdateTimer = setTimeout(() => {
        void this.runScheduledAgyUpdate().finally(() => {
          if (this.isRunning) arm();
        });
      }, intervalMs);
      this.agyUpdateTimer.unref?.();
    };
    arm();
  }

  /** Idle-only: an executing task owns the binary, so the refresh waits for the next idle tick. */
  public async runScheduledAgyUpdate(): Promise<boolean> {
    if (this.currentExecutingTaskId !== null || this.agyUpdateInFlight) return false;
    this.agyUpdateInFlight = true;
    try {
      await this.agyUpdater.update();
      return true;
    } catch (err: any) {
      this.log.warn('Scheduled agy update failed: %s', err?.message ?? err);
      return false;
    } finally {
      this.agyUpdateInFlight = false;
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

  /** A 401/403 is terminal for the credential, so it is noted before the error propagates. */
  private async withCredentialTracking<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      this.noteCredentialRejection(err);
      throw err;
    }
  }

  /** Treats a 401/403 as terminal for this credential and backs polling off instead of looping. */
  private noteCredentialRejection(err: unknown): void {
    const status = (err as { response?: { status?: number } } | undefined)?.response?.status;
    if (status !== 401 && status !== 403) return;

    this.credentialRejectedUntil = Date.now() + CREDENTIAL_REJECT_BACKOFF_MS;
    if (this.warnedCredentialRejected) return;
    this.warnedCredentialRejected = true;
    this.log.warn(
      '[Blocked] The coordinator rejected this runner credential (HTTP %d). Pausing polling for %ds; mint a new registration token to rejoin.',
      status,
      CREDENTIAL_REJECT_BACKOFF_MS / 1000
    );
  }

  private async reportStatus(
    baseUrl: string,
    headers: Record<string, string>,
    taskId: string,
    payload: Record<string, unknown>,
    options: { attempts?: number } = {}
  ): Promise<boolean> {
    const body = fitStatusPayload(payload);
    const attempts = Math.max(1, options.attempts ?? 1);

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await ky.post(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/status`, {
          headers,
          json: body,
          retry: 0,
        });
        try {
          const parsed = await res.json<{ leaseOk?: boolean }>();
          return parsed?.leaseOk !== false;
        } catch {
          return true;
        }
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 409) {
          this.log.debug(
            'Coordinator refused the status patch for task %s (already terminal)',
            taskId
          );
          return false;
        }

        // A transport failure or a 5xx may still settle; a 4xx never will.
        const transient = status === undefined || status >= 500;
        if (transient && attempt < attempts && !this.abortController?.signal.aborted) {
          this.log.warn(
            'Status report for task %s failed (attempt %d/%d), retrying: %s',
            taskId,
            attempt,
            attempts,
            err?.message ?? err
          );
          continue;
        }

        this.log.warn('Failed to report status for task %s: %s', taskId, err?.message ?? err);
        // A lost report is the coordinator's lease problem, never a reason to abort real work.
        return true;
      }
    }
    return true;
  }

  public stop(): void {
    this.isRunning = false;
    if (this.agyUpdateTimer) {
      clearTimeout(this.agyUpdateTimer);
      this.agyUpdateTimer = null;
    }
    this.abortController?.abort();
    this.taskAbortController?.abort();
  }
}
