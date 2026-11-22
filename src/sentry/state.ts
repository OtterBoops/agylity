import { readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { AppDatabase } from '../storage/db.js';
import { upgradePoolGroupId } from '../shared/models.js';
import type { BurnSample } from './models.js';
import type { DeliveryChannelResult } from '../notify/types.js';
import {
  SentryStore,
  SAMPLE_HISTORY_LIMIT,
  ensureSentryStateSchema,
  headroomPercentOf,
  normalizeMilestoneKey,
  type AlertEventPage,
  type ListAlertEventsOptions,
  type RecordAlertEventInput,
} from './store.js';

export { SAMPLE_HISTORY_LIMIT, normalizeMilestoneKey, headroomPercentOf };
export type { AlertEventPage, ListAlertEventsOptions, RecordAlertEventInput };

const SAMPLE_MIN_INTERVAL_MS = 10 * 60_000;
const SAMPLE_MIN_DELTA = 0.01;

export const PoolSampleSchema = z.object({
  at: z.string(),
  remainingFraction: z.number().min(0).max(1),
  resetTime: z.string(),
});

export const PoolStateSchema = z.object({
  resetTime: z.string(),
  remainingFraction: z.number().min(0).max(1),
  firedMilestones: z.array(z.string()),
  lastAlertSentAt: z.string().nullable().optional(),
  samples: z.array(PoolSampleSchema).optional(),
});

export type PoolState = z.infer<typeof PoolStateSchema>;

export const EarlyResetPoolSchema = z.object({
  poolId: z.string(),
  displayName: z.string().optional(),
  previousRemainingFraction: z.number().min(0).max(1),
  remainingFraction: z.number().min(0).max(1),
  previousResetTime: z.string(),
  resetTime: z.string(),
});

export type EarlyResetPool = z.infer<typeof EarlyResetPoolSchema>;

export const EarlyResetNoticeSchema = z.object({
  detectedAt: z.string(),
  pools: z.array(EarlyResetPoolSchema),
});

export type EarlyResetNotice = z.infer<typeof EarlyResetNoticeSchema>;

export interface PoolQuotaUpdate {
  cycleRolled: boolean;
  earlyReset: EarlyResetPool | null;
}

const EARLY_RESET_UNUSED_FRACTION = 0.99;
const EARLY_RESET_MIN_GAIN = 0.05;
const EARLY_RESET_GUARD_MS = 5 * 60_000;

const detectEarlyReset = (
  poolId: string,
  existing: PoolState,
  remainingFraction: number,
  resetTime: string,
  nowMs: number
): EarlyResetPool | null => {
  if (existing.remainingFraction >= EARLY_RESET_UNUSED_FRACTION) return null;
  const priorResetMs = Date.parse(existing.resetTime);
  if (!Number.isFinite(priorResetMs)) return null;
  if (nowMs >= priorResetMs - EARLY_RESET_GUARD_MS) return null;
  if (remainingFraction - existing.remainingFraction < EARLY_RESET_MIN_GAIN) return null;

  return {
    poolId,
    previousRemainingFraction: existing.remainingFraction,
    remainingFraction,
    previousResetTime: existing.resetTime,
    resetTime,
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

export const PROBE_SOURCES = [
  'connect_rpc',
  'cli',
  'cli_fallback',
  'unreachable',
  'auth_required',
] as const;

export type ProbeSource = (typeof PROBE_SOURCES)[number];

export const SentryStateSchema = z.object({
  version: z.literal(1),
  lastProbeAt: z.string(),
  lastProbeSource: z.enum(PROBE_SOURCES),
  authRequired: z.boolean().optional(),
  authErrorMessage: z.string().optional(),
  pools: z.record(z.string(), PoolStateSchema),
  earlyResetNotice: EarlyResetNoticeSchema.nullable().optional(),
});

export type SentryState = z.infer<typeof SentryStateSchema>;

export const createInitialState = (): SentryState => ({
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

export interface SentryStateManagerOptions {
  db: AppDatabase | DatabaseSync;
  legacyStatePath?: string;
}

export type SentryStateManagerSource = SentryStateManagerOptions | string;

const isAppDatabase = (value: unknown): value is AppDatabase =>
  typeof (value as AppDatabase)?.getRawDb === 'function';

const deriveDatabasePath = (statePath: string): string =>
  statePath.toLowerCase().endsWith('.json') ? `${statePath.slice(0, -5)}.db` : `${statePath}.db`;

export class SentryStateManager {
  private readonly store: SentryStore;
  private readonly ownsDatabase?: AppDatabase;
  private readonly legacyStatePath?: string;
  private state: SentryState;

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

  getState(): SentryState {
    return JSON.parse(JSON.stringify(this.state));
  }

  setState(newState: SentryState): void {
    this.state = JSON.parse(JSON.stringify(newState));
    this.store.replaceAll(
      {
        lastProbeAt: this.state.lastProbeAt,
        lastProbeSource: this.state.lastProbeSource,
        authRequired: this.state.authRequired,
        authErrorMessage: this.state.authErrorMessage,
      },
      this.state.pools,
      this.state.earlyResetNotice ?? null
    );
  }

  private hydrate(): SentryState {
    if (this.store.isEmpty() && this.legacyStatePath) {
      const imported = this.importLegacyState();
      if (imported) {
        this.store.replaceAll(
          {
            lastProbeAt: imported.lastProbeAt,
            lastProbeSource: imported.lastProbeSource,
            authRequired: imported.authRequired,
            authErrorMessage: imported.authErrorMessage,
          },
          imported.pools,
          imported.earlyResetNotice ?? null
        );
        return imported;
      }
    }

    const initial = createInitialState();
    const probe = this.store.readProbe();
    const state: SentryState = {
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

  private importLegacyState(): SentryState | null {
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

  async load(): Promise<SentryState> {
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
    const existing = this.state.pools[poolId];
    if (!existing) {
      this.state.pools[poolId] = {
        resetTime,
        remainingFraction,
        firedMilestones: [],
        lastAlertSentAt: null,
        samples: appendSample(undefined, remainingFraction, resetTime, nowMs),
      };
      this.store.writePool(poolId, this.state.pools[poolId]);
      return { cycleRolled: true, earlyReset: null };
    }

    const nextResetMs = Date.parse(resetTime);
    const priorResetMs = Date.parse(existing.resetTime);
    const effectiveResetTime = Number.isFinite(nextResetMs) ? resetTime : existing.resetTime;
    const detected = detectEarlyReset(
      poolId,
      existing,
      remainingFraction,
      effectiveResetTime,
      nowMs
    );
    // Upstream can refill, drain and refill again inside one cycle; the ledger key
    // (pool, cycle, kind) is the invariant, so a repeat refill is not a second early reset.
    const earlyReset =
      detected && this.hasEarlyResetAlert(poolId, detected.previousResetTime) ? null : detected;

    if (
      Number.isFinite(nextResetMs) &&
      Number.isFinite(priorResetMs) &&
      nextResetMs !== priorResetMs
    ) {
      existing.resetTime = resetTime;
      existing.remainingFraction = remainingFraction;
      existing.firedMilestones = [];
      existing.lastAlertSentAt = null;
      existing.samples = appendSample(undefined, remainingFraction, resetTime, nowMs);
      this.store.writePool(poolId, existing);
      return { cycleRolled: true, earlyReset };
    }

    if (Number.isFinite(nextResetMs)) {
      existing.resetTime = resetTime;
    }

    if (earlyReset) {
      existing.remainingFraction = remainingFraction;
      existing.samples = appendSample(undefined, remainingFraction, effectiveResetTime, nowMs);
      this.store.writePool(poolId, existing);
      return { cycleRolled: false, earlyReset };
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

    const removed = Object.keys(this.state.pools).filter((poolId) => !active.has(poolId));
    for (const poolId of removed) {
      delete this.state.pools[poolId];
      this.store.deletePool(poolId);
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

  getPoolState(poolId: string): PoolState | undefined {
    return this.state.pools[poolId];
  }

  private ensurePool(poolId: string, resetTime?: string): PoolState {
    const existing = this.state.pools[poolId];
    if (existing) return existing;
    const pool: PoolState = {
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
