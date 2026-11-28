import { EventEmitter } from 'node:events';
import type { ConfigStore } from '../config/store.js';
import { settleBacklogOrigin } from './backlogOrigin.js';
import { createBurnKickTracker } from './burnKick.js';
import {
  computeRoutineEligibility,
  orderRoutineCandidates,
  routineLimits,
  routineMayTriggerAgain,
  type RoutinePolicyDeps,
} from './routinePolicy.js';
import { type PrPolicy } from '../shared/contracts.js';
import { type ResolvedConfig } from '../config/types.js';
import {
  DEFAULT_BACKLOG_CONCURRENCY,
  DEFAULT_BACKLOG_MIN_HEADROOM_PERCENT,
} from '../shared/defaults.js';
import type { EarlyResetPool, SentryStateManager } from '../sentry/state.js';
import { snapshotsFromSentryState, type PoolGroup, type QuotaSnapshot } from '../sentry/models.js';
import type { DispatchStatusUpdate, Notifier } from '../notify/types.js';
import { logger, type Logger } from '../logs/logger.js';
import {
  poolDispatchEnabled,
  poolGroupOfPoolId,
  CANONICAL_AGY_MODELS,
  calculateEffectiveHeadroomPercent,
  evaluateModelDispatchEligibility,
  evaluateModelPreferenceChain,
  findPoolForGroup,
  normalizeCascade,
  poolHoursUntilReset,
  resolveAvailableModelId,
  resolveConcreteModelId,
  resolveDefaultDispatchModel,
  resolvePoolGroupForModel,
  resolvePoolGroupForModelOrNull,
  isGithubRemoteTask,
  isTerminalTaskStatus,
  resolveReasoningEffortForModel,
  modelSupportsEffort,
  type AgyModelCatalogEntry,
  type CascadeHop,
  type ModelEligibilityResult,
  type ReasoningEffort,
  type RoutineEligibilityStatus,
  type ScheduleMode,
  type TaskStatus,
  type TaskTier,
  type RunnerLeaseBlockReason,
} from './models.js';
import {
  TaskQueue,
  type BacklogTaskRecord,
  type CreateRegistrationTokenInput,
  type EnqueueTaskInput,
  type ExchangeRegistrationTokenInput,
  type RoutineTaskRecord,
  type RunnerRegistrationTokenResult,
  type RunnerSystemInfo,
  type SwarmRunnerRecord,
  type SwarmTask,
  type TaskStatusPatch,
} from './queue.js';
import { buildContinuationBranchName } from '../runner/policy.js';
import { resolveTaskTitle } from '../shared/titles.js';
import { OWNER_REPO_SLUG_RE, parseGithubSlugFromUrl } from '../shared/github.js';
import { GITHUB_WEB_HOSTS } from '../shared/github.js';
import type { ModelCatalogProvider } from './catalog.js';
import { removeIssueLabel } from './githubIssues.js';

// A queued backlog task that no runner claims in this window returns to its origin, so a pool dip or
// an offline runner cannot wedge the tier behind a run nothing will ever pick up.
const BACKLOG_QUEUE_TTL_MS = 2 * 60 * 60 * 1000;

// A live row stacks another run behind it; the claim path runs one at a time per origin.
const BACKLOG_DISPATCHABLE_STATUSES: ReadonlySet<string> = new Set<string>([
  'pending',
  'failed',
  'dispatched',
]);

interface DispatchTaskRequest {
  repositoryId: string;
  repositoryName?: string;
  repositoryPath?: string;
  cloneUrl?: string;
  prompt: string;
  title?: string;
  tier?: TaskTier;
  originId?: string;
  originNumber?: number;
  originTitle?: string;
  requestedBy?: string;
  requestedByUserId?: string;
  prPolicy?: PrPolicy;
  scheduleMode?: ScheduleMode;
  requiredLabels?: string[];
  cascade?: CascadeHop[];
  allowOverage?: boolean;
  pushBranch?: boolean;
  autoCreatePr?: boolean;
  expiresAt?: string;
  standingTaskId?: string;
  verifyCommand?: string;
}

interface DispatchTaskResponse {
  success: boolean;
  status?: SwarmTask['status'];
  taskId?: string;
  dispatchId?: string;
  repo: string;
  branchName?: string;
  model?: string;
  poolGroup?: string;
  scheduleMode?: ScheduleMode;
  requiredLabels?: string[];
  output?: string;
  error?: string;
  code?:
    | 'COORDINATOR_DISABLED'
    | 'OVERAGE_PROTECTION_TRIGGERED'
    | 'QUOTA_BURN_QUEUED'
    | 'TELEMETRY_UNAVAILABLE'
    | 'ORIGIN_NOT_DISPATCHABLE'
    | 'EXECUTION_FAILED';
  minDispatchHeadroomPercent?: number;
  currentHeadroomPercent?: number;
  durationMs?: number;
}

interface RunnerPollRequest {
  runnerId: string;
  runnerName?: string;
  labels?: string[];
  repositories?: string[];
  systemInfo?: RunnerSystemInfo;
  timeoutMs?: number;
  /** False when the coordinator holds no GitHub PAT: GitHub remotes are then not claimable. */
  leaseGithubTasks?: boolean;
  /** Called for every task withheld by that guard, so the caller can say why nothing was leased. */
  onLeaseBlocked?: (task: SwarmTask, reason: RunnerLeaseBlockReason) => void;
}

interface CoordinatorOptions {
  configStore: ConfigStore;
  sentryState?: SentryStateManager;
  notifier?: Notifier;
  logger?: Logger;
  modelCatalog?: ModelCatalogProvider;
  issueLabelRemover?: typeof removeIssueLabel;
}

export class Coordinator {
  public readonly queue: TaskQueue;
  private readonly configStore: ConfigStore;
  private readonly sentryState?: SentryStateManager;
  private modelCatalog?: ModelCatalogProvider;
  private notifier?: Notifier;
  private readonly log: Logger;
  private readonly bus = new EventEmitter();
  private readonly burnKick: ReturnType<typeof createBurnKickTracker>;
  private latestSnapshots: QuotaSnapshot[] = [];
  private lastSnapshotAt = 0;
  private lastManualDispatchAt = 0;
  private readonly issueLabelRemover: typeof removeIssueLabel;

