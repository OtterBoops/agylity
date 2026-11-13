import { EventEmitter } from 'node:events';
import type { ConfigStore } from '../config/store.js';
import type { PrPolicy } from '../config/schema.js';
import { DEFAULT_QUOTA_BURN_MAX_HOURS } from '../config/schema.js';
import type { SentryStateManager } from '../sentry/state.js';
import {
  calculateHoursUntilReset,
  snapshotsFromSentryState,
  type QuotaSnapshot,
} from '../sentry/models.js';
import type { Notifier } from '../notify/types.js';
import { logger, type Logger } from '../logs/logger.js';
import {
  calculateEffectiveHeadroomPercent,
  evaluateModelDispatchEligibility,
  evaluateModelPreferenceChain,
  resolveConcreteModelId,
  resolvePoolFamilyForModel,
  isTerminalTaskStatus,
  resolveReasoningEffortForModel,
  ROUTINE_CYCLE_REARM_STATUSES,
  type ModelEligibilityResult,
  type ReasoningEffort,
  type ScheduleMode,
  type TaskActor,
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
import { buildContinuationBranchName } from './runner.js';

/** Runtime-state key holding `{ family: resetTime }` for pools whose burn kick was already announced. */
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
  actor?: TaskActor;
  prPolicy?: PrPolicy;
  scheduleMode?: ScheduleMode;
  requiredLabels?: string[];
  model?: string;
  /** Ordered fallback chain; the first entry whose pool clears the floor is dispatched. */
  models?: string[];
  effort?: ReasoningEffort;
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
  poolFamily?: string;
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
}

