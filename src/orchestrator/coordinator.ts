import { EventEmitter } from 'node:events';
import type { ConfigStore } from '../config/store.js';
import type { SentryStateManager } from '../sentry/state.js';
import type { QuotaSnapshot } from '../sentry/models.js';
import type { Notifier } from '../notify/types.js';
import { logger, type Logger } from '../logs/logger.js';
import {
  evaluateModelDispatchEligibility,
  resolveConcreteModelId,
  type ModelEligibilityResult,
  type ReasoningEffort,
  type TaskPriority,
  type WorkerMode,
} from './models.js';
import {
  TaskQueue,
  type CreateRegistrationTokenInput,
  type ExchangeRegistrationTokenInput,
  type RunnerRegistrationTokenResult,
  type RunnerSystemInfo,
  type SwarmTask,
  type SwarmWorkerRecord,
  type TaskStatusPatch,
} from './queue.js';
import { buildContinuationBranchName } from './worker.js';

export interface DispatchTaskRequest {
  repositoryId?: string;
  repositoryName: string;
  repositoryPath?: string;
  cloneUrl?: string;
  prompt: string;
  requestedBy?: string;
  requestedByUserId?: string;
  priority?: TaskPriority;
  workerMode?: WorkerMode;
  requiredLabels?: string[];
  model?: string;
  effort?: ReasoningEffort;
  allowOverage?: boolean;
  pushBranch?: boolean;
  verifyCommand?: string;
}

export interface DispatchTaskResponse {
  success: boolean;
  status?: SwarmTask['status'];
  taskId?: string;
  dispatchId?: string;
  repo: string;
  branchName?: string;
  model?: string;
  poolFamily?: string;
  priority?: TaskPriority;
  workerMode?: WorkerMode;
  requiredLabels?: string[];
  output?: string;
  error?: string;
  code?:
    | 'ORCHESTRATOR_DISABLED'
    | 'OVERAGE_PROTECTION_TRIGGERED'
    | 'QUOTA_BURN_QUEUED'
    | 'EXECUTION_FAILED';
  minDispatchHeadroomPercent?: number;
  currentHeadroomPercent?: number;
  durationMs?: number;
}

export interface WorkerPollRequest {
  workerId: string;
  workerName?: string;
  workerMode?: WorkerMode;
  labels?: string[];
  repositories?: string[];
  systemInfo?: RunnerSystemInfo;
  timeoutMs?: number;
}

export interface OrchestratorCoordinatorOptions {
  configStore: ConfigStore;
  sentryState?: SentryStateManager;
  notifier?: Notifier;
  logger?: Logger;
}

export class OrchestratorCoordinator {
  public readonly queue: TaskQueue;
  private readonly configStore: ConfigStore;
  private readonly sentryState?: SentryStateManager;
  private notifier?: Notifier;
  private readonly log: Logger;
  private readonly bus = new EventEmitter();
  private latestSnapshots: QuotaSnapshot[] = [];

  constructor(options: OrchestratorCoordinatorOptions) {
    this.configStore = options.configStore;
    this.queue = new TaskQueue(options.configStore.getDatabase());
    this.sentryState = options.sentryState;
    this.notifier = options.notifier;
    this.log = options.logger ?? logger.child('orchestrator');
    this.bus.setMaxListeners(100);
  }

  public setNotifier(notifier: Notifier): void {
    this.notifier = notifier;
  }

  public getActivePools(): QuotaSnapshot[] {
    if (this.latestSnapshots.length > 0) {
      return this.latestSnapshots;
    }
    const statePools = this.sentryState?.getState()?.pools;
    if (!statePools) return [];

    return Object.entries(statePools).map(([poolId, p]) => ({
      poolId,
      family: (poolId === 'claude' || poolId === 'gemini-argon' || poolId === 'gemini-flash'
        ? poolId
        : 'claude') as any,
      displayName: poolId,
      remainingFraction: p.remainingFraction ?? 0,
      resetTime: p.resetTime,
      hoursUntilReset: 0,
      models: [],
    }));
  }

  public onQuotaUpdated(snapshots: QuotaSnapshot[]): void {
    this.latestSnapshots = snapshots;
    const reaped = this.queue.reapStaleClaims();
    if (reaped > 0) {
      this.log.info('Reaped %d stale worker task claim(s) back to queue', reaped);
    }
    this.bus.emit('task:available');
  }

