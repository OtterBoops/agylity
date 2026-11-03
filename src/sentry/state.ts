import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { QuotaAlert } from './models.js';

// Persistent State Schema

export const PoolStateSchema = z.object({
  resetTime: z.string(),
  remainingFraction: z.number(),
  firedMilestones: z.array(z.string()),
  lastAlertSentAt: z.string().nullable().optional(),
});

export type PoolState = z.infer<typeof PoolStateSchema>;

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

  updatePoolQuota(poolId: string, remainingFraction: number, resetTime: string): boolean {
    const existing = this.state.pools[poolId];
    if (!existing) {
      this.state.pools[poolId] = {
        resetTime,
        remainingFraction,
        firedMilestones: [],
        lastAlertSentAt: null,
      };
      return true;
    }

    if (existing.resetTime !== resetTime) {
      // Upstream reset time changed: cycle rollover
      existing.resetTime = resetTime;
      existing.remainingFraction = remainingFraction;
      existing.firedMilestones = [];
      existing.lastAlertSentAt = null;
      return true;
    }

    existing.remainingFraction = remainingFraction;
    return false;
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

  async recordAlert(alert: QuotaAlert): Promise<void> {
    this.recordMilestoneFired(alert.pool.poolId, alert.milestoneHours, alert.triggeredAt);
    await this.save();
  }

  getPoolState(poolId: string): PoolState | undefined {
    return this.state.pools[poolId];
  }
}
