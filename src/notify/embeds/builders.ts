import type { StandardEmbed, EmbedField } from './types.js';
import {
  formatModelPills,
  formatResetWindow,
  isTerminalStep,
  normalizeStep,
  renderSquareProgressBar,
} from './formatters.js';
import { AGYLITY_VERSION } from '../../version.js';
import type { QuotaAlert, DispatchStatusUpdate, InfoNotice } from '../types.js';
import {
  FAMILY_DEFAULT_MODELS,
  FAMILY_DISPLAY_NAMES,
  type QuotaSnapshot,
} from '../../sentry/models.js';

export interface EmbedBuildOptions {
  ownerUserId?: string;
  pingOwner?: boolean;
  baseUrl?: string;
}

// Builders append their own leading-slash route, so a trailing slash on the origin would double up.
const buildDashboardLink = (baseUrl: string | undefined, path: string): string | undefined => {
  const base = baseUrl?.trim().replace(/\/+$/, '');
  return base ? `${base}${path}` : undefined;
};

// One pool rendering shared by the status and alert embeds so the two cannot drift. The field
// NAME carries the pool and its headline figure, so each pool reads as a single scannable line.
const renderPoolFieldName = (pool: QuotaSnapshot, includePoolName = true): string => {
  const weekly = pool.weekly ?? pool;
  const label = includePoolName ? `${pool.displayName || pool.poolId || 'Quota Pool'} ` : '';
  return `${label}${renderSquareProgressBar(weekly.remainingFraction)}`.slice(0, 256);
};

const renderPoolFieldValue = (pool: QuotaSnapshot): string => {
  const weekly = pool.weekly ?? pool;
  const lines = [`-# weekly · resets ${formatResetWindow(weekly.resetTime)}`];
  if (pool.models && pool.models.length > 0) {
    lines.push(formatModelPills(pool.models));
  }
  return lines.join('\n');
};

export const buildQuotaAlertEmbed = (
  alert: QuotaAlert,
  options?: EmbedBuildOptions
): StandardEmbed => {
  const poolName = (alert.pool.displayName || alert.pool.poolId || 'Quota Pool').slice(0, 256);
  const hours = alert.milestoneHours;
  const fraction = alert.pool.remainingFraction ?? alert.remainingPercentage / 100;
  const resetTimestamp = formatResetWindow(alert.pool.resetTime);
  const weekly = alert.pool.weekly ?? alert.pool;

  const valueLines = [`-# weekly · resets ${resetTimestamp}`];
  if (alert.pool.models && alert.pool.models.length > 0) {
    valueLines.push(formatModelPills(alert.pool.models));
  }

  return {
    title: `[Alert] ${poolName}`,
    description: `Crossed the **${hours}h** milestone before reset.`,
    color: 0xf6c177,
    fields: [
      {
        name: `${renderSquareProgressBar(weekly.remainingFraction ?? fraction)} remaining (weekly)`.slice(
          0,
          256
        ),
        value: valueLines.join('\n').slice(0, 1024),
        inline: false,
      },
    ],
    url: buildDashboardLink(options?.baseUrl, '/overview'),
    footer: { text: `Agylity v${AGYLITY_VERSION}` },
    timestamp: alert.triggeredAt || new Date().toISOString(),
  };
};

export const buildInfoNoticeEmbed = (
  notice: InfoNotice,
  options?: EmbedBuildOptions
): StandardEmbed => {
  const fields: EmbedField[] = [];

  if (notice.poolName) {
    fields.push({
      name: 'Pool',
      value: notice.poolName.slice(0, 100),
      inline: true,
    });
  }

  if (notice.models && notice.models.length > 0) {
    fields.push({
      name: 'Models',
      value: formatModelPills(notice.models).slice(0, 1024),
      inline: true,
    });
  }

  if (notice.resetTime) {
    fields.push({
      name: 'Reset',
      value: formatResetWindow(notice.resetTime),
      inline: true,
    });
  }

  return {
    title: `[Notice] ${notice.title}`.slice(0, 256),
    description: notice.message.slice(0, 4096),
    color: 0x9ccfd8,
    fields: fields.length > 0 ? fields : undefined,
    url: buildDashboardLink(options?.baseUrl, '/tasks'),
    footer: { text: `Agylity v${AGYLITY_VERSION}` },
    timestamp: notice.timestamp || new Date().toISOString(),
  };
};

export const buildTestAlertEmbed = (
  samplePool?: Partial<QuotaSnapshot>,
  options?: EmbedBuildOptions
): StandardEmbed => {
  const poolName = (samplePool?.displayName || FAMILY_DISPLAY_NAMES.claude).slice(0, 256);
  const modelsList =
    samplePool?.models && samplePool.models.length > 0
      ? samplePool.models
      : FAMILY_DEFAULT_MODELS.claude;

  const resetIso = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
  const resetTimestamp = formatResetWindow(resetIso);
  const fraction = samplePool?.remainingFraction ?? 0.25;

  return {
    title: `[Alert] Quota Milestone: ${poolName}`,
    description: `Milestone threshold: **3h** before quota reset.`,
    color: 0xffa500,
    fields: [
      {
        name: 'Remaining Quota',
        value: renderSquareProgressBar(fraction),
        inline: true,
      },
      {
        name: 'Reset Window',
        value: resetTimestamp,
        inline: true,
      },
      {
        name: 'Monitored Models',
        value: formatModelPills(modelsList).slice(0, 1024),
        inline: false,
      },
    ],
    url: buildDashboardLink(options?.baseUrl, '/overview'),
    footer: { text: 'Agylity Quota Sentry • Test Notification Simulation' },
    timestamp: new Date().toISOString(),
  };
};