  public evaluateEligibility(params: {
    model?: string;
    priority?: TaskPriority;
    allowOverage?: boolean;
  }): ModelEligibilityResult {
    const resolved = this.configStore.resolveConfig();
    return evaluateModelDispatchEligibility({
      requestedModel: params.model,
      defaultModel: resolved.defaultDispatchModel,
      priority: params.priority ?? 'P0',
      pools: this.getActivePools(),
      minDispatchHeadroomPercent: resolved.minDispatchHeadroomPercent,
      allowOverage: params.allowOverage,
      quotaBurnMaxHours: resolved.quotaBurnMaxHours,
      quotaBurnMinHeadroomPercent: resolved.quotaBurnMinHeadroomPercent,
    });
  }

  /**
   * Main entrypoint for Web UI, REST API, and Discord task dispatches.
   * Pure Runner Architecture: Enqueues tasks into the persistent SQLite swarm queue
   * and wakes registered outbound runners (`agylity-worker` containers or host CLI runners).
   */
  public async dispatch(req: DispatchTaskRequest): Promise<DispatchTaskResponse> {
    const resolved = this.configStore.resolveConfig();
    const repositoryName = req.repositoryName.trim();
    const priority: TaskPriority = req.priority ?? 'P0';
    const allowOverage = Boolean(req.allowOverage);

    // 0. Enforce single-user owner binding when requestedByUserId is supplied
    if (
      resolved.discordOwnerUserId &&
      resolved.discordOwnerUserId.trim() !== '' &&
      req.requestedByUserId !== undefined &&
      req.requestedByUserId.trim() !== resolved.discordOwnerUserId.trim()
    ) {
      return {
        success: false,
        repo: repositoryName,
        error:
          'Single-User Binding: This Agylity instance is restricted to the configured Discord owner.',
        code: 'EXECUTION_FAILED',
      };
    }

    // 1. Evaluate model & safety floor before orchestrator gate so overage blocks are caught consistently
    const eligibility = this.evaluateEligibility({
      model: req.model,
      priority,
      allowOverage,
    });

    if (!eligibility.allowed && eligibility.code === 'OVERAGE_PROTECTION_TRIGGERED') {
      this.log.warn(
        'Task dispatch blocked for "%s" (model=%s, pool=%s): remaining headroom (%d%%) is below safety floor (%d%%)',
        repositoryName,
        eligibility.resolvedModel,
        eligibility.family,
        eligibility.effectiveHeadroomPercent,
        resolved.minDispatchHeadroomPercent
      );
      return {
        success: false,
        repo: repositoryName,
        model: eligibility.resolvedModel,
        poolFamily: eligibility.family,
        error: eligibility.reason,
        code: 'OVERAGE_PROTECTION_TRIGGERED',
        minDispatchHeadroomPercent: resolved.minDispatchHeadroomPercent,
        currentHeadroomPercent: eligibility.effectiveHeadroomPercent,
      };
    }

    // 2. Check if task orchestrator is enabled
    if (!resolved.orchestratorEnabled) {
      return {
        success: false,
        error:
          'Task orchestrator is disabled while running in alerting-only mode. Enable orchestrator in settings or set ORCHESTRATOR_ENABLED=true.',
        code: 'ORCHESTRATOR_DISABLED',
        dispatchId: `disp-${Date.now()}`,
        repo: repositoryName,
      };
    }

    // 3. Resolve repository configuration
    const matchedRepo = resolved.repositories.find(
      (r) =>
        r.id.toLowerCase() === (req.repositoryId || repositoryName).toLowerCase() ||
        r.name.toLowerCase() === repositoryName.toLowerCase()
    );
    const repoId =
      matchedRepo?.id ??
      req.repositoryId ??
      (repositoryName.toLowerCase().replace(/[^a-z0-9-_]/g, '-') || 'default');
    const repoDisplayName = matchedRepo?.name ?? repositoryName;
    const repoPath =
      req.repositoryPath && req.repositoryPath.trim() !== ''
        ? req.repositoryPath.trim()
        : matchedRepo?.path || `/repos/${repoId}`;
    const cloneUrl = req.cloneUrl || matchedRepo?.cloneUrl;
    const defaultBranch = matchedRepo?.defaultBranch || 'main';

    const concreteModel = resolveConcreteModelId(req.model, resolved.defaultDispatchModel);
    const effort: ReasoningEffort = req.effort ?? resolved.defaultDispatchEffort ?? 'high';
    const workerMode: WorkerMode = req.workerMode ?? resolved.defaultWorkerMode ?? 'headless';
    const requiredLabels = req.requiredLabels ?? [];

    // 4. Enqueue task in SQLite swarm_tasks queue
    const task = this.queue.enqueue({
      repositoryId: repoId,
      repositoryName: repoDisplayName,
      repositoryPath: repoPath,
      cloneUrl,
      defaultBranch,
      prompt: req.prompt,
      requestedBy: req.requestedBy || 'web-ui',
      priority,
      workerMode,
      requiredLabels,
      model: concreteModel,
      effort,
      allowOverage,
      pushBranch: req.pushBranch ?? true,
      verifyCommand: req.verifyCommand,
    });

    const plannedBranch = buildContinuationBranchName(task.id, task.prompt);

    this.log.info(
      'Task %s enqueued for %s (priority=%s, model=%s, mode=%s)',
      task.id,
      repoDisplayName,
      priority,
      concreteModel,
      workerMode
    );

    await this.notifier?.notifyDispatchStatus({
      taskId: task.id,
      status: 'polling',
      repositoryName: repoDisplayName,
      repositoryPath: repoPath,
      prompt: task.prompt,
      branchName: plannedBranch,
      requestedBy: task.requestedBy,
      message:
        eligibility.code === 'QUOTA_BURN_CONDITIONS_NOT_MET'
          ? `Task ${task.id} queued for P2 Quota-Burn (${concreteModel})`
          : `Task ${task.id} queued (${priority}, model: ${concreteModel})`,
    });

    // Wake any long-polling runners
    this.bus.emit('task:available');

    // 5. If P2 conditions are not yet met, return QUOTA_BURN_QUEUED status code
    if (!eligibility.allowed && eligibility.code === 'QUOTA_BURN_CONDITIONS_NOT_MET') {
      return {
        success: true,
        status: 'queued',
        taskId: task.id,
        dispatchId: task.id,
        repo: repoDisplayName,
        branchName: plannedBranch,
        model: concreteModel,
        poolFamily: task.poolFamily,
        priority,
        workerMode,
        requiredLabels: task.requiredLabels,
        code: 'QUOTA_BURN_QUEUED',
      };
    }

    return {
      success: true,
      status: 'queued',
      taskId: task.id,
      dispatchId: task.id,
      repo: repoDisplayName,
      branchName: plannedBranch,
      model: concreteModel,
      poolFamily: task.poolFamily,
      priority,
      workerMode,
      requiredLabels: task.requiredLabels,
    };
  }