  constructor(options: CoordinatorOptions) {
    this.issueLabelRemover = options.issueLabelRemover ?? removeIssueLabel;
    this.configStore = options.configStore;
    this.queue = new TaskQueue(options.configStore.getDatabase());
    this.sentryState = options.sentryState;
    this.modelCatalog = options.modelCatalog;
    this.notifier = options.notifier;
    this.log = options.logger ?? logger.child('coordinator');
    this.bus.setMaxListeners(100);
    this.burnKick = createBurnKickTracker({
      runtime: {
        get: (key) => this.queue.getRuntimeValue(key),
        set: (key, value) => this.queue.setRuntimeValue(key, value),
      },
      log: this.log,
      notifier: () => this.notifier,
      resolveConfig: () => this.configStore.resolveConfig(),
      getActivePools: () => this.getActivePools(),
    });
    this.lastManualDispatchAt =
      Number(this.queue.getRuntimeValue('lastManualDispatchAt') ?? 0) || 0;
  }

  public setNotifier(notifier: Notifier): void {
    this.notifier = notifier;
  }

  public setModelCatalog(catalog: ModelCatalogProvider): void {
    this.modelCatalog = catalog;
  }

  private activeModelCatalog(): readonly AgyModelCatalogEntry[] {
    const models = this.modelCatalog?.getModels() ?? [];
    return models.length > 0 ? models : CANONICAL_AGY_MODELS;
  }

  // The configured default can name a model this account tier withholds; resolve it to the newest
  // model the same pool group still serves, so a downgraded tier never dispatches an absent id.
  private resolveDispatchModel(model: string | undefined, configuredDefault: string): string {
    const catalog = this.activeModelCatalog();
    const fallback = resolveDefaultDispatchModel(configuredDefault, catalog);
    return resolveAvailableModelId(resolveConcreteModelId(model, fallback), catalog);
  }

  private async notifyBestEffort(update: DispatchStatusUpdate): Promise<void> {
    try {
      await this.notifier?.notifyDispatchStatus(update);
    } catch (notifyErr) {
      this.log.warn('Dispatch notification failed for %s: %s', update.taskId, notifyErr);
    }
  }

  public getLastManualDispatchAt(): number {
    return this.lastManualDispatchAt;
  }

  public setLastManualDispatchAt(timestampMs: number): void {
    this.lastManualDispatchAt = timestampMs;
    this.queue.setRuntimeValue('lastManualDispatchAt', String(timestampMs));
  }

  public getActivePools(): QuotaSnapshot[] {
    // A stale snapshot must not authorise dispatch: return nothing so eligibility fails closed.
    const intervalMs = (this.configStore.resolveConfig().quotaCheckIntervalSeconds ?? 60) * 1000;
    const maxAgeMs = Math.max(intervalMs * 2, 60_000);

    if (this.latestSnapshots.length > 0 && Date.now() - this.lastSnapshotAt <= maxAgeMs) {
      return this.latestSnapshots;
    }
    const state = this.sentryState?.getState();
    if (!state) return [];
    const probedAt = Date.parse(state.lastProbeAt ?? '');
    if (!Number.isFinite(probedAt) || Date.now() - probedAt > maxAgeMs) return [];
    return snapshotsFromSentryState(state);
  }

  public reapStaleClaims(): SwarmTask[] {
    const expiredQueued = this.queue.reapExpiredQueuedTasks();
    if (expiredQueued.length > 0) {
      this.log.info('Reaped %d unclaimed queued task(s) past their deadline', expiredQueued.length);
    }
    const expiredTasks = this.queue.reapStaleClaims();
    this.reconcileBacklogOrigins();
    if (expiredTasks.length > 0) {
      this.log.info('Reaped %d expired runner task lease(s)', expiredTasks.length);
      for (const t of expiredTasks) {
        void this.notifyBestEffort({
          taskId: t.id,
          repositoryName: t.repositoryName,
          status: 'failed',
          durationMs: t.durationMs,
          createdAt: t.createdAt,
          error: t.error || 'Runner heartbeat lease expired',
        });
      }
      this.bus.emit('task:available');
    }
    return expiredTasks;
  }

  public onQuotaUpdated(snapshots: QuotaSnapshot[]): void {
    this.latestSnapshots = snapshots;
    this.lastSnapshotAt = Date.now();
    this.reapStaleClaims();
    void this.triggerEligibleAutonomousTasks(snapshots).catch((autonomyErr) =>
      this.log.error('Autonomous evaluator failed: %s', autonomyErr)
    );
    this.bus.emit('task:available');
  }

  public onEarlyQuotaReset(earlyResets: EarlyResetPool[]): void {
    if (earlyResets.length === 0) return;

    const cycles = this.burnKick.readCycles();
    let changed = false;
    for (const pool of earlyResets) {
      // Burn-kick cycles are keyed by pool group, so a `<group>:<slug>` id must clear its group.
      for (const key of new Set([poolGroupOfPoolId(pool.poolId), pool.poolId])) {
        if (Object.hasOwn(cycles, key)) {
          delete cycles[key];
          changed = true;
        }
      }
    }
    if (changed) this.burnKick.writeCycles(cycles);

    const routines = this.queue.listRoutineTasks();
    if (routines.length === 0) return;

    const { defaultDispatchModel } = this.configStore.resolveConfig();
    for (const rt of routines) {
      const poolGroups = new Set<string>(
        rt.cascade.map((hop) =>
          resolvePoolGroupForModel(this.resolveDispatchModel(hop.model, defaultDispatchModel))
        )
      );

      // A cycle stamp outlives its reset time, so either one identifies the replenished cycle.
      const matchedGroups = new Set<string>();
      let resetTimeMatched = false;
      for (const pool of earlyResets) {
        const group = poolGroupOfPoolId(pool.poolId);
        if (!poolGroups.has(group)) continue;
        const timeMatched =
          pool.previousResetTime === rt.lastTriggeredResetTime ||
          pool.resetTime === rt.lastTriggeredResetTime;
        const cycleMatched = Object.keys(rt.lastTriggeredCycles ?? {}).some(
          (cycleKey) => poolGroupOfPoolId(cycleKey) === group
        );
        if (!timeMatched && !cycleMatched) continue;
        matchedGroups.add(group);
        if (timeMatched) resetTimeMatched = true;
      }
      if (matchedGroups.size === 0) continue;

      // Only the replenished groups forget their cycle; a sibling pool's stamp must survive.
      const survivingCycles = Object.fromEntries(
        Object.entries(rt.lastTriggeredCycles ?? {}).filter(
          ([cycleKey]) => !matchedGroups.has(poolGroupOfPoolId(cycleKey))
        )
      );
      this.queue.updateRoutineTask(rt.id, {
        lastTriggeredResetTime:
          resetTimeMatched || Object.keys(survivingCycles).length === 0
            ? null
            : (rt.lastTriggeredResetTime ?? null),
        lastTriggeredCycles: survivingCycles,
      });
    }
  }

