import { EventEmitter } from 'node:events';
import type { ConfigStore } from '../config/store.js';
import type { PrPolicy } from '../config/schema.js';
import { DEFAULT_QUOTA_BURN_MAX_HOURS } from '../config/schema.js';
import type { EarlyResetPool, SentryStateManager } from '../sentry/state.js';
import {
  calculateHoursUntilReset,
  snapshotsFromSentryState,
  type PoolGroup,
  type QuotaSnapshot,
} from '../sentry/models.js';
import type { DispatchStatusUpdate, Notifier } from '../notify/types.js';
import { logger, type Logger } from '../logs/logger.js';
import {
  CANONICAL_AGY_MODELS,
  calculateEffectiveHeadroomPercent,
  evaluateModelDispatchEligibility,
  evaluateModelPreferenceChain,
  normalizeCascade,
  resolveAvailableModelId,
  resolveConcreteModelId,
  resolveDefaultDispatchModel,
  resolvePoolGroupForModel,
  isTerminalTaskStatus,
  resolveReasoningEffortForModel,
  modelSupportsEffort,
  ROUTINE_CYCLE_REARM_STATUSES,
  type AgyModelCatalogEntry,
  type CascadeHop,
  type ModelEligibilityResult,
  type ReasoningEffort,
  type RoutineEligibilityStatus,
  type ScheduleMode,
  type TaskStatus,
  type TaskTier,
} from './models.js';
import {
  TaskQueue,
  type CreateRegistrationTokenInput,
  type ExchangeRegistrationTokenInput,
  type RoutineTaskRecord,
  type RunnerRegistrationTokenResult,
  type RunnerSystemInfo,
  type SwarmRunnerRecord,
  type SwarmTask,
  type TaskStatusPatch,
} from './queue.js';
import { buildContinuationBranchName } from '../runner/policy.js';
import { upgradePoolGroupId } from '../shared/models.js';
import type { ModelCatalogProvider } from './catalog.js';

// A pool id is either the group id or `<group>:<slug>`; only the prefix names the group.
const poolGroupOfPoolId = (poolId: string): string => {
  const upgraded = upgradePoolGroupId(poolId);
  const separator = upgraded.indexOf(':');
  return separator >= 0 ? upgraded.slice(0, separator) : upgraded;
};

const BURN_KICK_CYCLES_KEY = 'burnKickAnnouncedCycles';

export interface DispatchTaskRequest {
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

export interface DispatchTaskResponse {
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
    | 'EXECUTION_FAILED';
  minDispatchHeadroomPercent?: number;
  currentHeadroomPercent?: number;
  durationMs?: number;
}

export interface RunnerPollRequest {
  runnerId: string;
  runnerName?: string;
  labels?: string[];
  repositories?: string[];
  systemInfo?: RunnerSystemInfo;
  timeoutMs?: number;
}

export interface CoordinatorOptions {
  configStore: ConfigStore;
  sentryState?: SentryStateManager;
  notifier?: Notifier;
  logger?: Logger;
  modelCatalog?: ModelCatalogProvider;
}

export class Coordinator {
  public readonly queue: TaskQueue;
  private readonly configStore: ConfigStore;
  private readonly sentryState?: SentryStateManager;
  private modelCatalog?: ModelCatalogProvider;
  private notifier?: Notifier;
  private readonly log: Logger;
  private readonly bus = new EventEmitter();
  private latestSnapshots: QuotaSnapshot[] = [];
  private lastSnapshotAt = 0;
  private lastManualDispatchAt = 0;