  /**
   * Generates a short-lived one-time runner registration token (`agyr_reg_...`).
   */
  public createRegistrationToken(
    input: CreateRegistrationTokenInput = {}
  ): RunnerRegistrationTokenResult {
    const res = this.queue.createRegistrationToken(input);
    this.log.info(
      'Created one-time runner registration token %s (mode=%s, expires=%s)',
      res.id,
      res.workerMode,
      res.expiresAt
    );
    return res;
  }

  /**
   * Exchanges a one-time registration token for a persistent runner identity and `agyr_run_...` token.
   */
  public registerRunner(input: ExchangeRegistrationTokenInput): {
    worker: SwarmWorkerRecord;
    runnerToken: string;
  } | null {
    const result = this.queue.exchangeRegistrationToken(input);
    if (result) {
      this.log.info(
        'Registered swarm runner "%s" (%s, mode=%s, labels=%s)',
        result.worker.name,
        result.worker.workerId,
        result.worker.workerMode,
        result.worker.labels.join(',') || 'none'
      );
    }
    return result;
  }

  /**
   * Authenticates an incoming runner request via its persistent `agyr_run_...` token
   * or fallback `workerSharedSecret`.
   */
  public authenticateRunner(providedToken?: string): {
    authenticated: boolean;
    worker?: SwarmWorkerRecord;
    isSharedSecret?: boolean;
  } {
    const resolved = this.configStore.resolveConfig();
    return this.queue.authenticateRunner(providedToken, resolved.workerSharedSecret);
  }

