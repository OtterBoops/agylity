import { readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { AppDatabase } from '../storage/db.js';
import { upgradePoolGroupId } from '../shared/models.js';
import { normalizeResetTime, resetTimeMs } from '../shared/resetTime.js';
import type { DeliveryChannelResult } from '../notify/types.js';
import {
  PROBE_SOURCES,
  type BurnSample,
  type EarlyResetNotice,
  type EarlyResetPool,
  type ProbeSource,
  type SentryAlertState,
  type SentryPoolState,
} from '../shared/contracts.js';

// The state file's payload types are declared once in the shared wire contracts; the schemas below
// validate the stored shape and the frontend reads the same declaration.
export type {
  BurnSample,
  EarlyResetNotice,
  EarlyResetPool,
  ProbeSource,
  SentryAlertState,
  SentryPoolState,
};

/** The stored pool shape is the wire pool shape, under the name the state file has always used. */
type PoolState = SentryPoolState;
import {
  SentryStore,
  SAMPLE_HISTORY_LIMIT,
  ensureSentryStateSchema,
  normalizeMilestoneKey,
  type AlertEventPage,
  type ListAlertEventsOptions,
  type RecordAlertEventInput,
} from './store.js';

export { normalizeMilestoneKey };
export type { AlertEventPage, ListAlertEventsOptions, RecordAlertEventInput };

const SAMPLE_MIN_INTERVAL_MS = 10 * 60_000;
const SAMPLE_MIN_DELTA = 0.01;

const PoolSampleSchema = z.object({
  at: z.string(),
  remainingFraction: z.number().min(0).max(1),
  resetTime: z.string(),
}) satisfies z.ZodType<BurnSample>;

const PoolStateSchema = z.object({
  resetTime: z.string(),
  remainingFraction: z.number().min(0).max(1),
  firedMilestones: z.array(z.string()),
  lastAlertSentAt: z.string().nullable().optional(),
  samples: z.array(PoolSampleSchema).optional(),
}) satisfies z.ZodType<PoolState>;

const EarlyResetPoolSchema = z.object({
  poolId: z.string(),
  displayName: z.string().optional(),
  previousRemainingFraction: z.number().min(0).max(1),
  remainingFraction: z.number().min(0).max(1),
  previousResetTime: z.string(),
  resetTime: z.string(),
}) satisfies z.ZodType<EarlyResetPool>;

const EarlyResetNoticeSchema = z.object({
  detectedAt: z.string(),
  pools: z.array(EarlyResetPoolSchema),
}) satisfies z.ZodType<EarlyResetNotice>;

interface PoolQuotaUpdate {
  cycleRolled: boolean;
  earlyReset: EarlyResetPool | null;
}

const EARLY_RESET_UNUSED_FRACTION = 0.99;
const EARLY_RESET_MIN_GAIN = 0.05;
const EARLY_RESET_GUARD_MS = 5 * 60_000;

const detectEarlyReset = (
  poolId: string,
  existing: SentryPoolState,
  remainingFraction: number,
  resetTime: string,
  nowMs: number
): EarlyResetPool | null => {
  if (existing.remainingFraction >= EARLY_RESET_UNUSED_FRACTION) return null;
  const priorResetMs = resetTimeMs(existing.resetTime);
  if (priorResetMs === null) return null;
  if (nowMs >= priorResetMs - EARLY_RESET_GUARD_MS) return null;
  if (remainingFraction - existing.remainingFraction < EARLY_RESET_MIN_GAIN) return null;

  return {
    poolId,
    previousRemainingFraction: existing.remainingFraction,
    remainingFraction,
    previousResetTime: normalizeResetTime(existing.resetTime),
    resetTime: normalizeResetTime(resetTime),
  };
};

const appendSample = (
  samples: BurnSample[] | undefined,
  remainingFraction: number,
  resetTime: string,
  nowMs: number
): BurnSample[] => {
  const history = samples ?? [];
  const last = history[history.length - 1];
  const sample: BurnSample = {
    at: new Date(nowMs).toISOString(),
    remainingFraction,
    resetTime,
  };
  const due =
    !last ||
    nowMs - Date.parse(last.at) >= SAMPLE_MIN_INTERVAL_MS ||
    Math.abs(remainingFraction - last.remainingFraction) >= SAMPLE_MIN_DELTA;
  if (!due) return history;
  return [...history, sample].slice(-SAMPLE_HISTORY_LIMIT);
};

// `PROBE_SOURCES` is the contract tuple, so a source the wire type does not allow cannot be stored.
const SentryStateSchema = z.object({
  version: z.literal(1),
  lastProbeAt: z.string(),
  lastProbeSource: z.enum(PROBE_SOURCES),
  authRequired: z.boolean().optional(),
  authErrorMessage: z.string().optional(),
  pools: z.record(z.string(), PoolStateSchema),
  earlyResetNotice: EarlyResetNoticeSchema.nullable().optional(),
}) satisfies z.ZodType<SentryAlertState>;

export const createInitialState = (): SentryAlertState => ({
  version: 1,
  lastProbeAt: new Date().toISOString(),
  lastProbeSource: 'unreachable',
  pools: {},
});

type ResetKeyed = { resetTime?: unknown };

// Pools are keyed by pool id, so an id written before the pool group rename must move onto its group
// id the moment it enters the manager; two ids collapsing onto one keep the newer quota cycle.
const upgradeLegacyPoolMap = <T extends ResetKeyed>(
  pools: Record<string, T>
): Record<string, T> => {
  const upgraded: Record<string, T> = {};
  for (const [poolId, pool] of Object.entries(pools)) {
    const key = upgradePoolGroupId(poolId);
    const existing = upgraded[key];
    if (existing === undefined || String(pool.resetTime ?? '') > String(existing.resetTime ?? '')) {
      upgraded[key] = pool;
    }
  }
  return upgraded;
};

const upgradeLegacyState = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const state = raw as Record<string, unknown>;

  const pools = state.pools;
  if (pools && typeof pools === 'object' && !Array.isArray(pools)) {
    state.pools = upgradeLegacyPoolMap(pools as Record<string, ResetKeyed>);
  }

  const notice = state.earlyResetNotice as { pools?: unknown } | null | undefined;
  if (notice && typeof notice === 'object' && Array.isArray(notice.pools)) {
    notice.pools = notice.pools.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const pool = entry as Record<string, unknown>;
      return typeof pool.poolId === 'string'
        ? { ...pool, poolId: upgradePoolGroupId(pool.poolId) }
        : entry;
    });
  }

  return state;
};

