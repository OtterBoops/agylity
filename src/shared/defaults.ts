import type { BacklogConcurrency } from './contracts.js';

/** Config defaults that more than one layer needs: storage renders one into DDL, the rest gate work. */
export const DEFAULT_MILESTONE_HOURS: number[] = [48, 24, 12];
export const DEFAULT_QUOTA_BURN_MAX_HOURS = 4;
export const DEFAULT_BACKLOG_MIN_HEADROOM_PERCENT = 40;
export const DEFAULT_BACKLOG_CONCURRENCY: BacklogConcurrency = 'per_repo';