  // Later hops stay in the cascade so the runner can fail over at each hop's own effort.
  private resolveFallbackCascade(params: {
    cascade: CascadeHop[];
    selectedModel: string;
    selectedEffort: ReasoningEffort;
    pools: QuotaSnapshot[];
    minHeadroomPercent: number;
    isPoolDispatchEnabled: (poolGroup: PoolGroup) => boolean;
    defaultModel?: string;
    catalog?: readonly AgyModelCatalogEntry[];
  }): CascadeHop[] {
    const hops: CascadeHop[] = [{ model: params.selectedModel, effort: params.selectedEffort }];
    for (const hop of params.cascade) {
      if (hop.model === params.selectedModel) continue;
      const evaluation = evaluateModelPreferenceChain({
        cascade: [hop],
        defaultModel: params.defaultModel,
        pools: params.pools,
        minHeadroomPercent: params.minHeadroomPercent,
        isPoolDispatchEnabled: params.isPoolDispatchEnabled,
        catalog: params.catalog,
      });
      if (!evaluation.allowed || !evaluation.selectedModel) continue;
      if (hops.some((chosen) => chosen.model === evaluation.selectedModel)) continue;
      hops.push({
        model: evaluation.selectedModel,
        effort: evaluation.selectedEffort ?? hop.effort,
      });
    }
    return hops;
  }

  private preResetExpiry(pool: QuotaSnapshot | undefined): string | undefined {
    if (!pool?.resetTime) return undefined;
    return Number.isNaN(Date.parse(pool.resetTime)) ? undefined : pool.resetTime;
  }

  /** An unconfigured id becomes a path segment under `/repos`, so it may never carry a separator or a dot-only form. */
  private isAddressableRepositoryId(repositoryId: string): boolean {
    const id = repositoryId.trim();
    return !/[\\/]/.test(id) && !id.startsWith('.') && id !== '' && !id.includes('..');
  }

  /** A configured repository is addressed by either its id or its display name, case-insensitively. */
  private findConfiguredRepository(resolved: ResolvedConfig, repositoryId: string) {
    const key = repositoryId.toLowerCase();
    return resolved.repositories.find(
      (repo) => repo.id.toLowerCase() === key || repo.name.toLowerCase() === key
    );
  }

  /** The spawn/enqueue identity of a repository: its configuration when present, path defaults otherwise. */
  private repositoryTarget(resolved: ResolvedConfig, repositoryId: string) {
    const repo = this.findConfiguredRepository(resolved, repositoryId);
    if (!repo) {
      const sanitized = repositoryId.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
      if (!this.isAddressableRepositoryId(repositoryId) || !sanitized) {
        throw new Error(
          `repositoryId ${JSON.stringify(repositoryId)} must be a configured repository or a plain slug`
        );
      }
      return {
        repositoryName: repositoryId,
        repositoryPath: `/repos/${sanitized}`,
        cloneUrl: undefined,
        defaultBranch: 'main',
      };
    }
    return {
      repositoryName: repo.name || repositoryId,
      repositoryPath: repo.path,
      cloneUrl: repo.cloneUrl,
      defaultBranch: repo.defaultBranch || 'main',
    };
  }

  private routineDeps(): RoutinePolicyDeps {
    return {
      config: { resolveConfig: () => this.configStore.resolveConfig() },
      queue: {
        hasActiveTaskForOrigin: (originId) => this.queue.hasActiveTaskForOrigin(originId),
        getLatestTaskForOrigin: (originId, poolGroup) =>
          this.queue.getLatestTaskForOrigin(originId, poolGroup),
        getTask: (id) => this.queue.getTask(id),
      },
      getActivePools: () => this.getActivePools(),
      resolveDispatchModel: (model, configuredDefault) =>
        this.resolveDispatchModel(model, configuredDefault),
    };
  }

  /** The routine's own window wins; the global burn window is only a fallback. */
  private routineLimits(rt: RoutineTaskRecord, resolved: ResolvedConfig) {
    return routineLimits(rt, resolved);
  }

  private routineMayTriggerAgain(
    rt: RoutineTaskRecord,
    poolKey: string,
    resetTime: string
  ): boolean {
    return routineMayTriggerAgain(rt, poolKey, resetTime, this.routineDeps());
  }

  private orderRoutineCandidates(routines: RoutineTaskRecord[]): RoutineTaskRecord[] {
    return orderRoutineCandidates(routines, this.routineDeps());
  }

  public computeRoutineEligibility(
    rt: RoutineTaskRecord,
    snapshots?: QuotaSnapshot[]
  ): RoutineEligibilityStatus {
    return computeRoutineEligibility(rt, snapshots, this.routineDeps());
  }

