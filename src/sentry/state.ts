import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BurnSample } from './models.js';

// Persistent State Schema

/** Newest sample last; the cap bounds both the state file and the projection window. */
const SAMPLE_HISTORY_LIMIT = 24;
const SAMPLE_MIN_INTERVAL_MS = 10 * 60_000;
/** Drain below this fraction is probe jitter, not usage. */
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
  /** Absent in files written before burn-rate sampling existed. */
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

/** Per-pool outcome of a quota observation, so callers can react without diffing state twice. */
export interface PoolQuotaUpdate {
  /** The reset deadline advanced: a new cycle with cleared milestones. */
  cycleRolled: boolean;
  /** Set only when this observation was a premature reset. */
  earlyReset: EarlyResetPool | null;
}

// A pool nobody drew from floats its resetTime forward every poll, so only a pool with prior
// usage can have reset early.
const EARLY_RESET_UNUSED_FRACTION = 0.99;
const EARLY_RESET_MIN_GAIN = 0.05;
/** Inside this window the cycle is ending anyway, so a refill is expected rather than early. */
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

/** A sample is only recorded when it carries information the last one did not. */
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

/** Probe sources, so the schema and its callers cannot disagree. */
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
  /** Only the newest premature reset survives; a probe never retires it. */
  earlyResetNotice: EarlyResetNoticeSchema.nullable().optional(),
});

export type SentryState = z.infer<typeof SentryStateSchema>;

export const normalizeMilestoneKey = (milestone: number | string): string => {
  const s = String(milestone).trim().toLowerCase();
  return s.endsWith('h') ? s : `${s}h`;
};

export const createInitialState = (): SentryState => ({
  version: 1,
  lastProbeAt: new Date().toISOString(),
  lastProbeSource: 'unreachable',
  pools: {},
});

// Sentry State Manager Class

export class SentryStateManager {
  private readonly stateFilePath: string;
  private state: SentryState;

  constructor(stateFilePath: string = 'data/state.json') {
    this.stateFilePath = path.resolve(stateFilePath);
    this.state = createInitialState();
  }

  getState(): SentryState {
    return JSON.parse(JSON.stringify(this.state));
  }

  setState(newState: SentryState): void {
    this.state = JSON.parse(JSON.stringify(newState));
  }

  // Loads state from disk; a corrupt file is quarantined rather than trusted.
  async load(): Promise<SentryState> {
    try {
      const raw = await fs.readFile(this.stateFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const validated = SentryStateSchema.parse(parsed);
      this.state = validated;
      return this.getState();
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error && error.code === 'ENOENT') {
        this.state = createInitialState();
        return this.getState();
      }

      // File exists but parsing/validation failed: quarantine it
      const quarantinePath = `${this.stateFilePath}.corrupt.${Date.now()}`;
      try {
        await fs.rename(this.stateFilePath, quarantinePath);
      } catch {
        // Quarantine rename best-effort
      }

      this.state = createInitialState();
      return this.getState();
    }
  }

  // Atomically saves state to disk using a unique temporary file and fs.rename.
  async save(): Promise<void> {
    const dir = path.dirname(this.stateFilePath);
    await fs.mkdir(dir, { recursive: true });

    const nonce = Math.random().toString(36).slice(2);
    const tempFile = `${this.stateFilePath}.tmp.${process.pid}.${Date.now()}.${nonce}`;
    const serialized = JSON.stringify(this.state, null, 2);

    await fs.writeFile(tempFile, serialized, 'utf-8');

    // On Windows, target file locking may briefly trigger EPERM / EBUSY
    let renamed = false;
    let attempts = 0;
    while (!renamed && attempts < 5) {
      try {
        await fs.rename(tempFile, this.stateFilePath);
        renamed = true;
      } catch (err: unknown) {
        attempts++;
        if (attempts >= 5) {
          try {
            await fs.unlink(tempFile);
          } catch {
            // ignore cleanup error
          }
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
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
      return { cycleRolled: true, earlyReset: null };
    }

    const nextResetMs = Date.parse(resetTime);
    const priorResetMs = Date.parse(existing.resetTime);
    // An unreadable deadline is not adopted, so a notice must record the deadline still in force.
    const effectiveResetTime = Number.isFinite(nextResetMs) ? resetTime : existing.resetTime;
    const earlyReset = detectEarlyReset(
      poolId,
      existing,
      remainingFraction,
      effectiveResetTime,
      nowMs
    );

    // A new cycle needs two readable deadlines that differ in instant. A re-rendered deadline, or a
    // probe that lost the deadline, must not clear the dedupe or every fired milestone re-sends.
    if (
      Number.isFinite(nextResetMs) &&
      Number.isFinite(priorResetMs) &&
      nextResetMs !== priorResetMs
    ) {
      // Upstream reset time changed: cycle rollover
      existing.resetTime = resetTime;
      existing.remainingFraction = remainingFraction;
      existing.firedMilestones = [];
      existing.lastAlertSentAt = null;
      existing.samples = appendSample(undefined, remainingFraction, resetTime, nowMs);
      return { cycleRolled: true, earlyReset };
    }

    // Adopt a readable deadline; keep the known one when this probe could not parse its own.
    if (Number.isFinite(nextResetMs)) {
      existing.resetTime = resetTime;
    }

    if (earlyReset) {
      // A premature refill restarted the balance, so earlier samples describe a dead cycle.
      existing.remainingFraction = remainingFraction;
      existing.samples = appendSample(undefined, remainingFraction, effectiveResetTime, nowMs);
      return { cycleRolled: false, earlyReset };
    }

    existing.remainingFraction = remainingFraction;
    existing.samples = appendSample(existing.samples, remainingFraction, effectiveResetTime, nowMs);
    return { cycleRolled: false, earlyReset };
  }

  /** Overwrites any previous notice: only the latest premature reset is actionable. */
  recordEarlyResetNotice(
    pools: EarlyResetPool[],
    detectedAt: string = new Date().toISOString()
  ): EarlyResetNotice {
    const notice: EarlyResetNotice = { detectedAt, pools };
    this.state.earlyResetNotice = notice;
    return JSON.parse(JSON.stringify(notice));
  }

  getEarlyResetNotice(): EarlyResetNotice | null {
    return this.state.earlyResetNotice ?? null;
  }

  /** Cleared only by an explicit dismissal; the next premature reset replaces it. */
  dismissEarlyResetNotice(): boolean {
    if (!this.state.earlyResetNotice) return false;
    this.state.earlyResetNotice = null;
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
    let pool = this.state.pools[poolId];
    if (!pool) {
      pool = {
        resetTime: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        remainingFraction: 1,
        firedMilestones: [],
        lastAlertSentAt: null,
      };
      this.state.pools[poolId] = pool;
    }

    const key = normalizeMilestoneKey(milestone);
    if (!pool.firedMilestones.includes(key)) {
      pool.firedMilestones.push(key);
    }
    pool.lastAlertSentAt = alertTime;
  }

  recordSupersededMilestones(poolId: string, milestones: (number | string)[]): void {
    const pool = this.state.pools[poolId];
    if (!pool) return;
    for (const m of milestones) {
      const key = normalizeMilestoneKey(m);
      if (!pool.firedMilestones.includes(key)) {
        pool.firedMilestones.push(key);
      }
    }
  }

  getPoolState(poolId: string): PoolState | undefined {
    return this.state.pools[poolId];
  }
}
