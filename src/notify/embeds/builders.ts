import type { StandardEmbed } from './types.js';
import { renderSquareProgressBar, formatResetWindow, formatModelPills } from './formatters.js';
import type { QuotaAlert, DispatchStatusUpdate } from '../types.js';
import type { QuotaSnapshot } from '../../sentry/models.js';

export function buildQuotaAlertEmbed(alert: QuotaAlert): StandardEmbed {
  const poolName = (alert.pool.displayName || alert.pool.poolId || 'Quota Pool').slice(0, 256);
  const hours = alert.milestoneHours;
  const fraction = alert.pool.remainingFraction ?? alert.remainingPercentage / 100;
  const resetTimestamp = formatResetWindow(alert.pool.resetTime);

  const embed: StandardEmbed = {
    title: `[Alert] Quota Milestone: ${poolName}`,
    description: `Milestone threshold: **${hours}h** before quota reset.`,
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
    ],
    footer: { text: 'Agylity Quota Sentry' },
    timestamp: alert.triggeredAt || new Date().toISOString(),
  };

  if (alert.pool.models && alert.pool.models.length > 0) {
    embed.fields!.push({
      name: 'Monitored Models',
      value: formatModelPills(alert.pool.models).slice(0, 1024),
      inline: false,
    });
  }

  return embed;
}

export function buildTestAlertEmbed(samplePool?: Partial<QuotaSnapshot>): StandardEmbed {
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
    description: 'Milestone threshold: **3h** before quota reset.',
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
}

export function buildDispatchStatusEmbed(status: DispatchStatusUpdate): StandardEmbed {
  const step = status.status ?? (status.step as string) ?? 'executing';
  const color = step === 'completed' ? 0x2ecc71 : step === 'failed' ? 0xe74c3c : 0x3498db;

  return {
    title: `[Dispatch] Task Status: ${step}`,
    description: status.message || `Dispatch step: ${step}`,
    color,
    timestamp: status.timestamp || new Date().toISOString(),
    footer: { text: 'Agylity Orchestrator' },
  };
}

export function buildQuotaStatusEmbed(pools: QuotaSnapshot[]): StandardEmbed {
  const embed: StandardEmbed = {
    title: 'Antigravity Model Quota Status',
    color: 0x5865f2,
  };

  if (pools.length === 0) {
    embed.description = 'No active quota pools currently monitored.';
    return embed;
  }

  embed.fields = [];

  for (const pool of pools) {
    const hoursText =
      pool.hoursUntilReset !== undefined && pool.hoursUntilReset > 0
        ? `${pool.hoursUntilReset.toFixed(1)}h`
        : '0h';
    const fieldName = (pool.displayName || pool.poolId || 'Quota Pool').slice(0, 256);
    const safeFraction = Number.isFinite(pool.remainingFraction) ? pool.remainingFraction : 0;
    const percent = Math.round(Math.max(0, Math.min(1, safeFraction)) * 100);
    let fieldValue = `${renderSquareProgressBar(pool.remainingFraction)} **${percent}%**\nReset in: ${hoursText}`;

    if (pool.weekly && pool.shortTerm) {
      const weeklyPct = Math.round(pool.weekly.remainingFraction * 100);
      const stPct = Math.round(pool.shortTerm.remainingFraction * 100);
      const wHours = pool.weekly.hoursUntilReset.toFixed(1);
      const stHours = pool.shortTerm.hoursUntilReset.toFixed(1);
      fieldValue =
        `**Weekly (Eval Target):** ${renderSquareProgressBar(pool.weekly.remainingFraction)} **${weeklyPct}%** (${wHours}h)\n` +
        `**5-Hour Throttle:** ${renderSquareProgressBar(pool.shortTerm.remainingFraction)} **${stPct}%** (${stHours}h)`;
    }

    embed.fields.push({
      name: fieldName,
      value: fieldValue.slice(0, 1024),
    });
  }

  return embed;
}