export class Coordinator {
  public readonly queue: TaskQueue;
  private readonly configStore: ConfigStore;
  private readonly sentryState?: SentryStateManager;
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
    this.notifier = options.notifier;
    this.log = options.logger ?? logger.child('coordinator');
    this.bus.setMaxListeners(100);
    // The 2h autonomy quench must survive a redeploy, or every restart re-arms autonomous work.
    this.lastManualDispatchAt =
      Number(this.queue.getRuntimeValue('lastManualDispatchAt') ?? 0) || 0;
  }

  public setNotifier(notifier: Notifier): void {
    this.notifier = notifier;
  }

  public getLastManualDispatchAt(): number {
    return this.lastManualDispatchAt;
  }

  public setLastManualDispatchAt(timestampMs: number): void {
    this.lastManualDispatchAt = timestampMs;
    this.queue.setRuntimeValue('lastManualDispatchAt', String(timestampMs));
  }

  // One burn-kick notice per pool per reset cycle: the map records the cycle a pool was announced for.
  private hasAnnouncedBurnKick(family: string, resetTime: string): boolean {
    const raw = this.queue.getRuntimeValue(BURN_KICK_CYCLES_KEY);
    if (!raw) return false;
    try {
      const cycles = JSON.parse(raw) as Record<string, string>;
      return cycles[family] === resetTime;
    } catch {
      return false;
    }
  }

  private recordBurnKick(family: string, resetTime: string): void {
    const raw = this.queue.getRuntimeValue(BURN_KICK_CYCLES_KEY);
    let cycles: Record<string, string> = {};
    try {
      cycles = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      cycles = {};
    }
    cycles[family] = resetTime;
    this.queue.setRuntimeValue(BURN_KICK_CYCLES_KEY, JSON.stringify(cycles));
  }

  // Informational only: notifyInfo never mentions the owner, so this cannot ring a phone.
  private async announceBurnKick(params: {
    /** Prose prefix, e.g. `Routine #3 "Nightly sweep"`. */
    label: string;
    pool: QuotaSnapshot;
    models: string[];
    headroomPercent: number | null;
    triggerHours: number;
  }): Promise<void> {
    const family = params.pool.family;
    const resetTime = params.pool.resetTime;
    if (!resetTime || this.hasAnnouncedBurnKick(family, resetTime)) return;
    this.recordBurnKick(family, resetTime);

    await this.notifier?.notifyInfo({
      title: 'Pre-reset burn started',
      message:
        `${params.label} entered the pre-reset window (<=${params.triggerHours}h) with ` +
        `${params.headroomPercent ?? 0}% headroom. Quota-burn looping is now active for this pool ` +
        `until the reset at ${resetTime}.`,
      poolFamily: family,
      poolName: params.pool.displayName || params.pool.poolId,
      models: params.models,
      resetTime,
      hoursUntilReset: params.pool.hoursUntilReset,
    });
  }

  // Opportunistic pre_reset tasks only kick off when the window opens, which is exactly when
  // claimNext lets them through, so the announcement belongs after a claim, not at enqueue time.
  private async announceOpportunisticBurnKick(task: SwarmTask): Promise<void> {
    if (task.scheduleMode !== 'pre_reset') return;
    const family = resolvePoolFamilyForModel(task.model);
    const pool = this.getActivePools().find((p) => p.family === family || p.poolId === family);
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

  public getActivePools(): QuotaSnapshot[] {
    // A snapshot past its interval is most wrong right after a reset, so it must not
    // authorise dispatch: return nothing and let eligibility fail closed.
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
        void this.notifier?.notifyDispatchStatus({
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
    void this.triggerEligibleAutonomousTasks(snapshots);
    this.bus.emit('task:available');
  }

  // Evaluates autonomous tasks (Tier 2 Backlog and Tier 3 Routines) under 2-hour inactivity quench.
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

    // 1. Evaluate Backlog Tasks (Tier 2)
    try {
      const nextBacklog = this.queue.getNextEligibleBacklogTask();
      if (nextBacklog) {
        // Dual-bucket floor >= 40%
        const modelChoice = evaluateModelPreferenceChain({
          models: nextBacklog.models,
          defaultModel: resolved.defaultDispatchModel,
          pools: snapshots,
          minHeadroomPercent: resolved.minDispatchHeadroomPercent ?? 10,
          isPoolDispatchEnabled: (fam) => resolved.poolPolicies?.[fam]?.dispatchEnabled !== false,
        });

        if (modelChoice.allowed && modelChoice.selectedModel) {
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
            actor: nextBacklog.actor || 'bot',
            prPolicy: resolved.prPolicy,
            scheduleMode: 'immediate',
            model: modelChoice.selectedModel,
            effort: nextBacklog.effort,
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
            modelChoice.family,
            nextBacklog.attemptCount + 1,
            nextBacklog.maxAttempts
          );
        }
      }
    } catch (backlogErr) {
      this.log.error('Error evaluating backlog tasks: %s', backlogErr);
    }

    // 2. Evaluate Routine Tasks (Tier 3)
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

  // Re-arms only on a productive run: a failed or aborted task must not keep burning the cycle.
  private routineMayTriggerAgain(rt: RoutineTaskRecord, resetTime: string): boolean {
    if (!rt.lastTriggeredResetTime || rt.lastTriggeredResetTime !== resetTime) {
      return true;
    }

    const previous =
      (rt.lastTaskId ? this.queue.getTask(rt.lastTaskId) : undefined) ??
      this.queue.getLatestTaskForOrigin(rt.id);
    // A stamped cycle whose run can no longer be found stays burned: looping blind burns quota.
    if (!previous) return false;

    return (ROUTINE_CYCLE_REARM_STATUSES as readonly string[]).includes(previous.status);
  }

  // Evaluates enabled routine tasks against live quota pools and triggers any due for pre-reset burn.
  public async triggerEligibleRoutines(snapshots: QuotaSnapshot[]): Promise<SwarmTask[]> {
    const resolved = this.configStore.resolveConfig();
    if (!resolved.coordinatorEnabled || resolved.routinesEnabled === false) {
      return [];
    }

    const routines = this.queue.listRoutineTasks().filter((t) => t.enabled);
    if (routines.length === 0 || snapshots.length === 0) {
      return [];
    }

    const spawned: SwarmTask[] = [];

    for (const rt of routines) {
      // One in-flight run per routine: the evaluator must never stack runs on itself.
      if (this.queue.hasActiveTaskForOrigin(rt.id)) {
        continue;
      }

      let selectedModel: string | undefined;
      let targetPool: QuotaSnapshot | undefined;
      // The routine's own window wins; the global burn window is only a fallback.
      const triggerHours =
        rt.triggerBeforeResetHours && rt.triggerBeforeResetHours > 0
          ? rt.triggerBeforeResetHours
          : (resolved.quotaBurnMaxHours ?? DEFAULT_QUOTA_BURN_MAX_HOURS);

      for (const m of rt.models) {
        const concreteModel = resolveConcreteModelId(m, resolved.defaultDispatchModel);
        const family = resolvePoolFamilyForModel(concreteModel);

        // Check per-pool dispatchEnabled policy
        const policy = resolved.poolPolicies?.[family];
        if (policy && !policy.dispatchEnabled) {
          continue;
        }

        const pool = snapshots.find(
          (p) =>
            p.family === family ||
            p.poolId === family ||
            resolvePoolFamilyForModel(p.poolId || p.displayName) === family
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
        if (!this.routineMayTriggerAgain(rt, resetTime)) {
          continue;
        }

        if (hoursUntilReset > triggerHours) {
          continue;
        }

        // Check headroom: must have quota remaining to burn
        const headroom = calculateEffectiveHeadroomPercent(pool);
        const minHeadroom = Math.max(
          rt.minHeadroomPercent ?? 10,
          resolved.minDispatchHeadroomPercent ?? 0
        );

        if (headroom === null || headroom < minHeadroom) {
          continue;
        }

        selectedModel = concreteModel;
        targetPool = pool;
        break;
      }

      if (!selectedModel || !targetPool) {
        continue;
      }

      this.log.info(
        'Auto-triggering routine task #%d ("%s") for pool %s with model %s (reset in %sh, headroom=%d%%)',
        rt.taskNumber,
        rt.title,
        targetPool.family,
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
        model: selectedModel,
        effort: rt.effort,
        autoCreatePr: rt.autoCreatePr,
        actor: rt.actor || 'bot',
        prPolicy: rt.prPolicy ?? resolved.prPolicy,
        verifyCommand: rt.verifyCommand,
        scheduleMode: 'immediate',
        requestedBy: `routine:${rt.id}`,
      });

      this.queue.updateRoutineTask(rt.id, {
        lastTriggeredResetTime: targetPool.resetTime,
        lastTaskId: task.id,
      });

      // After the enqueue: a slow notification channel must never delay the burn it announces.
      await this.announceBurnKick({
        label: `Routine #${rt.taskNumber} "${rt.title}"`,
        pool: targetPool,
        models: [selectedModel],
        headroomPercent: calculateEffectiveHeadroomPercent(targetPool),
        triggerHours,
      });

      spawned.push(task);
    }

    return spawned;
  }

  // Compatibility bridge for test suites transitioning from standing tasks
  public async triggerEligibleStandingTasks(snapshots: QuotaSnapshot[]): Promise<SwarmTask[]> {
    return this.triggerEligibleRoutines(snapshots);
  }

  public evaluateEligibility(params: {
    model?: string;
    scheduleMode?: ScheduleMode;
    allowOverage?: boolean;
  }): ModelEligibilityResult {
    const resolved = this.configStore.resolveConfig();
    const concreteModel = resolveConcreteModelId(params.model, resolved.defaultDispatchModel);

    // Check per-pool dispatchEnabled policy
    const poolFamily = resolvePoolFamilyForModel(concreteModel);
    const policy = resolved.poolPolicies?.[poolFamily];
    if (policy && !policy.dispatchEnabled && !params.allowOverage) {
      return {
        allowed: false,
        resolvedModel: concreteModel,
        family: poolFamily,
        effectiveHeadroomPercent: 0,
        hoursUntilReset: null,
        code: 'OVERAGE_PROTECTION_TRIGGERED',
        reason: `Dispatch Disabled: Pool policy for ${poolFamily} disables task dispatching.`,
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
    });
  }

  // Main entrypoint for Web UI, REST API, and Discord task dispatches.
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

    // 1. Evaluate model & safety floor before coordinator gate so overage blocks are caught consistently
    const candidates: Array<string | undefined> =
      req.models && req.models.length > 0 ? req.models : [req.model];
    let eligibility = this.evaluateEligibility({
      model: candidates[0],
      scheduleMode,
      allowOverage,
    });
    // Walk the chain only on block codes a different pool could actually clear.
    for (let i = 1; i < candidates.length; i++) {
      if (eligibility.allowed) break;
      if (
        eligibility.code !== 'OVERAGE_PROTECTION_TRIGGERED' &&
        eligibility.code !== 'TELEMETRY_UNAVAILABLE'
      ) {
        break;
      }
      const next = this.evaluateEligibility({
        model: candidates[i],
        scheduleMode,
        allowOverage,
      });
      if (next.allowed) eligibility = next;
    }

    if (!eligibility.allowed && eligibility.code === 'OVERAGE_PROTECTION_TRIGGERED') {
      // Both a safety-floor breach and a pool-policy disable carry this code, so log the reason.
      this.log.warn(
        'Task dispatch blocked for "%s" (model=%s, pool=%s): %s',
        repositoryName,
        eligibility.resolvedModel,
        eligibility.family,
        eligibility.reason
      );
      return {
        success: false,
        repo: repositoryName,
        model: eligibility.resolvedModel,
        poolFamily: eligibility.family ?? undefined,
        error: eligibility.reason,
        code: 'OVERAGE_PROTECTION_TRIGGERED',
        minDispatchHeadroomPercent: resolved.minDispatchHeadroomPercent,
        currentHeadroomPercent: eligibility.effectiveHeadroomPercent,
      };
    }

    // 2. Check if coordinator is enabled
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

    // Claiming re-checks eligibility, so an unverifiable task would queue and never run.
    if (!eligibility.allowed && eligibility.code === 'TELEMETRY_UNAVAILABLE') {
      this.log.warn(
        'Task dispatch blocked for "%s" (model=%s, pool=%s): %s',
        repositoryName,
        eligibility.resolvedModel,
        eligibility.family,
        eligibility.reason
      );
      return {
        success: false,
        repo: repositoryName,
        model: eligibility.resolvedModel,
        poolFamily: eligibility.family ?? undefined,
        error: eligibility.reason,
        code: 'TELEMETRY_UNAVAILABLE',
        minDispatchHeadroomPercent: resolved.minDispatchHeadroomPercent,
        currentHeadroomPercent: eligibility.effectiveHeadroomPercent,
      };
    }

    // 3. Resolve repository configuration
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

    const concreteModel = eligibility.resolvedModel;
    const effort: ReasoningEffort = resolveReasoningEffortForModel(
      concreteModel,
      req.effort ?? resolved.defaultDispatchEffort
    );
    const requiredLabels = req.requiredLabels ?? [];

    const tier: TaskTier = req.tier ?? 'immediate';
    const originId = req.originId ?? req.standingTaskId;
    const originNumber = req.originNumber;
    const originTitle = req.originTitle;
    const title = req.title;

    if (tier === 'immediate' && req.actor !== 'bot') {
      this.setLastManualDispatchAt(Date.now());
    }

    // 4. Enqueue task in SQLite swarm_tasks queue
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
      actor: req.actor ?? 'user',
      prPolicy: req.prPolicy ?? resolved.prPolicy,
      scheduleMode,
      requiredLabels,
      model: concreteModel,
      effort,
      allowOverage,
      pushBranch: req.pushBranch ?? true,
      autoCreatePr: req.autoCreatePr ?? true,
      expiresAt: req.expiresAt,
      standingTaskId: req.standingTaskId,
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

    await this.notifier?.notifyDispatchStatus({
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

    // Wake any long-polling runners
    this.bus.emit('task:available');

    // 5. If pre-reset conditions are not yet met, return QUOTA_BURN_QUEUED status code
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
      poolFamily: task.poolFamily,
      scheduleMode,
      requiredLabels: task.requiredLabels,
    };
  }

  public async dispatchContinuation(params: {
    taskId?: string;
    branchName?: string;
    prompt: string;
    requestedBy?: string;
    requestedByUserId?: string;
    effort?: ReasoningEffort;
    repositoryName?: string;
    repositoryId?: string;
    model?: string;
    scheduleMode?: ScheduleMode;
  }): Promise<DispatchTaskResponse> {
    const parentTask = params.taskId ? this.queue.getTask(params.taskId) : null;
    return this.dispatch({
      repositoryId:
        parentTask?.repositoryId || params.repositoryId || params.repositoryName || 'default',
      repositoryName: parentTask?.repositoryName || params.repositoryName || 'unknown',
      repositoryPath: parentTask?.repositoryPath,
      cloneUrl: parentTask?.cloneUrl,
      prompt: params.prompt,
      requestedBy: params.requestedBy || parentTask?.requestedBy,
      requestedByUserId: params.requestedByUserId,
      actor: parentTask?.actor ?? 'user',
      prPolicy: parentTask?.prPolicy,
      effort: params.effort || parentTask?.effort,
      model: params.model || parentTask?.model,
      scheduleMode: params.scheduleMode || parentTask?.scheduleMode,
    });
  }

  // Generates a short-lived one-time runner registration token (`agyr_reg_...`).
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

  // Exchanges a one-time registration token for a persistent runner identity and `agyr_run_...` token.
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

  // Authenticates an incoming runner request via its persistent `agyr_run_...` token
  public authenticateRunner(providedToken?: string): {
    authenticated: boolean;
    runner?: SwarmRunnerRecord;
    viaSharedSecret?: boolean;
    isSharedSecret?: boolean;
  } {
    const resolved = this.configStore.resolveConfig();
    const res = this.queue.authenticateRunner(providedToken, resolved.runnerSharedSecret);
    return {
      ...res,
      isSharedSecret: res.viaSharedSecret,
    };
  }

  // Long-poll claim handler for outbound runners (`POST /api/tasks/poll`).
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
          const elig = this.evaluateEligibility({
            model: candidate.model,
            scheduleMode: candidate.scheduleMode,
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
      void this.announceOpportunisticBurnKick(immediate);
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
          void this.announceOpportunisticBurnKick(claimed);
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

  // Backlog rows only change state here, so no terminal task path can leave one stranded.
  private applyBacklogOutcome(originId: string, status: TaskStatus, error?: string): void {
    try {
      const backlogTask = this.queue.getBacklogTask(originId);
      if (
        !backlogTask ||
        backlogTask.status === 'completed' ||
        backlogTask.status === 'failed' ||
        backlogTask.status === 'canceled'
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

  // A task can end without a runner report (reaped lease, expiry, cancel), so rows are swept.
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

  // A cancel is a status transition like any other: it notifies, emits and settles the origin.
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

    // A refused update (terminal task or cross-runner patch) must not notify or emit
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

    // Terminal prose adds nothing: the title and fields already carry status, branch and model.
    const defaultMsg =
      updated.status === 'completed'
        ? ''
        : updated.status === 'no_changes'
          ? `Task ${updated.id} finished with no file changes (${updated.model})`
          : updated.status === 'failed'
            ? `Task ${updated.id} failed: ${updated.error || 'Unknown error'}`
            : `Executing task ${updated.id} on ${updated.repositoryName} (${updated.model})`;

    await this.notifier?.notifyDispatchStatus({
      taskId: updated.id,
      status: statusStep,
      repositoryName: updated.repositoryName,
      repositoryPath: updated.repositoryPath,
      prompt: updated.prompt,
      branchName: updated.branchName,
      model: updated.model,
      effort: updated.effort,
      output: updated.output,
      error: updated.error,
      durationMs: updated.durationMs,
      createdAt: updated.createdAt,
      requestedBy: updated.requestedBy,
      message: patch.message ?? defaultMsg,
    });

    this.bus.emit(`task:updated:${taskId}`, updated);

    // Update Backlog task status on terminal swarm outcomes
    if (updated.tier === 'backlog' && updated.originId) {
      this.applyBacklogOutcome(updated.originId, updated.status, updated.error);
    }

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