interface StepVisualConfig {
  title: string;
  color: number;
}

const STEP_VISUALS: Record<string, StepVisualConfig> = {
  completed: { title: '[Task: Completed]', color: 0x31748f }, // Pine
  no_changes: { title: '[Task: No Changes]', color: 0x908caa }, // Muted
  failed: { title: '[Task: Failed]', color: 0xeb6f92 }, // Love
  aborted: { title: '[Task: Aborted]', color: 0xf6c177 }, // Gold
  polling: { title: '[Task: Queued]', color: 0x908caa }, // Muted
  waking: { title: '[Task: Queued]', color: 0x908caa }, // Muted
  executing: { title: '[Task: In Progress]', color: 0x9ccfd8 }, // Foam
};

const DEFAULT_STEP_VISUAL: StepVisualConfig = {
  title: '[Task: In Progress]',
  color: 0x9ccfd8,
};

export const formatDurationHuman = (durationMs?: number): string => {
  if (typeof durationMs !== 'number' || durationMs <= 0) return '0s';
  const sec = durationMs / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const mins = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
};

export const buildDispatchStatusEmbed = (
  status: DispatchStatusUpdate,
  options?: EmbedBuildOptions
): StandardEmbed => {
  const step = normalizeStep(status);
  const visual = STEP_VISUALS[step] ?? DEFAULT_STEP_VISUAL;
  const isTerminal = isTerminalStep(step);

  let title = visual.title;
  if (isTerminal && typeof status.durationMs === 'number' && status.durationMs > 0) {
    title = `${visual.title} • Took ${formatDurationHuman(status.durationMs)}`;
  }
  const color = visual.color;

  const fields: EmbedField[] = [];

  if (status.createdAt) {
    const startEpoch = Math.floor(new Date(status.createdAt).getTime() / 1000);
    const endEpoch = Math.floor(new Date(status.timestamp || Date.now()).getTime() / 1000);
    if (!Number.isNaN(startEpoch) && !Number.isNaN(endEpoch) && isTerminal) {
      fields.push({
        name: 'Timeline',
        value: `<t:${startEpoch}:T> → <t:${endEpoch}:T>`,
        inline: true,
      });
    }
  }

  if (status.repositoryName) {
    fields.push({
      name: 'Repository',
      value: status.repositoryName.slice(0, 100),
      inline: true,
    });
  }

  if (status.model) {
    fields.push({
      name: 'Model',
      value: `${status.model}${status.effort ? ` · ${status.effort}` : ''}`.slice(0, 100),
      inline: true,
    });
  }

  if (status.branchName) {
    fields.push({
      name: 'Branch',
      value: `\`${status.branchName.slice(0, 100)}\``,
      inline: true,
    });
  }

  if (status.runnerName) {
    fields.push({
      name: 'Runner',
      value: status.runnerName.slice(0, 100),
      inline: true,
    });
  }

  if (status.taskId) {
    fields.push({
      name: 'Task ID',
      value: `\`${status.taskId.slice(0, 100)}\``,
      inline: true,
    });
  }

  let description = '';
  if (status.prompt) {
    const cleanPrompt = status.prompt.trim();
    description += `**Prompt:** *${cleanPrompt.slice(0, 300)}${cleanPrompt.length > 300 ? '…' : ''}*\n\n`;
  }

  if (step === 'failed' && status.error) {
    const cleanError = status.error.trim().slice(0, 800);
    description += `**Error Details:**\n\`\`\`bash\n${cleanError}\n\`\`\``;
  } else if (status.message) {
    description += status.message.slice(0, 500);
  }

  return {
    title,
    description: description.trim() || undefined,
    color,
    fields: fields.length > 0 ? fields : undefined,
    url: status.taskId
      ? buildDashboardLink(
          options?.baseUrl,
          `/tasks?tab=executions&id=${encodeURIComponent(status.taskId)}`
        )
      : undefined,
    timestamp: status.timestamp || new Date().toISOString(),
    footer: { text: `Agylity v${AGYLITY_VERSION}` },
  };
};

export const buildQuotaStatusEmbed = (
  pools: QuotaSnapshot[],
  options?: EmbedBuildOptions
): StandardEmbed => {
  const embed: StandardEmbed = {
    title: '[Quota] Antigravity Model Pools',
    color: 0x31748f,
    url: buildDashboardLink(options?.baseUrl, '/overview'),
  };

  if (pools.length === 0) {
    embed.description = 'No active quota pools currently monitored.';
    return embed;
  }

  embed.description = `-# ${pools.length} pool${pools.length === 1 ? '' : 's'} monitored · figures are remaining allowance`;
  embed.fields = pools.map((pool) => ({
    name: renderPoolFieldName(pool),
    value: renderPoolFieldValue(pool).slice(0, 1024),
  }));
  embed.footer = { text: `Agylity v${AGYLITY_VERSION}` };
  embed.timestamp = new Date().toISOString();

  return embed;
};
