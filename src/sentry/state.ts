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

export const SentryStateSchema = z.object({
  version: z.literal(1),
  lastProbeAt: z.string(),
  lastProbeSource: z.enum(['connect_rpc', 'cli_fallback', 'unreachable']),
  pools: z.record(PoolStateSchema),
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

  /**
   * Returns current in-memory state.
   */
  getState(): SentryState {
    return JSON.parse(JSON.stringify(this.state));
  }

  /**
   * Sets in-memory state directly (useful for tests).
   */
  setState(newState: SentryState): void {
    this.state = JSON.parse(JSON.stringify(newState));
  }

  /**
   * Safely loads state from disk.
   * If the file does not exist, initializes a fresh state.
   * If the file is corrupt, renames it to quarantine and initializes a fresh state.
   */
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

  /**
   * Atomically saves state to disk using a unique temporary file and fs.rename.
   */
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

  /**
   * Updates last probe metadata.
   */
  updateProbe(
    source: 'connect_rpc' | 'cli_fallback' | 'unreachable',
    at: string = new Date().toISOString()
  ): void {
    this.state.lastProbeAt = at;
    this.state.lastProbeSource = source;
  }

  /**
   * Updates pool quota info.
   * Detects cycle rollover when resetTime advances or changes.
   * Returns true if a rollover occurred.
   */
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

  /**
   * Returns whether a milestone has already been fired for the specified pool.
   */
  isMilestoneFired(poolId: string, milestone: number | string): boolean {
    const pool = this.state.pools[poolId];
    if (!pool) return false;
    const key = normalizeMilestoneKey(milestone);
    const rawKey = String(milestone);
    return pool.firedMilestones.includes(key) || pool.firedMilestones.includes(rawKey);
  }

  /**
   * Records that a milestone has fired for a pool.
   */
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

  /**
   * Records superseded milestones that should not fire later.
   */
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

  /**
   * Records a full QuotaAlert and persists state atomically.
   */
  async recordAlert(alert: QuotaAlert): Promise<void> {
    this.recordMilestoneFired(alert.pool.poolId, alert.milestoneHours, alert.triggeredAt);
    await this.save();
  }

  /**
   * Retrieves the current state of a specific pool.
   */
  getPoolState(poolId: string): PoolState | undefined {
    return this.state.pools[poolId];
  }
}