interface SentryStateManagerOptions {
  db: AppDatabase | DatabaseSync;
  legacyStatePath?: string;
}

type SentryStateManagerSource = SentryStateManagerOptions | string;

const isAppDatabase = (value: unknown): value is AppDatabase =>
  typeof (value as AppDatabase)?.getRawDb === 'function';

const deriveDatabasePath = (statePath: string): string =>
  statePath.toLowerCase().endsWith('.json') ? `${statePath.slice(0, -5)}.db` : `${statePath}.db`;

const POOL_RETIREMENT_MISSES = 3;

export class SentryStateManager {
  private readonly store: SentryStore;
  private readonly ownsDatabase?: AppDatabase;
  private readonly legacyStatePath?: string;
  private state: SentryAlertState;
  private readonly missingProbeCounts = new Map<string, number>();

  constructor(source: SentryStateManagerSource = 'data/state.json') {
    if (typeof source === 'string') {
      const databasePath = deriveDatabasePath(path.resolve(source));
      this.ownsDatabase = new AppDatabase(databasePath);
      this.store = new SentryStore(this.ownsDatabase.getRawDb());
      this.legacyStatePath = path.resolve(source);
    } else {
      let raw: DatabaseSync;
      if (isAppDatabase(source.db)) {
        raw = source.db.getRawDb();
      } else {
        // AppDatabase opens at the schema head; a bare handle still needs the sentry DDL.
        ensureSentryStateSchema(source.db);
        raw = source.db;
      }
      this.store = new SentryStore(raw);
      this.legacyStatePath = source.legacyStatePath
        ? path.resolve(source.legacyStatePath)
        : undefined;
    }
    this.state = this.hydrate();
  }

  public close(): void {
    this.ownsDatabase?.close();
  }

  getState(): SentryAlertState {
    return JSON.parse(JSON.stringify(this.state));
  }