  /**
   * Long-poll claim handler for outbound runners (`POST /api/tasks/poll`).
   */
  public async pollForTask(
    pollReq: WorkerPollRequest,
    abortSignal?: AbortSignal
  ): Promise<SwarmTask | null> {
    const tryClaim = (): SwarmTask | null => {
      return this.queue.claimNext({
        workerId: pollReq.workerId,
        workerName: pollReq.workerName,
        workerMode: pollReq.workerMode ?? 'headless',
        labels: pollReq.labels,
        repositories: pollReq.repositories,
        systemInfo: pollReq.systemInfo,
        eligibilityCheck: (candidate) => {
          const elig = this.evaluateEligibility({
            model: candidate.model,
            priority: candidate.priority,
            allowOverage: candidate.allowOverage,
          });
          return {
            allowed: elig.allowed,
            resolvedModel: elig.resolvedModel,
          };
        },
      });
    };

    const immediate = tryClaim();
    if (immediate) {
      return immediate;
    }

    const timeoutMs = Math.min(Math.max(0, pollReq.timeoutMs ?? 0), 30000);
    if (timeoutMs <= 0 || abortSignal?.aborted) {
      return null;
    }

    return new Promise<SwarmTask | null>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        this.bus.off('task:available', onAvailable);
        abortSignal?.removeEventListener('abort', onAbort);
      };

      const onAvailable = () => {
        const claimed = tryClaim();
        if (claimed) {
          cleanup();
          resolve(claimed);
        }
      };

      const onAbort = () => {
        cleanup();
        resolve(null);
      };

      this.bus.on('task:available', onAvailable);
      abortSignal?.addEventListener('abort', onAbort, { once: true });

      timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
    });
  }

  /**
   * Updates task status from a remote runner and relays notifications.
   */
  public async reportTaskStatus(
    taskId: string,
    patch: TaskStatusPatch & { message?: string }
  ): Promise<SwarmTask | undefined> {
    const updated = this.queue.updateTaskStatus(taskId, patch);
    if (!updated) return undefined;

    const statusStep =
      patch.status === 'completed'
        ? 'completed'
        : patch.status === 'failed'
          ? 'failed'
          : patch.status === 'aborted'
            ? 'aborted'
            : 'executing';

    const defaultMsg =
      patch.status === 'completed'
        ? `Completed task ${updated.id} on branch ${updated.branchName || 'continuation'} (${updated.model})`
        : patch.status === 'failed'
          ? `Task ${updated.id} failed: ${updated.error || 'Unknown error'}`
          : `Executing task ${updated.id} on ${updated.repositoryName} (${updated.model})`;

    await this.notifier?.notifyDispatchStatus({
      taskId: updated.id,
      status: statusStep,
      repositoryName: updated.repositoryName,
      repositoryPath: updated.repositoryPath,
      prompt: updated.prompt,
      branchName: updated.branchName,
      output: updated.output,
      error: updated.error,
      durationMs: updated.durationMs,
      requestedBy: updated.requestedBy,
      message: patch.message ?? defaultMsg,
    });

    this.bus.emit(`task:updated:${taskId}`, updated);
    return updated;
  }

  public listWorkers(): SwarmWorkerRecord[] {
    return this.queue.listWorkers();
  }

  public setWorkerEnabled(workerId: string, enabled: boolean): SwarmWorkerRecord | undefined {
    const updated = this.queue.setWorkerEnabled(workerId, enabled);
    if (updated) {
      this.log.info('Swarm runner "%s" (%s) enabled=%s', updated.name, workerId, String(enabled));
      if (enabled) {
        this.bus.emit('task:available');
      }
    }
    return updated;
  }

  public revokeWorker(workerId: string): boolean {
    const revoked = this.queue.revokeWorker(workerId);
    if (revoked) {
      this.log.info('Revoked swarm runner %s and returned any active claims to queue', workerId);
      this.bus.emit('task:available');
    }
    return revoked;
  }
}
