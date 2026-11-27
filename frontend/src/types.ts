import type * as preact from 'preact';

import type { PoolGroup, ReasoningEffort } from '../../src/shared/models.ts';

// One declaration per wire payload lives in src/shared/contracts.ts; the dashboard re-exports them
// so a field change reaches both sides at once instead of drifting between two copies.
export type {
  AlertEvent,
  AlertEventPage,
  BacklogStatus,
  BacklogTaskRecord,
  BurnSample,
  CascadeHop,
  DeliveryChannelResult,
  EarlyResetNotice,
  EarlyResetPool,
  LogEntry,
  LogLevel,
  NotificationDestination,
  NotificationDestinationType,
  ProbeSource,
  PrPolicy,
  QuotaBucket,
  QuotaBurnProjection,
  QuotaSnapshot,
  RoutineEligibilityState,
  RoutineEligibilityStatus,
  RoutineTaskRecord,
  RunnerRegistrationTokenResult,
  RunnerSystemInfo,
  RunnersResponse,
  ScheduleMode,
  SentryAlertState,
  SentryPoolState,
  SwarmRunnerRecord,
  SwarmTask,
  TaskStatus,
  TaskTier,
} from '../../src/shared/contracts.ts';

export type { PoolGroup, ReasoningEffort };

declare module 'preact' {
  namespace JSX {
    interface IntrinsicAttributes {
      path?: string;
      default?: boolean;
    }
  }
}

declare module 'preact-router/match' {
  export interface LinkProps extends preact.JSX.HTMLAttributes<HTMLAnchorElement> {
    href?: string;
    activeClassName?: string;
    children?: preact.ComponentChildren;
  }
  export function Link(props: LinkProps & { href?: string }): preact.VNode;
}

export interface ConfigData {
  resolved: Record<string, any>;
  overrides: Record<string, any>;
  secretsMeta?: Record<string, { isSet: boolean }>;
  /** Destination id -> secret field -> presence, since secrets arrive masked per instance. */
  destinationsMeta?: Record<string, Record<string, { isSet: boolean }>>;
  sources?: Record<string, 'override' | 'env' | 'default'>;
}

export interface ModelCatalogEntry {
  id: string;
  label: string;
  poolGroup: PoolGroup;
  defaultEffort: ReasoningEffort;
  supportedEfforts: ReasoningEffort[];
  effectiveHeadroomPercent: number | null;
  weeklyRemainingPercent: number | null;
  shortTermRemainingPercent: number | null;
  resetTime: string | null;
  hoursUntilReset: number | null;
  belowSafetyFloor: boolean;
}

export interface RepositoryConfig {
  id: string;
  name: string;
  path: string;
  cloneUrl?: string;
  defaultBranch?: string;
}

interface DispatchPoolView {
  poolId: string;
  displayName: string;
  weeklyPercent: number | null;
  shortTermPercent: number | null;
  effectivePercent: number;
  limitingWindow: 'weekly' | 'short_term';
  hoursUntilReset: number | null;
  resetTime: string | null;
}

export interface DispatchEligibility {
  evaluatedAt: string;
  accepts: boolean;
  willRunNow: boolean;
  code: string | null;
  reason: string | null;
  model: string;
  poolGroup: string | null;
  pool: DispatchPoolView | null;
  floorPercent: number;
  allowOverage: boolean;
  autonomy: { quenched: boolean; remainingMs: number };
  runners: { online: number };
  telemetry: {
    probeSource: string;
    lastProbeAt: string | null;
    authRequired: boolean;
    authErrorMessage: string | null;
  };
  warnings: string[];
}