  setState(newState: SentryAlertState): void {
    this.state = JSON.parse(JSON.stringify(newState));
    this.replaceStore(this.state);
  }

  /** The stored shape is the in-memory one: one projection, so a write cannot drop a probe field. */
  private replaceStore(state: SentryAlertState): void {
    this.store.replaceAll(
      {
        lastProbeAt: state.lastProbeAt,
        lastProbeSource: state.lastProbeSource,
        authRequired: state.authRequired,
        authErrorMessage: state.authErrorMessage,
      },
      state.pools,
      state.earlyResetNotice ?? null
    );
  }

  private hydrate(): SentryAlertState {
    if (this.store.isEmpty() && this.legacyStatePath) {
      const imported = this.importLegacyState();
      if (imported) {
        this.replaceStore(imported);
        return imported;
      }
    }

    const initial = createInitialState();
    const probe = this.store.readProbe();
    const state: SentryAlertState = {
      version: 1,
      lastProbeAt: probe.lastProbeAt ?? initial.lastProbeAt,
      lastProbeSource: probe.lastProbeSource
        ? (probe.lastProbeSource as ProbeSource)
        : 'unreachable',
      pools: upgradeLegacyPoolMap(this.store.readPools()),
    };
    if (probe.authRequired !== undefined) state.authRequired = probe.authRequired;
    if (probe.authErrorMessage !== undefined) state.authErrorMessage = probe.authErrorMessage;
    const notice = this.store.readEarlyResetNotice();
    if (notice) state.earlyResetNotice = notice;
    return state;
  }

  private importLegacyState(): SentryAlertState | null {
    const legacyPath = this.legacyStatePath;
    if (!legacyPath) return null;

    let raw: string;
    try {
      raw = readFileSync(legacyPath, 'utf-8');
    } catch {
      return null;
    }

    try {
      return SentryStateSchema.parse(upgradeLegacyState(JSON.parse(raw)));
    } catch (err: unknown) {
      const contentInvalid = err instanceof SyntaxError || err instanceof z.ZodError;
      if (!contentInvalid) return null;
      try {
        renameSync(legacyPath, `${legacyPath}.corrupt.${Date.now()}`);
      } catch {}
      return null;
    }
  }

  async load(): Promise<SentryAlertState> {
    return this.getState();
  }

  async save(): Promise<void> {
    // A flush step here would only hide a write that failed earlier.
  }

  updateProbe(
    source: ProbeSource,
    at: string = new Date().toISOString(),
    authInfo?: { authRequired?: boolean; authErrorMessage?: string }
  ): void {
    this.state.lastProbeAt = at;
    this.state.lastProbeSource = source;
    if (authInfo) {
      this.state.authRequired = authInfo.authRequired;
      this.state.authErrorMessage = authInfo.authErrorMessage;
    } else if (source === 'auth_required') {
      this.state.authRequired = true;
    } else if (source === 'connect_rpc' || source === 'cli' || source === 'cli_fallback') {
      this.state.authRequired = false;
      this.state.authErrorMessage = undefined;
    }
    this.store.writeProbe({
      lastProbeAt: this.state.lastProbeAt,
      lastProbeSource: this.state.lastProbeSource,
      authRequired: this.state.authRequired,
      authErrorMessage: this.state.authErrorMessage,
    });
  }