  public async triggerEligibleAutonomousTasks(snapshots: QuotaSnapshot[]): Promise<SwarmTask[]> {
    if (snapshots.length > 0) {
      this.latestSnapshots = snapshots;
      this.lastSnapshotAt = Date.now();
    }

    const resolved = this.configStore.resolveConfig();
    if (!resolved.coordinatorEnabled) {
      return [];
    }

    const now = Date.now();
    const isQuenched = now - this.lastManualDispatchAt < 2 * 3600 * 1000;
    if (isQuenched) {
      this.log.debug('Autonomous task scheduling quenched (manual activity within past 2h)');
      return [];
    }

    const spawned: SwarmTask[] = [];

    try {
      // The tier gates at spawn and dispenses with the pre-reset window, so claim time only has to
      // enforce the live safety floor. Concurrency is governed by `backlogConcurrency` (single,
      // per_repo, or per_runner) and bounded by online enabled runners (minimum 1 so a task can
      // still be queued before a runner registers).
      const headroomFloor = Math.max(
        resolved.backlogMinHeadroomPercent ?? DEFAULT_BACKLOG_MIN_HEADROOM_PERCENT,
        resolved.minDispatchHeadroomPercent ?? 0
      );
      const dispatchEnabled = (poolGroup: PoolGroup): boolean =>
        poolDispatchEnabled(resolved, poolGroup);
      const concurrencyMode = resolved.backlogConcurrency ?? DEFAULT_BACKLOG_CONCURRENCY;
      const onlineRunners = this.queue.runners
        .listRunners()
        .filter((runner) => runner.enabled && runner.status !== 'offline').length;
      const maxActiveBacklog = concurrencyMode === 'single' ? 1 : Math.max(1, onlineRunners);

      const activeBacklogTasks = this.queue.listActiveBacklogTasks();
      let activeCount = activeBacklogTasks.length;
      const activeRepos = new Set(activeBacklogTasks.map((t) => t.repositoryId.toLowerCase()));

      if (activeCount < maxActiveBacklog) {
        const candidates = this.queue.listEligibleBacklogTasks();
        for (const nextBacklog of candidates) {
          if (activeCount >= maxActiveBacklog) break;

          const repoKey = nextBacklog.repositoryId.toLowerCase();
          if (concurrencyMode === 'per_repo' && activeRepos.has(repoKey)) {
            continue;
          }

          const modelChoice = evaluateModelPreferenceChain({
            cascade: nextBacklog.cascade,
            defaultModel: resolved.defaultDispatchModel,
            pools: snapshots,
            minHeadroomPercent: headroomFloor,
            isPoolDispatchEnabled: dispatchEnabled,
            catalog: this.activeModelCatalog(),
          });

          if (
            !modelChoice.allowed ||
            !modelChoice.selectedModel ||
            modelChoice.selectedEffort === undefined
          ) {
            continue;
          }

          let target;
          try {
            target = this.repositoryTarget(resolved, nextBacklog.repositoryId);
          } catch (targetErr) {
            this.log.warn(
              'Skipping backlog task #%d: %s',
              nextBacklog.taskNumber,
              targetErr instanceof Error ? targetErr.message : String(targetErr)
            );
            continue;
          }

          // Ready to run: the spawn already cleared headroom, so a queued backlog task must be
          // claimable by an idle runner and must not wait for a reset window it was never gated on.
          const created = this.queue.spawnBacklogTask(
            {
              repositoryId: nextBacklog.repositoryId,
              ...target,
              prompt: nextBacklog.prompt,
              title: nextBacklog.title,
              tier: 'backlog',
              originId: nextBacklog.id,
              originNumber: nextBacklog.taskNumber,
              originTitle: nextBacklog.title,
              originIssueNumber: nextBacklog.githubIssueNumber ?? undefined,
              requestedBy: `backlog:${nextBacklog.id}`,
              prPolicy: resolved.prPolicy,
              scheduleMode: 'immediate',
              expiresAt: new Date(now + BACKLOG_QUEUE_TTL_MS).toISOString(),
              cascade: this.resolveFallbackCascade({
                cascade: nextBacklog.cascade,
                selectedModel: modelChoice.selectedModel,
                selectedEffort: modelChoice.selectedEffort,
                pools: snapshots,
                minHeadroomPercent: headroomFloor,
                isPoolDispatchEnabled: dispatchEnabled,
                defaultModel: resolved.defaultDispatchModel,
                catalog: this.activeModelCatalog(),
              }),
              autoCreatePr: nextBacklog.autoCreatePr,
              verifyCommand: nextBacklog.verifyCommand,
            },
            { id: nextBacklog.id, attemptCount: nextBacklog.attemptCount + 1 }
          );

          spawned.push(created);
          activeCount += 1;
          activeRepos.add(repoKey);
          this.log.info(
            'Dispatched backlog task #%d ("%s") via model %s (pool=%s, attempt %d/%d)',
            nextBacklog.taskNumber,
            nextBacklog.title,
            modelChoice.selectedModel,
            modelChoice.poolGroup,
            nextBacklog.attemptCount + 1,
            nextBacklog.maxAttempts
          );
        }
      }
    } catch (backlogErr) {
      this.log.error('Error evaluating backlog tasks: %s', backlogErr);
    }

    if (resolved.routinesEnabled !== false) {
      try {
        const routineSpawned = await this.triggerEligibleRoutines(snapshots);
        spawned.push(...routineSpawned);
      } catch (routineErr) {
        this.log.error('Error evaluating routine tasks: %s', routineErr);
      }
    }

    return spawned;
  }

  public async triggerEligibleRoutines(snapshots: QuotaSnapshot[]): Promise<SwarmTask[]> {
    const resolved = this.configStore.resolveConfig();
    if (!resolved.coordinatorEnabled || resolved.routinesEnabled === false) {
      return [];
    }

    const routines = this.orderRoutineCandidates(
      this.queue.listRoutineTasks().filter((t) => t.enabled)
    );
    if (routines.length === 0 || snapshots.length === 0) {
      return [];
    }

    const spawned: SwarmTask[] = [];
    const dispatchedPools = new Set<string>();

    for (const rt of routines) {
      if (this.queue.hasActiveTaskForOrigin(rt.id)) {
        continue;
      }

      const { triggerHours, minHeadroom } = this.routineLimits(rt, resolved);

      const passing: Array<{ hop: CascadeHop; poolGroup: string; pool: QuotaSnapshot }> = [];
      for (const hop of rt.cascade) {
        const concreteModel = this.resolveDispatchModel(hop.model, resolved.defaultDispatchModel);
        const poolGroup = resolvePoolGroupForModelOrNull(concreteModel);
        // An unmapped model must never authorise a dispatch through the fail-open 'gemini' default.
        if (!poolGroup) continue;
        if (!poolDispatchEnabled(resolved, poolGroup)) continue;

        const pool = findPoolForGroup(snapshots, poolGroup);
        if (!pool) continue;

        const resetTime = pool.resetTime;
        const hoursUntilReset = poolHoursUntilReset(pool, Date.now());

        if (!resetTime || hoursUntilReset === null || hoursUntilReset <= 0) {
          continue;
        }

        // Looping inside a cycle is allowed, but only after the cycle's previous run succeeded.
        if (!this.routineMayTriggerAgain(rt, pool.poolId || pool.poolGroup, resetTime)) {
          continue;
        }

        if (hoursUntilReset > triggerHours) {
          continue;
        }

        const headroom = calculateEffectiveHeadroomPercent(pool);
        if (headroom === null || headroom < minHeadroom) {
          continue;
        }

        passing.push({
          hop: {
            model: concreteModel,
            effort: resolveReasoningEffortForModel(concreteModel, hop.effort),
          },
          poolGroup,
          pool,
        });
      }

      const choice = passing.find((candidate) => !dispatchedPools.has(candidate.poolGroup));
      if (!choice) {
        continue;
      }

      const selectedModel = choice.hop.model;
      const targetPool = choice.pool;
      const cascade: CascadeHop[] = [];
      for (const candidate of [choice, ...passing]) {
        if (cascade.some((hop) => hop.model === candidate.hop.model)) continue;
        cascade.push(candidate.hop);
      }
      dispatchedPools.add(choice.poolGroup);

      this.log.info(
        'Auto-triggering routine task #%d ("%s") for pool %s with model %s (reset in %sh, headroom=%d%%)',
        rt.taskNumber,
        rt.title,
        targetPool.poolGroup,
        selectedModel,
        (targetPool.hoursUntilReset ?? 0).toFixed(1),
        calculateEffectiveHeadroomPercent(targetPool) ?? 0
      );

      let target;
      try {
        target = this.repositoryTarget(resolved, rt.repositoryId);
      } catch (targetErr) {
        this.log.warn(
          'Skipping routine task #%d: %s',
          rt.taskNumber,
          targetErr instanceof Error ? targetErr.message : String(targetErr)
        );
        continue;
      }

      const task = this.queue.enqueue({
        repositoryId: rt.repositoryId,
        ...target,
        prompt: rt.prompt,
        title: rt.title,
        tier: 'routine',
        originId: rt.id,
        originNumber: rt.taskNumber,
        originTitle: rt.title,
        cascade,
        autoCreatePr: rt.autoCreatePr,
        prPolicy: rt.prPolicy ?? resolved.prPolicy,
        verifyCommand: rt.verifyCommand,
        // The routine's own window and headroom floor already gated this spawn, so the queue must not
        // re-litigate it against the global burn window; the reset deadline still bounds the wait.
        scheduleMode: 'immediate',
        expiresAt: this.preResetExpiry(targetPool),
        requestedBy: `routine:${rt.id}`,
      });

      const burnedPoolKey = targetPool.poolId || targetPool.poolGroup;
      this.queue.updateRoutineTask(rt.id, {
        lastTriggeredResetTime: targetPool.resetTime,
        lastTriggeredCycles: {
          ...(rt.lastTriggeredCycles ?? {}),
          [burnedPoolKey]: targetPool.resetTime,
        },
        lastTaskId: task.id,
      });

      void this.burnKick
        .announce({
          label: `Routine #${rt.taskNumber} "${rt.title}"`,
          pool: targetPool,
          models: [selectedModel],
          headroomPercent: calculateEffectiveHeadroomPercent(targetPool),
          triggerHours,
        })
        .catch((kickErr) =>
          this.log.warn('Burn-kick announcement failed for %s: %s', targetPool.poolGroup, kickErr)
        );

      spawned.push(task);
    }

    return spawned;
  }