  constructor(options: CoordinatorOptions) {
    this.configStore = options.configStore;
    this.queue = new TaskQueue(options.configStore.getDatabase());
    this.sentryState = options.sentryState;
    this.modelCatalog = options.modelCatalog;
    this.notifier = options.notifier;
    this.log = options.logger ?? logger.child('coordinator');
    this.bus.setMaxListeners(100);
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

  private readBurnKickCycles(): Record<string, string> {
    const raw = this.queue.getRuntimeValue(BURN_KICK_CYCLES_KEY);
    if (!raw) return {};
    try {
      return (JSON.parse(raw) as Record<string, string>) ?? {};
    } catch {
      return {};
    }
  }

  private writeBurnKickCycles(cycles: Record<string, string>): void {
    this.queue.setRuntimeValue(BURN_KICK_CYCLES_KEY, JSON.stringify(cycles));
  }

  private hasAnnouncedBurnKick(poolGroup: string, resetTime: string): boolean {
    return this.readBurnKickCycles()[poolGroup] === resetTime;
  }

  private recordBurnKick(poolGroup: string, resetTime: string): void {
    const cycles = this.readBurnKickCycles();
    cycles[poolGroup] = resetTime;
    this.writeBurnKickCycles(cycles);
  }

  private async announceBurnKick(params: {
    label: string;
    pool: QuotaSnapshot;
    models: string[];
    headroomPercent: number | null;
    triggerHours: number;
  }): Promise<void> {
    const poolGroup = params.pool.poolGroup;
    const resetTime = params.pool.resetTime;
    if (!resetTime || this.hasAnnouncedBurnKick(poolGroup, resetTime)) return;
    this.recordBurnKick(poolGroup, resetTime);

    this.log.info(
      'Pre-reset window open on %s (<=%dh, %d%% headroom); quota-burn looping until %s',
      params.pool.displayName || poolGroup,
      params.triggerHours,
      params.headroomPercent ?? 0,
      resetTime
    );

    await this.notifier?.notifyInfo({
      title: 'Pre-reset burn started',
      message:
        `${params.label} entered the pre-reset window (<=${params.triggerHours}h) with ` +
        `${params.headroomPercent ?? 0}% headroom. Quota-burn looping is now active for this pool ` +
        `until the reset at ${resetTime}.`,
      poolGroup: poolGroup,
      poolName: params.pool.displayName || params.pool.poolId,
      models: params.models,
      resetTime,
      hoursUntilReset: params.pool.hoursUntilReset,
    });
  }

  private async announceOpportunisticBurnKick(task: SwarmTask): Promise<void> {
    if (task.scheduleMode !== 'pre_reset') return;
    const poolGroup = resolvePoolGroupForModel(task.model);
    const pool = this.getActivePools().find(
      (p) => p.poolGroup === poolGroup || p.poolId === poolGroup
    );
    if (!pool) return;

    const resolved = this.configStore.resolveConfig();
    await this.announceBurnKick({
      label: `Pre-reset task #${task.taskNumber} "${task.title}"`,
      pool,
      models: [task.model],
      headroomPercent: calculateEffectiveHeadroomPercent(pool),
      triggerHours: resolved.quotaBurnMaxHours ?? DEFAULT_QUOTA_BURN_MAX_HOURS,
    });
  }

  private fireBurnKickAnnouncement(task: SwarmTask): void {
    void this.announceOpportunisticBurnKick(task).catch((kickErr) =>
      this.log.warn('Burn-kick announcement failed for %s: %s', task.id, kickErr)
    );
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

    const cycles = this.readBurnKickCycles();
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
    if (changed) this.writeBurnKickCycles(cycles);

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
      const nextBacklog = this.queue.getNextEligibleBacklogTask();
      if (nextBacklog && !this.queue.hasActiveTaskForOrigin(nextBacklog.id)) {
        const modelChoice = evaluateModelPreferenceChain({
          cascade: nextBacklog.cascade,
          defaultModel: resolved.defaultDispatchModel,
          pools: snapshots,
          minHeadroomPercent: resolved.minDispatchHeadroomPercent ?? 10,
          isPoolDispatchEnabled: (poolGroup) =>
            resolved.poolGroupPolicies?.[poolGroup]?.dispatchEnabled !== false,
          catalog: this.activeModelCatalog(),
        });

        if (
          modelChoice.allowed &&
          modelChoice.selectedModel &&
          modelChoice.selectedEffort !== undefined
        ) {
          const matchedRepo = resolved.repositories.find(
            (r) =>
              r.id.toLowerCase() === nextBacklog.repositoryId.toLowerCase() ||
              r.name.toLowerCase() === nextBacklog.repositoryId.toLowerCase()
          );
          const repoPath = matchedRepo?.path || `/repos/${nextBacklog.repositoryId}`;
          const cloneUrl = matchedRepo?.cloneUrl;
          const defaultBranch = matchedRepo?.defaultBranch || 'main';

          const created = this.queue.enqueue({
            repositoryId: nextBacklog.repositoryId,
            repositoryName: matchedRepo?.name || nextBacklog.repositoryId,
            repositoryPath: repoPath,
            cloneUrl,
            defaultBranch,
            prompt: nextBacklog.prompt,
            title: nextBacklog.title,
            tier: 'backlog',
            originId: nextBacklog.id,
            originNumber: nextBacklog.taskNumber,
            originTitle: nextBacklog.title,
            requestedBy: `backlog:${nextBacklog.id}`,
            prPolicy: resolved.prPolicy,
            scheduleMode: 'pre_reset',
            expiresAt: this.preResetExpiry(
              snapshots.find(
                (pool) =>
                  pool.poolGroup === resolvePoolGroupForModel(modelChoice.selectedModel!) ||
                  pool.poolId === modelChoice.selectedModel
              )
            ),
            cascade: this.resolveFallbackCascade({
              cascade: nextBacklog.cascade,
              selectedModel: modelChoice.selectedModel,
              selectedEffort: modelChoice.selectedEffort,
              pools: snapshots,
              minHeadroomPercent: resolved.minDispatchHeadroomPercent ?? 10,
              isPoolDispatchEnabled: (poolGroup) =>
                resolved.poolGroupPolicies?.[poolGroup]?.dispatchEnabled !== false,
              defaultModel: resolved.defaultDispatchModel,
              catalog: this.activeModelCatalog(),
            }),
            autoCreatePr: nextBacklog.autoCreatePr,
            verifyCommand: nextBacklog.verifyCommand,
          });

          this.queue.updateBacklogTask(nextBacklog.id, {
            status: 'dispatched',
            attemptCount: nextBacklog.attemptCount + 1,
            swarmTaskId: created.id,
          });

          spawned.push(created);
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

  private routineMayTriggerAgain(
    rt: RoutineTaskRecord,
    poolKey: string,
    resetTime: string
  ): boolean {
    const cycles = rt.lastTriggeredCycles ?? {};
    const stamped = Object.keys(cycles).length > 0 ? cycles[poolKey] : rt.lastTriggeredResetTime;
    if (!stamped || stamped !== resetTime) {
      return true;
    }

    const previous =
      this.queue.getLatestTaskForOrigin(rt.id, poolKey) ??
      (rt.lastTaskId ? this.queue.getTask(rt.lastTaskId) : undefined);
    // A stamped cycle whose run can no longer be found stays burned: looping blind burns quota.
    if (!previous) return false;

    return (ROUTINE_CYCLE_REARM_STATUSES as readonly string[]).includes(previous.status);
  }

  private orderRoutineCandidates(routines: RoutineTaskRecord[]): RoutineTaskRecord[] {
    const lastRunMs = (rt: RoutineTaskRecord): number => {
      if (!rt.lastTaskId) return 0;
      const previous = this.queue.getTask(rt.lastTaskId);
      const parsed = previous ? Date.parse(previous.createdAt) : 0;
      return Number.isFinite(parsed) ? parsed : 0;
    };

    return [...routines].sort(
      (a, b) =>
        lastRunMs(a) - lastRunMs(b) || a.sortOrder - b.sortOrder || a.taskNumber - b.taskNumber
    );
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

      // The routine's own window wins; the global burn window is only a fallback.
      const triggerHours =
        rt.triggerBeforeResetHours && rt.triggerBeforeResetHours > 0
          ? rt.triggerBeforeResetHours
          : (resolved.quotaBurnMaxHours ?? DEFAULT_QUOTA_BURN_MAX_HOURS);
      const minHeadroom = Math.max(
        rt.minHeadroomPercent ?? 10,
        resolved.minDispatchHeadroomPercent ?? 0
      );

      const passing: Array<{ hop: CascadeHop; poolGroup: string; pool: QuotaSnapshot }> = [];
      for (const hop of rt.cascade) {
        const concreteModel = this.resolveDispatchModel(hop.model, resolved.defaultDispatchModel);
        const poolGroup = resolvePoolGroupForModel(concreteModel);

        const policy = resolved.poolGroupPolicies?.[poolGroup];
        if (policy && !policy.dispatchEnabled) {
          continue;
        }

        const pool = snapshots.find(
          (p) =>
            p.poolGroup === poolGroup ||
            p.poolId === poolGroup ||
            resolvePoolGroupForModel(p.poolId || p.displayName) === poolGroup
        );
        if (!pool) continue;

        const resetTime = pool.resetTime;
        const hoursUntilReset =
          typeof pool.hoursUntilReset === 'number' && pool.hoursUntilReset > 0
            ? pool.hoursUntilReset
            : calculateHoursUntilReset(pool.resetTime, Date.now());

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
      // Later hops stay in the cascade so the runner can fail over at each hop's own effort.
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

      const matchedRepo = resolved.repositories.find(
        (r) =>
          r.id.toLowerCase() === rt.repositoryId.toLowerCase() ||
          r.name.toLowerCase() === rt.repositoryId.toLowerCase()
      );
      const repoPath = matchedRepo?.path || `/repos/${rt.repositoryId}`;
      const cloneUrl = matchedRepo?.cloneUrl;
      const defaultBranch = matchedRepo?.defaultBranch || 'main';

      const task = this.queue.enqueue({
        repositoryId: rt.repositoryId,
        repositoryName: matchedRepo?.name || rt.repositoryId,
        repositoryPath: repoPath,
        cloneUrl,
        defaultBranch,
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
        scheduleMode: 'pre_reset',
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

      void this.announceBurnKick({
        label: `Routine #${rt.taskNumber} "${rt.title}"`,
        pool: targetPool,
        models: [selectedModel],
        headroomPercent: calculateEffectiveHeadroomPercent(targetPool),
        triggerHours,
      }).catch((kickErr) =>
        this.log.warn('Burn-kick announcement failed for %s: %s', targetPool.poolGroup, kickErr)
      );

      spawned.push(task);
    }

    return spawned;
  }

  public computeRoutineEligibility(
    rt: RoutineTaskRecord,
    snapshots?: QuotaSnapshot[]
  ): RoutineEligibilityStatus {
    const resolved = this.configStore.resolveConfig();

    if (!rt.enabled) {
      return {
        state: 'disabled',
        label: 'Disabled',
        detail: 'This routine is disabled and will not dispatch.',
      };
    }

    if (this.queue.hasActiveTaskForOrigin(rt.id)) {
      const active = this.queue.getLatestTaskForOrigin(rt.id);
      return {
        state: 'running',
        label: 'Looping',
        detail: `Task ${active?.id ?? 'run'} is ${active?.status ?? 'in flight'} on this routine.`,
      };
    }

    const pools = snapshots && snapshots.length > 0 ? snapshots : this.getActivePools();
    if (pools.length === 0) {
      return {
        state: 'no_telemetry',
        label: 'No Telemetry',
        detail: 'No live quota telemetry is available, so dispatch cannot be validated.',
      };
    }

    const triggerHours =
      rt.triggerBeforeResetHours && rt.triggerBeforeResetHours > 0
        ? rt.triggerBeforeResetHours
        : (resolved.quotaBurnMaxHours ?? DEFAULT_QUOTA_BURN_MAX_HOURS);
    const minHeadroom = Math.max(
      rt.minHeadroomPercent ?? 10,
      resolved.minDispatchHeadroomPercent ?? 0
    );

    const targets = rt.cascade.map((hop) => {
      const model = this.resolveDispatchModel(hop.model, resolved.defaultDispatchModel);
      return { model, poolGroup: resolvePoolGroupForModel(model) };
    });
    const poolGroups = Array.from(new Set(targets.map((t) => t.poolGroup)));

    const enabledPoolGroups = new Set(
      poolGroups.filter(
        (poolGroup) => resolved.poolGroupPolicies?.[poolGroup]?.dispatchEnabled !== false
      )
    );
    if (enabledPoolGroups.size === 0) {
      return {
        state: 'pool_disabled',
        label: 'Pool Disabled',
        detail: `Dispatching is disabled for every pool this routine targets (${poolGroups.join(', ')}).`,
      };
    }

    let sawPool = false;
    let cycleComplete: string | undefined;
    let cycleFailed: string | undefined;
    let waitingWindow: string | undefined;
    let lowHeadroom: string | undefined;

    for (const { model, poolGroup } of targets) {
      if (!enabledPoolGroups.has(poolGroup)) continue;

      const pool = pools.find(
        (p) =>
          p.poolGroup === poolGroup ||
          p.poolId === poolGroup ||
          resolvePoolGroupForModel(p.poolId || p.displayName) === poolGroup
      );
      if (!pool) continue;
      sawPool = true;

      const poolLabel = pool.displayName || pool.poolId;
      const hoursUntilReset =
        typeof pool.hoursUntilReset === 'number' && pool.hoursUntilReset > 0
          ? pool.hoursUntilReset
          : calculateHoursUntilReset(pool.resetTime, Date.now());

      if (!pool.resetTime || hoursUntilReset === null || hoursUntilReset <= 0) {
        waitingWindow ??= `${poolLabel} has no pending reset deadline; waiting for the next probe cycle.`;
        continue;
      }

      if (!this.routineMayTriggerAgain(rt, pool.poolId || pool.poolGroup, pool.resetTime)) {
        const previous =
          this.queue.getLatestTaskForOrigin(rt.id, pool.poolId || pool.poolGroup) ??
          (rt.lastTaskId ? this.queue.getTask(rt.lastTaskId) : undefined);
        const detail =
          `Cycle for ${poolLabel} is already burned for the reset at ${pool.resetTime}` +
          (previous ? ` (last run ${previous.status}).` : '.');
        // A cycle whose run failed or aborted ended in a terminal error, which reads differently.
        if (previous && (previous.status === 'failed' || previous.status === 'aborted')) {
          cycleFailed ??= detail;
        } else {
          cycleComplete ??= detail;
        }
        continue;
      }

      if (hoursUntilReset > triggerHours) {
        waitingWindow ??= `Reset in ${hoursUntilReset.toFixed(1)}h on ${poolLabel}; this routine opens at <=${triggerHours}h.`;
        continue;
      }

      const headroom = calculateEffectiveHeadroomPercent(pool);
      if (headroom === null) {
        lowHeadroom ??= `No usable headroom telemetry for ${poolLabel}.`;
        continue;
      }
      if (headroom < minHeadroom) {
        lowHeadroom ??= `${poolLabel} at ${headroom}% headroom, below the ${minHeadroom}% floor.`;
        continue;
      }

      return {
        state: 'ready',
        label: 'Ready',
        detail: `Dispatches on ${model} at the next probe (reset in ${hoursUntilReset.toFixed(1)}h, ${headroom}% headroom).`,
      };
    }

    if (cycleFailed) return { state: 'cycle_failed', label: 'Cycle Failed', detail: cycleFailed };
    if (cycleComplete) {
      return { state: 'cycle_complete', label: 'Cycle Complete', detail: cycleComplete };
    }
    if (waitingWindow) {
      return { state: 'waiting_window', label: 'Waiting Window', detail: waitingWindow };
    }
    if (lowHeadroom) return { state: 'low_headroom', label: 'Low Headroom', detail: lowHeadroom };

    return {
      state: 'no_telemetry',
      label: 'No Telemetry',
      detail: sawPool
        ? 'No pending dispatch condition is satisfied yet.'
        : `No quota pool matches ${poolGroups.join(', ')}.`,
    };
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
    const policy = resolved.poolGroupPolicies?.[poolGroup];
    if (policy && !policy.dispatchEnabled && !params.allowOverage) {
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
    const repositoryId = (req.repositoryId || (req as any).repositoryName || '').trim();
    const repositoryName = req.repositoryName?.trim() || repositoryId;
    const scheduleMode: ScheduleMode = req.scheduleMode ?? 'immediate';
    const allowOverage = Boolean(req.allowOverage);

    if (!repositoryId) {
      return {
        success: false,
        repo: 'unknown',
        error: 'repositoryId is required',
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

    if (!eligibility.allowed && eligibility.code === 'OVERAGE_PROTECTION_TRIGGERED') {
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
        code: 'OVERAGE_PROTECTION_TRIGGERED',
        minDispatchHeadroomPercent: resolved.minDispatchHeadroomPercent,
        currentHeadroomPercent: eligibility.effectiveHeadroomPercent,
      };
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
        code: 'TELEMETRY_UNAVAILABLE',
        minDispatchHeadroomPercent: resolved.minDispatchHeadroomPercent,
        currentHeadroomPercent: eligibility.effectiveHeadroomPercent,
      };
    }

    const matchedRepo = resolved.repositories.find(
      (r) =>
        r.id.toLowerCase() === repositoryId.toLowerCase() ||
        r.name.toLowerCase() === repositoryId.toLowerCase()
    );
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

    const tier: TaskTier = req.tier ?? 'immediate';
    const originId = req.originId ?? req.standingTaskId;
    const originNumber = req.originNumber;
    const originTitle = req.originTitle;
    const title = req.title;

    if (tier === 'immediate') {
      this.setLastManualDispatchAt(Date.now());
    }

    const task = this.queue.enqueue({
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
      requestedBy: req.requestedBy || 'web-ui',
      prPolicy: req.prPolicy ?? resolved.prPolicy,
      scheduleMode,
      requiredLabels,
      // Later hops stay in the cascade so the runner can fail over at each hop's own effort.
      cascade: dispatchCascade,
      allowOverage,
      pushBranch: req.pushBranch ?? true,
      autoCreatePr: req.autoCreatePr ?? true,
      expiresAt: req.expiresAt,
      verifyCommand: req.verifyCommand,
    });

    const plannedBranch = buildContinuationBranchName(task.id, task.prompt);

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

    if (!eligibility.allowed && eligibility.code === 'QUOTA_BURN_CONDITIONS_NOT_MET') {
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
      poolGroup: task.poolGroup,
      scheduleMode,
      requiredLabels: task.requiredLabels,
    };
  }

  public async retryTask(task: SwarmTask): Promise<DispatchTaskResponse> {
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
      expiresAt: task.expiresAt,
      allowOverage: task.allowOverage,
      pushBranch: task.pushBranch,
      autoCreatePr: task.autoCreatePr,
      verifyCommand: task.verifyCommand,
    });

    if (result.success && result.taskId) {
      if (task.tier === 'backlog' && task.originId) {
        this.queue.updateBacklogTask(task.originId, {
          status: 'dispatched',
          swarmTaskId: result.taskId,
          lastError: null,
        });
      }
      if (task.tier === 'routine' && task.originId) {
        this.queue.updateRoutineTask(task.originId, { lastTaskId: result.taskId });
      }
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
    const res = this.queue.createRegistrationToken(input);
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
    const result = this.queue.exchangeRegistrationToken(input);
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
    const res = this.queue.authenticateRunner(providedToken, resolved.runnerSharedSecret);
    // A registration token is spent on first authenticated use, not on exchange, so a runner that
    // crashed before persisting runner.json can still re-exchange it.
    if (res.authenticated && res.runner) {
      this.queue.markRegistrationTokenUsed(res.runner.runnerId);
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
      this.fireBurnKickAnnouncement(immediate);
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
          this.fireBurnKickAnnouncement(claimed);
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

  private applyBacklogOutcome(originId: string, status: TaskStatus, error?: string): void {
    try {
      const backlogTask = this.queue.getBacklogTask(originId);
      if (
        !backlogTask ||
        backlogTask.status === 'completed' ||
        backlogTask.status === 'failed' ||
        backlogTask.status === 'canceled' ||
        backlogTask.status === 'paused'
      ) {
        return;
      }

      if (status === 'completed' || status === 'no_changes') {
        this.queue.updateBacklogTask(originId, { status: 'completed', lastError: null });
        this.log.info(
          'Backlog task #%d (%s) marked completed',
          backlogTask.taskNumber,
          backlogTask.title
        );
        return;
      }

      if (status !== 'failed' && status !== 'aborted') return;

      if (backlogTask.attemptCount < backlogTask.maxAttempts) {
        this.queue.updateBacklogTask(originId, {
          status: 'pending',
          lastError: error || 'Execution failed',
        });
        this.log.warn(
          'Backlog task #%d (%s) returned to pending for retry (attempt %d/%d)',
          backlogTask.taskNumber,
          backlogTask.title,
          backlogTask.attemptCount,
          backlogTask.maxAttempts
        );
      } else {
        this.queue.updateBacklogTask(originId, {
          status: 'failed',
          lastError: error || 'Max retry attempts exceeded',
        });
        this.log.warn(
          'Backlog task #%d (%s) marked failed after exhausting %d attempts',
          backlogTask.taskNumber,
          backlogTask.title,
          backlogTask.maxAttempts
        );
      }
    } catch (backlogStatusErr) {
      this.log.error('Error updating backlog task status: %s', backlogStatusErr);
    }
  }

  public reconcileBacklogOrigins(): number {
    let settled = 0;
    for (const origin of this.queue.listDispatchedBacklogTasks()) {
      const swarmTask = origin.swarmTaskId ? this.queue.getTask(origin.swarmTaskId) : undefined;
      if (swarmTask && !isTerminalTaskStatus(swarmTask.status)) continue;
      this.applyBacklogOutcome(
        origin.id,
        swarmTask ? swarmTask.status : 'failed',
        swarmTask?.error || 'Task ended without a status report'
      );
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

    if (updated.tier === 'backlog' && updated.originId) {
      this.applyBacklogOutcome(updated.originId, updated.status, updated.error);
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

    return result;
  }

  public listRunners(): SwarmRunnerRecord[] {
    return this.queue.listRunners();
  }

  public setRunnerEnabled(runnerId: string, enabled: boolean): SwarmRunnerRecord | undefined {
    const updated = this.queue.setRunnerEnabled(runnerId, enabled);
    if (updated) {
      this.log.info('Swarm runner "%s" (%s) enabled=%s', updated.name, runnerId, String(enabled));
      if (enabled) {
        this.bus.emit('task:available');
      }
    }
    return updated;
  }

  public revokeRunner(runnerId: string): boolean {
    const revoked = this.queue.revokeRunner(runnerId);
    if (revoked) {
      this.log.info('Revoked swarm runner %s and returned any active claims to queue', runnerId);
      this.bus.emit('task:available');
    }
    return revoked;
  }
}