  updatePoolQuota(
    poolId: string,
    remainingFraction: number,
    resetTime: string,
    nowMs: number = Date.now()
  ): PoolQuotaUpdate {
    // Upstream reports an idle pool at the epoch, which carries no deadline.
    const nextResetTime = normalizeResetTime(resetTime);
    const existing = this.state.pools[poolId];
    if (!existing) {
      this.state.pools[poolId] = {
        resetTime: nextResetTime,
        remainingFraction,
        firedMilestones: [],
        lastAlertSentAt: null,
        samples: appendSample(undefined, remainingFraction, nextResetTime, nowMs),
      };
      this.store.writePool(poolId, this.state.pools[poolId]);
      return { cycleRolled: true, earlyReset: null };
    }

    const priorResetTime = normalizeResetTime(existing.resetTime);
    existing.resetTime = priorResetTime;
    // The cycle identity is the instant, not its spelling: two renderings of one deadline are one cycle.
    const nextResetMs = resetTimeMs(nextResetTime);
    const priorResetMs = resetTimeMs(priorResetTime);
    const effectiveResetTime = nextResetTime || priorResetTime;
    const detected = detectEarlyReset(poolId, existing, remainingFraction, nextResetTime, nowMs);
    // Upstream can refill, drain and refill again inside one cycle; the ledger key
    // (pool, cycle, kind) is the invariant, so a repeat refill is not a second early reset.
    const earlyReset =
      detected && this.hasEarlyResetAlert(poolId, detected.previousResetTime) ? null : detected;

    if (
      nextResetMs !== null &&
      priorResetMs !== null &&
      nextResetMs !== priorResetMs &&
      (nextResetMs < priorResetMs || nowMs >= priorResetMs)
    ) {
      existing.resetTime = nextResetTime;
      existing.remainingFraction = remainingFraction;
      existing.firedMilestones = [];
      existing.lastAlertSentAt = null;
      existing.samples = appendSample(undefined, remainingFraction, nextResetTime, nowMs);
      this.store.writePool(poolId, existing);
      return { cycleRolled: true, earlyReset };
    }

    if (nextResetMs !== null) {
      if (existing.samples && nextResetTime !== priorResetTime) {
        existing.samples = existing.samples.map((sample) => ({
          ...sample,
          resetTime: nextResetTime,
        }));
      }
      existing.resetTime = nextResetTime;
    }

    const advancedDeadline =
      nextResetMs !== null && priorResetMs !== null && nextResetMs > priorResetMs;

    if (earlyReset) {
      // A refill with no new clock or a later deadline starts a cycle whose milestones are all unfired.
      if (!nextResetTime) {
        existing.resetTime = '';
      }
      if (!nextResetTime || advancedDeadline) {
        existing.firedMilestones = [];
        existing.lastAlertSentAt = null;
      }
      existing.remainingFraction = remainingFraction;
      existing.samples = appendSample(undefined, remainingFraction, existing.resetTime, nowMs);
      this.store.writePool(poolId, existing);
      return { cycleRolled: false, earlyReset };
    }

    if (detected && advancedDeadline) {
      existing.firedMilestones = [];
      existing.lastAlertSentAt = null;
    }

    existing.remainingFraction = remainingFraction;
    existing.samples = appendSample(existing.samples, remainingFraction, effectiveResetTime, nowMs);
    this.store.writePool(poolId, existing);
    return { cycleRolled: false, earlyReset };
  }

  /** A pool the probe stopped reporting must not keep steering dispatch or the summary; an
   *  empty probe proves nothing, so losing every pool is never read as losing all of them. */
  reconcilePools(activePoolIds: Iterable<string>): string[] {
    const active = new Set<string>();
    for (const poolId of activePoolIds) active.add(upgradePoolGroupId(poolId));
    if (active.size === 0) return [];

    const removed: string[] = [];
    for (const poolId of Object.keys(this.state.pools)) {
      if (active.has(poolId)) {
        this.missingProbeCounts.delete(poolId);
        continue;
      }
      // One short probe must not retire a pool: deleting it also wipes the milestone ledger,
      // and the next full probe would fire an already-delivered milestone all over again.
      const misses = (this.missingProbeCounts.get(poolId) ?? 0) + 1;
      if (misses < POOL_RETIREMENT_MISSES) {
        this.missingProbeCounts.set(poolId, misses);
        continue;
      }
      this.missingProbeCounts.delete(poolId);
      delete this.state.pools[poolId];
      this.store.deletePool(poolId);
      removed.push(poolId);
    }

    const notice = this.state.earlyResetNotice;
    if (removed.length > 0 && notice) {
      const retired = new Set(removed);
      const pools = notice.pools.filter((pool) => !retired.has(upgradePoolGroupId(pool.poolId)));
      if (pools.length !== notice.pools.length) {
        // A notice naming only retired pools has nothing left to show; clear it instead of
        // persisting an empty shell.
        this.state.earlyResetNotice = pools.length > 0 ? { ...notice, pools } : null;
        this.store.writeEarlyResetNotice(this.state.earlyResetNotice);
      }
    }

    return removed;
  }