  public heartbeatTask(
    taskId: string,
    runnerId: string,
    leaseDurationMs?: number,
    outputTail?: string
  ): { task: SwarmTask; applied: boolean } | undefined {
    const result = this.queue.heartbeatTask(taskId, runnerId, leaseDurationMs, outputTail);
    if (result?.applied) this.bus.emit(`task:updated:${taskId}`, result.task);
    return result;
  }

  public evaluateEligibility(params: {
    model?: string;
    scheduleMode?: ScheduleMode;
    allowOverage?: boolean;
  }): ModelEligibilityResult {
    const resolved = this.configStore.resolveConfig();
    const concreteModel = this.resolveDispatchModel(params.model, resolved.defaultDispatchModel);

    const poolGroup = resolvePoolGroupForModel(concreteModel);
    if (!poolDispatchEnabled(resolved, poolGroup) && !params.allowOverage) {
      return {
        allowed: false,
        resolvedModel: concreteModel,
        poolGroup: poolGroup,
        effectiveHeadroomPercent: 0,
        hoursUntilReset: null,
        code: 'OVERAGE_PROTECTION_TRIGGERED',
        reason: `Dispatch Disabled: Pool policy for ${poolGroup} disables task dispatching.`,
      };
    }

    return evaluateModelDispatchEligibility({
      requestedModel: params.model,
      defaultModel: resolved.defaultDispatchModel,
      scheduleMode: params.scheduleMode ?? 'immediate',
      pools: this.getActivePools(),
      minDispatchHeadroomPercent: resolved.minDispatchHeadroomPercent,
      allowOverage: params.allowOverage,
      quotaBurnMaxHours: resolved.quotaBurnMaxHours,
      quotaBurnMinHeadroomPercent: resolved.quotaBurnMinHeadroomPercent,
      catalog: this.activeModelCatalog(),
    });
  }

