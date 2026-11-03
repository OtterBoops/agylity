import type { StandardEmbed, EmbedField } from './types.js';
import { renderSquareProgressBar, formatResetWindow, formatModelPills } from './formatters.js';
import { AGYLITY_VERSION } from '../../version.js';
import type { QuotaAlert, DispatchStatusUpdate } from '../types.js';
import type { QuotaSnapshot } from '../../sentry/models.js';

export interface EmbedBuildOptions {
  ownerUserId?: string;
  pingOwner?: boolean;
}

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
  if (pool.shortTerm) {
    lines.push(
      `-# 5-hour ${renderSquareProgressBar(pool.shortTerm.remainingFraction)} · resets ${formatResetWindow(pool.shortTerm.resetTime)}`
    );
  }
  if (pool.models && pool.models.length > 0) {
    lines.push(formatModelPills(pool.models));
  }
  return lines.join('\n');
};

export const buildQuotaAlertEmbed = (
  alert: QuotaAlert,
  _options?: EmbedBuildOptions
): StandardEmbed => {
  const poolName = (alert.pool.displayName || alert.pool.poolId || 'Quota Pool').slice(0, 256);
  const hours = alert.milestoneHours;
  const fraction = alert.pool.remainingFraction ?? alert.remainingPercentage / 100;
  const resetTimestamp = formatResetWindow(alert.pool.resetTime);

  const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return {
    title: `[Alert] ${poolName} — ${percent}% remaining`,
    description: `Crossed the **${hours}h** milestone before reset (${resetTimestamp}).`,
    color: 0xf6c177,
    fields: [
      {
        name: renderPoolFieldName(alert.pool, false),
        value: renderPoolFieldValue(alert.pool).slice(0, 1024),
        inline: false,
      },
    ],
    footer: { text: `Agylity v${AGYLITY_VERSION}` },
    timestamp: alert.triggeredAt || new Date().toISOString(),
  };
};

export const buildTestAlertEmbed = (
  samplePool?: Partial<QuotaSnapshot>,
  _options?: EmbedBuildOptions
): StandardEmbed => {
  const poolName = (samplePool?.displayName || 'Claude & GPT Models').slice(0, 256);
  const modelsList =
    samplePool?.models && samplePool.models.length > 0
      ? samplePool.models
      : ['Claude Opus', 'Claude Sonnet', 'GPT-OSS'];

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

export const buildDispatchStatusEmbed = (status: DispatchStatusUpdate): StandardEmbed => {
  const step = String(status.status ?? (status.step as string) ?? 'executing').toLowerCase();
  const visual = STEP_VISUALS[step] ?? DEFAULT_STEP_VISUAL;
  const isTerminal = ['completed', 'no_changes', 'failed', 'aborted'].includes(step);

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
    timestamp: status.timestamp || new Date().toISOString(),
    footer: { text: `Agylity v${AGYLITY_VERSION}` },
  };
};

export const buildQuotaStatusEmbed = (pools: QuotaSnapshot[]): StandardEmbed => {
  const embed: StandardEmbed = {
    title: '[Quota] Antigravity Model Pools',
    color: 0x31748f,
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