  recordEarlyResetNotice(
    pools: EarlyResetPool[],
    detectedAt: string = new Date().toISOString()
  ): EarlyResetNotice {
    const notice: EarlyResetNotice = { detectedAt, pools };
    this.state.earlyResetNotice = notice;
    this.store.writeEarlyResetNotice(notice);
    return JSON.parse(JSON.stringify(notice));
  }

  getEarlyResetNotice(): EarlyResetNotice | null {
    return this.state.earlyResetNotice ?? null;
  }

  dismissEarlyResetNotice(): boolean {
    if (!this.state.earlyResetNotice) return false;
    this.state.earlyResetNotice = null;
    this.store.writeEarlyResetNotice(null);
    return true;
  }

  isMilestoneFired(poolId: string, milestone: number | string): boolean {
    const pool = this.state.pools[poolId];
    if (!pool) return false;
    const key = normalizeMilestoneKey(milestone);
    const rawKey = String(milestone);
    return pool.firedMilestones.includes(key) || pool.firedMilestones.includes(rawKey);
  }

  recordMilestoneFired(
    poolId: string,
    milestone: number | string,
    alertTime: string = new Date().toISOString()
  ): void {
    const pool = this.ensurePool(poolId);
    const key = normalizeMilestoneKey(milestone);
    if (!pool.firedMilestones.includes(key)) {
      pool.firedMilestones.push(key);
    }
    pool.lastAlertSentAt = alertTime;
    this.store.insertMilestone(poolId, pool.resetTime, key, alertTime);
    this.store.setLastAlertSentAt(poolId, alertTime);
  }

  recordSupersededMilestones(poolId: string, milestones: (number | string)[]): void {
    const pool = this.state.pools[poolId];
    if (!pool) return;
    for (const m of milestones) {
      const key = normalizeMilestoneKey(m);
      if (!pool.firedMilestones.includes(key)) {
        pool.firedMilestones.push(key);
        this.store.insertMilestone(poolId, pool.resetTime, key);
      }
    }
  }

  recordDeliveredAlert(input: {
    poolId: string;
    resetTime: string;
    milestoneHours: number;
    headroomPercent?: number | null;
    channels?: Record<string, DeliveryChannelResult>;
    firedAt?: string;
  }): void {
    const pool = this.ensurePool(input.poolId, input.resetTime);
    const firedAt = input.firedAt ?? new Date().toISOString();
    const key = normalizeMilestoneKey(input.milestoneHours);

    this.store.recordDeliveredAlert({
      poolId: input.poolId,
      resetTime: input.resetTime,
      kind: 'milestone',
      milestoneHours: input.milestoneHours,
      headroomPercent: input.headroomPercent ?? null,
      channels: input.channels ?? {},
      firedAt,
    });

    if (!pool.firedMilestones.includes(key)) pool.firedMilestones.push(key);
    pool.lastAlertSentAt = firedAt;
  }

  recordCycleAlert(input: {
    poolId: string;
    resetTime: string;
    kind: 'early_reset';
    headroomPercent?: number | null;
    channels?: Record<string, DeliveryChannelResult>;
    firedAt?: string;
  }): boolean {
    return this.store.recordAlertEvent({
      poolId: input.poolId,
      resetTime: input.resetTime,
      kind: input.kind,
      milestoneHours: null,
      headroomPercent: input.headroomPercent ?? null,
      channels: input.channels ?? {},
      firedAt: input.firedAt,
    });
  }

  hasEarlyResetAlert(poolId: string, resetTime: string): boolean {
    return this.store.hasCycleAlert(poolId, resetTime, 'early_reset');
  }

  listAlertEvents(options: ListAlertEventsOptions = {}): AlertEventPage {
    return this.store.listAlertEvents(options);
  }

  getPoolState(poolId: string): SentryPoolState | undefined {
    return this.state.pools[poolId];
  }

  private ensurePool(poolId: string, resetTime?: string): SentryPoolState {
    const existing = this.state.pools[poolId];
    if (existing) return existing;
    const pool: SentryPoolState = {
      resetTime: resetTime ?? new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      remainingFraction: 1,
      firedMilestones: [],
      lastAlertSentAt: null,
    };
    this.state.pools[poolId] = pool;
    this.store.ensurePoolRow(poolId, pool.resetTime, pool.remainingFraction);
    return pool;
  }
}