  public async dispatch(req: DispatchTaskRequest): Promise<DispatchTaskResponse> {
    const resolved = this.configStore.resolveConfig();
    const repositoryId = (req.repositoryId || req.repositoryName || '').trim();
    const repositoryName = req.repositoryName?.trim() || repositoryId;
    const scheduleMode: ScheduleMode = req.scheduleMode ?? 'immediate';
    const allowOverage = Boolean(req.allowOverage);
    const tier: TaskTier = req.tier ?? 'immediate';
    const originId = req.originId ?? req.standingTaskId;
    const originNumber = req.originNumber;
    const originTitle = req.originTitle;

    if (!repositoryId) {
      return {
        success: false,
        repo: 'unknown',
        error: 'repositoryId is required',
        code: 'EXECUTION_FAILED',
      };
    }

    // An id that is not configured gets `/repos/<id>` as its working directory, so a path-shaped id
    // would run the agent outside that root — and whatever it committed would be pushed.
    if (
      !this.findConfiguredRepository(resolved, repositoryId) &&
      !this.isAddressableRepositoryId(repositoryId)
    ) {
      return {
        success: false,
        repo: repositoryName,
        error: `repositoryId ${JSON.stringify(repositoryId)} must be a configured repository or a plain slug`,
        code: 'EXECUTION_FAILED',
      };
    }

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

    const backlogOrigin =
      tier === 'backlog' && originId ? this.queue.getBacklogTask(originId) : undefined;
    if (tier === 'backlog' && originId && !backlogOrigin) {
      return {
        success: false,
        repo: repositoryName,
        error: `Backlog task ${originId} not found`,
        code: 'EXECUTION_FAILED',
      };
    }
    if (backlogOrigin && !BACKLOG_DISPATCHABLE_STATUSES.has(backlogOrigin.status)) {
      return {
        success: false,
        repo: repositoryName,
        error: `Backlog task ${originId} is ${backlogOrigin.status}; only a pending, failed or running item can be queued`,
        code: 'ORIGIN_NOT_DISPATCHABLE',
      };
    }

    // A live run already holds the origin's last attempt; stacking behind it is the only way in.
    const stackedRun = backlogOrigin?.status === 'dispatched';
    if (backlogOrigin && !stackedRun && backlogOrigin.attemptCount >= backlogOrigin.maxAttempts) {
      return {
        success: false,
        repo: repositoryName,
        error: `Backlog task ${originId} has spent all ${backlogOrigin.maxAttempts} of its attempts`,
        code: 'ORIGIN_NOT_DISPATCHABLE',
      };
    }

    const configuredDefault = this.resolveDispatchModel(undefined, resolved.defaultDispatchModel);
    const requestedCascade: CascadeHop[] = normalizeCascade(
      req.cascade ?? [{ model: configuredDefault, effort: resolved.defaultDispatchEffort }],
      configuredDefault
    );
    let eligibility = this.evaluateEligibility({
      model: requestedCascade[0]?.model,
      scheduleMode,
      allowOverage,
    });
    let chosenHop: CascadeHop = {
      model: eligibility.resolvedModel,
      effort: resolveReasoningEffortForModel(
        eligibility.resolvedModel,
        requestedCascade[0]?.effort ?? resolved.defaultDispatchEffort
      ),
    };
    for (const hop of requestedCascade.slice(1)) {
      if (eligibility.allowed) break;
      if (
        eligibility.code !== 'OVERAGE_PROTECTION_TRIGGERED' &&
        eligibility.code !== 'TELEMETRY_UNAVAILABLE'
      ) {
        break;
      }
      const next = this.evaluateEligibility({
        model: hop.model,
        scheduleMode,
        allowOverage,
      });
      if (next.allowed) {
        eligibility = next;
        chosenHop = { model: next.resolvedModel, effort: hop.effort };
      }
    }

    // Both blocked codes answer with the same payload, so only the code varies.
    const blockedDispatch = (
      code: 'OVERAGE_PROTECTION_TRIGGERED' | 'TELEMETRY_UNAVAILABLE'
    ): DispatchTaskResponse => {
      this.log.warn(
        'Task dispatch blocked for "%s" (model=%s, pool=%s): %s',
        repositoryName,
        eligibility.resolvedModel,
        eligibility.poolGroup,
        eligibility.reason
      );
      return {
        success: false,
        repo: repositoryName,
        model: eligibility.resolvedModel,
        poolGroup: eligibility.poolGroup ?? undefined,
        error: eligibility.reason,
        code,
        minDispatchHeadroomPercent: resolved.minDispatchHeadroomPercent,
        currentHeadroomPercent: eligibility.effectiveHeadroomPercent,
      };
    };

    if (!eligibility.allowed && eligibility.code === 'OVERAGE_PROTECTION_TRIGGERED') {
      return blockedDispatch('OVERAGE_PROTECTION_TRIGGERED');
    }

    if (!resolved.coordinatorEnabled) {
      return {
        success: false,
        error:
          'Coordinator is disabled while running in alerting-only mode. Enable coordinator in settings or set COORDINATOR_ENABLED=true.',
        code: 'COORDINATOR_DISABLED',
        dispatchId: `disp-${Date.now()}`,
        repo: repositoryName,
      };
    }

    if (!eligibility.allowed && eligibility.code === 'TELEMETRY_UNAVAILABLE') {
      return blockedDispatch('TELEMETRY_UNAVAILABLE');
    }

    const matchedRepo = this.findConfiguredRepository(resolved, repositoryId);
    const repoId =
      matchedRepo?.id ?? (repositoryId.toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'default');
    const repoDisplayName = matchedRepo?.name ?? req.repositoryName ?? repositoryId;
    const repoPath =
      req.repositoryPath && req.repositoryPath.trim() !== ''
        ? req.repositoryPath.trim()
        : matchedRepo?.path || `/repos/${repoId}`;
    const cloneUrl = req.cloneUrl || matchedRepo?.cloneUrl;
    const defaultBranch = matchedRepo?.defaultBranch || 'main';

    const concreteModel = chosenHop.model;
    const effort: ReasoningEffort = resolveReasoningEffortForModel(
      chosenHop.model,
      chosenHop.effort
    );
    // Failover hops are stored resolved: a raw id the tier withholds would make the runner retry it.
    const seenHops = new Set<string>([concreteModel]);
    const failoverHops: CascadeHop[] = [];
    for (const hop of requestedCascade) {
      const model = this.resolveDispatchModel(hop.model, configuredDefault);
      if (seenHops.has(model)) continue;
      seenHops.add(model);
      failoverHops.push({ model, effort: resolveReasoningEffortForModel(model, hop.effort) });
    }
    const dispatchCascade: CascadeHop[] = [{ model: concreteModel, effort }, ...failoverHops];
    const requiredLabels = req.requiredLabels ?? [];

    const title = req.title;

    if (tier === 'immediate') {
      this.setLastManualDispatchAt(Date.now());
    }

    const routinePool =
      tier === 'routine'
        ? findPoolForGroup(this.getActivePools(), resolvePoolGroupForModel(concreteModel))
        : undefined;
    const expiresAt =
      req.expiresAt ??
      (tier === 'backlog'
        ? new Date(Date.now() + BACKLOG_QUEUE_TTL_MS).toISOString()
        : this.preResetExpiry(routinePool));

    const enqueueInput: EnqueueTaskInput = {
      repositoryId: repoId,
      repositoryName: repoDisplayName,
      repositoryPath: repoPath,
      cloneUrl,
      defaultBranch,
      prompt: req.prompt,
      title,
      tier,
      originId,
      originNumber,
      originTitle,
      originIssueNumber: backlogOrigin?.githubIssueNumber ?? undefined,
      requestedBy: req.requestedBy || 'web-ui',
      prPolicy: req.prPolicy ?? resolved.prPolicy,
      scheduleMode,
      requiredLabels,
      cascade: dispatchCascade,
      allowOverage,
      pushBranch: req.pushBranch ?? true,
      autoCreatePr: req.autoCreatePr ?? true,
      expiresAt,
      verifyCommand: req.verifyCommand,
    };

    // Queueing behind a live run is not a retry, so it inherits the spent attempt.
    const task = backlogOrigin
      ? this.queue.spawnBacklogTask(enqueueInput, {
          id: backlogOrigin.id,
          attemptCount: stackedRun
            ? backlogOrigin.attemptCount
            : Math.min(backlogOrigin.attemptCount + 1, backlogOrigin.maxAttempts),
        })
      : this.queue.enqueue(enqueueInput);

    if (stackedRun) {
      this.log.info(
        'Task %s stacked behind the run already executing backlog #%d',
        task.id,
        backlogOrigin.taskNumber
      );
    }

    const plannedBranch = buildContinuationBranchName(
      task.id,
      resolveTaskTitle(task.title, task.prompt)
    );

    this.log.info(
      'Task %s enqueued for %s (scheduleMode=%s, model=%s)',
      task.id,
      repoDisplayName,
      scheduleMode,
      concreteModel
    );

    await this.notifyBestEffort({
      taskId: task.id,
      status: 'polling',
      repositoryName: repoDisplayName,
      repositoryPath: repoPath,
      prompt: task.prompt,
      branchName: plannedBranch,
      model: concreteModel,
      requestedBy: task.requestedBy,
      message:
        eligibility.code === 'QUOTA_BURN_CONDITIONS_NOT_MET'
          ? `Task ${task.id} queued for Pre-Reset Quota-Burn (${concreteModel})`
          : `Task ${task.id} queued (${scheduleMode}, model: ${concreteModel})`,
    });

    this.bus.emit('task:available');

    return {
      success: true,
      status: 'queued',
      taskId: task.id,
      dispatchId: task.id,
      repo: repoDisplayName,
      branchName: plannedBranch,
      model: concreteModel,
      poolGroup: task.poolGroup,
      scheduleMode,
      requiredLabels: task.requiredLabels,
      ...(!eligibility.allowed && eligibility.code === 'QUOTA_BURN_CONDITIONS_NOT_MET'
        ? { code: 'QUOTA_BURN_QUEUED' as const }
        : {}),
    };
  }

