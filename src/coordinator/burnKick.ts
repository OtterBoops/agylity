import type { Logger } from '../logs/logger.js';
import type { QuotaSnapshot } from '../sentry/models.js';
import {
  calculateEffectiveHeadroomPercent,
  findPoolForGroup,
  resolvePoolGroupForModel,
} from './models.js';
import { DEFAULT_QUOTA_BURN_MAX_HOURS } from '../shared/defaults.js';
import type { InfoNotice } from '../notify/types.js';
import type { ResolvedConfig } from '../config/types.js';
import type { SwarmTask } from '../shared/contracts.js';

const CYCLES_KEY = 'burnKickAnnouncedCycles';

export interface BurnKickDeps {
  runtime: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
  };
  log: Logger;
  notifier(): { notifyInfo(notice: InfoNotice): Promise<unknown> | unknown } | undefined;
  resolveConfig(): ResolvedConfig;
  getActivePools(): QuotaSnapshot[];
}

export interface BurnKickAnnouncement {
  label: string;
  pool: QuotaSnapshot;
  models: string[];
  headroomPercent: number | null;
  triggerHours: number;
}

/** Records which pool cycle was announced, so a restart does not re-announce the same window. */
export const createBurnKickTracker = (deps: BurnKickDeps) => {
  const readCycles = (): Record<string, string> => {
    const raw = deps.runtime.get(CYCLES_KEY);
    if (!raw) return {};
    try {
      return (JSON.parse(raw) as Record<string, string>) ?? {};
    } catch {
      return {};
    }
  };

  const writeCycles = (cycles: Record<string, string>): void => {
    deps.runtime.set(CYCLES_KEY, JSON.stringify(cycles));
  };

  const announce = async (params: BurnKickAnnouncement): Promise<void> => {
    const { poolGroup } = params.pool;
    const { resetTime } = params.pool;
    if (!resetTime) return;
    const cycles = readCycles();
    if (cycles[poolGroup] === resetTime) return;
    cycles[poolGroup] = resetTime;
    writeCycles(cycles);

    deps.log.info(
      'Pre-reset window open on %s (<=%dh, %d%% headroom); quota-burn looping until %s',
      params.pool.displayName || poolGroup,
      params.triggerHours,
      params.headroomPercent ?? 0,
      resetTime
    );

    await deps.notifier()?.notifyInfo({
      kind: 'burn_kick',
      title: 'Pre-reset burn started',
      message:
        `${params.label} entered the pre-reset window (<=${params.triggerHours}h) with ` +
        `${params.headroomPercent ?? 0}% headroom. Quota-burn looping is now active for this pool ` +
        `until the reset at ${resetTime}.`,
      poolGroup,
      poolName: params.pool.displayName || params.pool.poolId,
      models: params.models,
      resetTime,
      hoursUntilReset: params.pool.hoursUntilReset,
    });
  };

  /** A pre-reset task that a runner claimed by itself opens the window without a scheduled check. */
  const announceOpportunistic = async (task: SwarmTask): Promise<void> => {
    if (task.scheduleMode !== 'pre_reset') return;
    const pool = findPoolForGroup(deps.getActivePools(), resolvePoolGroupForModel(task.model));
    if (!pool) return;

    const resolved = deps.resolveConfig();
    await announce({
      label: `Pre-reset task #${task.taskNumber} "${task.title}"`,
      pool,
      models: [task.model],
      headroomPercent: calculateEffectiveHeadroomPercent(pool),
      triggerHours: resolved.quotaBurnMaxHours ?? DEFAULT_QUOTA_BURN_MAX_HOURS,
    });
  };

  const fire = (task: SwarmTask): void => {
    void announceOpportunistic(task).catch((kickErr) => {
      deps.log.warn('Burn-kick announcement failed for %s: %s', task.id, kickErr);
    });
  };

  return { announce, announceOpportunistic, fire, readCycles, writeCycles };
};