  public async retryTask(task: SwarmTask): Promise<DispatchTaskResponse> {
    const expiresAt =
      task.expiresAt && Date.parse(task.expiresAt) > Date.now() ? task.expiresAt : undefined;
    const result = await this.dispatch({
      repositoryId: task.repositoryId,
      repositoryName: task.repositoryName,
      repositoryPath: task.repositoryPath,
      cloneUrl: task.cloneUrl,
      prompt: task.prompt,
      title: task.title,
      tier: task.tier,
      originId: task.originId,
      originNumber: task.originNumber,
      originTitle: task.originTitle,
      requestedBy: 'web-ui (retry)',
      prPolicy: task.prPolicy,
      scheduleMode: task.scheduleMode,
      cascade: task.cascade,
      requiredLabels: task.requiredLabels,
      expiresAt,
      allowOverage: task.allowOverage,
      pushBranch: task.pushBranch,
      autoCreatePr: task.autoCreatePr,
      verifyCommand: task.verifyCommand,
    });

    if (result.success && result.taskId && task.tier === 'routine' && task.originId) {
      this.queue.updateRoutineTask(task.originId, { lastTaskId: result.taskId });
    }

    return result;
  }

  public async dispatchContinuation(params: {
    taskId?: string;
    branchName?: string;
    prompt: string;
    requestedBy?: string;
    requestedByUserId?: string;
    cascade?: CascadeHop[];
    repositoryName?: string;
    repositoryId?: string;
    scheduleMode?: ScheduleMode;
  }): Promise<DispatchTaskResponse> {
    const parentTask = params.taskId ? this.queue.getTask(params.taskId) : null;
    const continuationCascade = params.cascade?.length ? params.cascade : parentTask?.cascade;
    return this.dispatch({
      repositoryId:
        parentTask?.repositoryId || params.repositoryId || params.repositoryName || 'default',
      repositoryName: parentTask?.repositoryName || params.repositoryName || 'unknown',
      repositoryPath: parentTask?.repositoryPath,
      cloneUrl: parentTask?.cloneUrl,
      prompt: params.prompt,
      requestedBy: params.requestedBy || parentTask?.requestedBy,
      requestedByUserId: params.requestedByUserId,
      tier: parentTask?.tier ?? 'immediate',
      prPolicy: parentTask?.prPolicy,
      cascade: continuationCascade,
      scheduleMode: params.scheduleMode || parentTask?.scheduleMode,
    });
  }

  public createRegistrationToken(
    input: CreateRegistrationTokenInput = {}
  ): RunnerRegistrationTokenResult {
    const res = this.queue.runners.createRegistrationToken(input);
    this.log.info(
      'Created one-time runner registration token %s (expires=%s)',
      res.id,
      res.expiresAt
    );
    return res;
  }

  public registerRunner(input: ExchangeRegistrationTokenInput): {
    runner: SwarmRunnerRecord;
    runnerToken: string;
  } | null {
    const result = this.queue.runners.exchangeRegistrationToken(input);
    if (result) {
      this.log.info(
        'Registered swarm runner "%s" (%s, labels=%s)',
        result.runner.name,
        result.runner.runnerId,
        result.runner.labels.join(',') || 'none'
      );
    }
    return result;
  }

  public authenticateRunner(providedToken?: string): {
    authenticated: boolean;
    runner?: SwarmRunnerRecord;
    viaSharedSecret?: boolean;
    isSharedSecret?: boolean;
  } {
    const resolved = this.configStore.resolveConfig();
    const res = this.queue.runners.authenticateRunner(providedToken, resolved.runnerSharedSecret);
    // A registration token is spent on first authenticated use, not on exchange, so a runner that
    // crashed before persisting runner.json can still re-exchange it.
    if (res.authenticated && res.runner) {
      this.queue.runners.markRegistrationTokenUsed(res.runner.runnerId);
    }
    return {
      ...res,
      isSharedSecret: res.viaSharedSecret,
    };
  }

  public async pollForTask(
    pollReq: RunnerPollRequest,
    abortSignal?: AbortSignal
  ): Promise<SwarmTask | null> {
    const tryClaim = (): SwarmTask | null => {
      return this.queue.claimNext({
        runnerId: pollReq.runnerId,
        runnerName: pollReq.runnerName,
        labels: pollReq.labels,
        repositories: pollReq.repositories,
        systemInfo: pollReq.systemInfo,
        eligibilityCheck: (candidate) => {
          if (pollReq.leaseGithubTasks === false && isGithubRemoteTask(candidate)) {
            pollReq.onLeaseBlocked?.(candidate, 'missing_github_token');
            return { allowed: false };
          }
          const evaluate = (model?: string) =>
            this.evaluateEligibility({
              model,
              scheduleMode: candidate.scheduleMode,
              allowOverage: candidate.allowOverage,
            });
          const primary = evaluate(candidate.model);
          if (primary.allowed) {
            return { allowed: true, resolvedModel: primary.resolvedModel };
          }
          // A blocked primary hop must not park a task whose later hops are dispatchable.
          for (const hop of candidate.cascade) {
            if (hop.model === candidate.model) continue;
            const fallback = evaluate(hop.model);
            if (fallback.allowed) {
              return { allowed: true, resolvedModel: fallback.resolvedModel };
            }
          }
          return { allowed: false, resolvedModel: primary.resolvedModel };
        },
      });
    };

    // A claim nobody reads strands the task until its lease expires, so a hung-up client gets nothing.
    const clientGone = (): boolean => abortSignal?.aborted === true;
    if (clientGone()) return null;

    const immediate = tryClaim();
    if (immediate) {
      this.burnKick.fire(immediate);
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
        if (clientGone()) {
          cleanup();
          resolve(null);
          return;
        }
        const claimed = tryClaim();
        if (claimed) {
          cleanup();
          this.burnKick.fire(claimed);
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

  private backlogIssueRepoSlug(origin: BacklogTaskRecord): string | undefined {
    if (OWNER_REPO_SLUG_RE.test(origin.repositoryId)) return origin.repositoryId;
    const repo = this.configStore
      .resolveConfig()
      .repositories.find((entry) => entry.id === origin.repositoryId);
    const fromCloneUrl = parseGithubSlugFromUrl(repo?.cloneUrl);
    if (fromCloneUrl) return fromCloneUrl;
    if (!origin.githubIssueUrl) return undefined;
    let parsed: URL;
    try {
      parsed = new URL(origin.githubIssueUrl.trim());
    } catch {
      return undefined;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    const host = parsed.hostname.toLowerCase();
    if (!GITHUB_WEB_HOSTS.has(host)) return undefined;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (
      segments.length !== 4 ||
      segments[2]?.toLowerCase() !== 'issues' ||
      !/^\d+$/.test(segments[3] ?? '') ||
      segments[0] === '.' ||
      segments[0] === '..' ||
      segments[1] === '.' ||
      segments[1] === '..'
    ) {
      return undefined;
    }
    const slug = `${segments[0]}/${segments[1]}`;
    return OWNER_REPO_SLUG_RE.test(slug) ? slug : undefined;
  }

  private async clearBacklogLabelForPr(originId: string): Promise<void> {
    const origin = this.queue.getBacklogTask(originId);
    const issueNumber = origin?.githubIssueNumber;
    if (!origin || !issueNumber) return;

    const repoSlug = this.backlogIssueRepoSlug(origin);
    if (!repoSlug) return;

    const resolved = this.configStore.resolveConfig();
    const label = resolved.githubBacklogLabel || 'backlog';
    const outcome = await this.issueLabelRemover({
      repoSlug,
      issueNumber,
      label,
      token: resolved.githubToken,
    });
    if (outcome === 'failed') {
      this.log.warn(
        'Could not remove label "%s" from %s#%d after the PR opened',
        label,
        repoSlug,
        issueNumber
      );
      return;
    }
    this.log.info(
      'Removed label "%s" from %s#%d: a PR covers it now',
      label,
      repoSlug,
      issueNumber
    );
  }

  private applyBacklogOutcome(outcome: {
    originId: string;
    taskId?: string;
    status: TaskStatus;
    claimed: boolean;
    error?: string;
  }): void {
    try {
      settleBacklogOrigin(this.queue, outcome, this.log);
    } catch (backlogStatusErr) {
      this.log.error('Error updating backlog task status: %s', backlogStatusErr);
    }
  }

  public reconcileBacklogOrigins(): number {
    let settled = 0;
    for (const origin of this.queue.listDispatchedBacklogTasks()) {
      const swarmTask = origin.swarmTaskId ? this.queue.getTask(origin.swarmTaskId) : undefined;
      if (swarmTask && !isTerminalTaskStatus(swarmTask.status)) continue;
      this.applyBacklogOutcome({
        originId: origin.id,
        taskId: swarmTask?.id,
        status: swarmTask ? swarmTask.status : 'failed',
        claimed: swarmTask ? Boolean(swarmTask.claimedAt) : true,
        error: swarmTask?.error || 'Task ended without a status report',
      });
      if (this.queue.getBacklogTask(origin.id)?.status !== 'dispatched') settled++;
    }
    return settled;
  }

  public async cancelTask(
    taskId: string
  ): Promise<{ task: SwarmTask; applied: boolean } | undefined> {
    return this.reportTaskStatus(taskId, {
      status: 'aborted',
      error: 'Task aborted by user',
      message: `Task ${taskId} cancelled`,
    });
  }

  public async reportTaskStatus(
    taskId: string,
    patch: TaskStatusPatch & { message?: string }
  ): Promise<{ task: SwarmTask; applied: boolean } | undefined> {
    const result = this.queue.updateTaskStatus(taskId, patch);
    if (!result) return undefined;

    const { task: updated, applied } = result;
    if (!applied) return result;

    const statusStep =
      updated.status === 'completed'
        ? 'completed'
        : updated.status === 'no_changes'
          ? 'no_changes'
          : updated.status === 'failed'
            ? 'failed'
            : updated.status === 'aborted'
              ? 'aborted'
              : 'executing';

    const defaultMsg =
      updated.status === 'completed'
        ? ''
        : updated.status === 'no_changes'
          ? `Task ${updated.id} finished with no file changes (${updated.model})`
          : updated.status === 'failed'
            ? `Task ${updated.id} failed: ${updated.error || 'Unknown error'}`
            : `Executing task ${updated.id} on ${updated.repositoryName} (${updated.model})`;

    if (isTerminalTaskStatus(updated.status)) {
      const deliverables = [updated.prUrl, ...(updated.issueUrls ?? [])].filter(Boolean);
      this.log.info(
        'Task %s settled as %s on %s in %s%s',
        updated.id,
        updated.status,
        updated.repositoryName,
        updated.durationMs !== undefined
          ? `${Math.round(updated.durationMs / 1000)}s`
          : 'unknown time',
        deliverables.length > 0 ? ` (${deliverables.join(' ')})` : ''
      );
    }

    if (updated.tier === 'backlog' && updated.originId) {
      this.applyBacklogOutcome({
        originId: updated.originId,
        taskId: updated.id,
        status: updated.status,
        claimed: Boolean(updated.claimedAt),
        error: updated.error,
      });
      if (updated.prUrl && isTerminalTaskStatus(updated.status)) {
        void this.clearBacklogLabelForPr(updated.originId).catch((labelErr) =>
          this.log.warn('Could not clear the backlog label on %s: %s', updated.originId, labelErr)
        );
      }
    }

    await this.notifyBestEffort({
      taskId: updated.id,
      status: statusStep,
      repositoryName: updated.repositoryName,
      repositoryPath: updated.repositoryPath,
      prompt: updated.prompt,
      branchName: updated.branchName,
      issueUrls: updated.issueUrls,
      model: updated.model,
      effort: modelSupportsEffort(updated.model) ? updated.effort : undefined,
      output: updated.output,
      error: updated.error,
      durationMs: updated.durationMs,
      createdAt: updated.createdAt,
      requestedBy: updated.requestedBy,
      message: patch.message ?? defaultMsg,
    });

    this.bus.emit(`task:updated:${taskId}`, updated);

    if (isTerminalTaskStatus(updated.status) && updated.originId) {
      this.bus.emit('task:available');
    }

    return result;
  }

  public listRunners(): SwarmRunnerRecord[] {
    return this.queue.runners.listRunners();
  }

  public setRunnerEnabled(runnerId: string, enabled: boolean): SwarmRunnerRecord | undefined {
    const updated = this.queue.runners.setRunnerEnabled(runnerId, enabled);
    if (updated) {
      this.log.info('Swarm runner "%s" (%s) enabled=%s', updated.name, runnerId, String(enabled));
      if (enabled) {
        this.bus.emit('task:available');
      }
    }
    return updated;
  }

  public revokeRunner(runnerId: string): boolean {
    const revoked = this.queue.runners.revokeRunner(runnerId);
    if (revoked) {
      this.log.info('Revoked swarm runner %s and returned any active claims to queue', runnerId);
      this.bus.emit('task:available');
    }
    return revoked;
  }
}
