import type { Notifier, NotifierOptions, QuotaAlert, DispatchStatusUpdate } from '../types.js';
import type { ResolvedConfig } from '../../config/schema.js';
import { BUILTIN_DEFAULTS } from '../../config/schema.js';

export class ConsoleNotifier implements Notifier {
  readonly channelName: string = 'console';
  public initialized = false;
  public alerts: QuotaAlert[] = [];
  public statuses: DispatchStatusUpdate[] = [];
  protected config: ResolvedConfig;
  protected options: NotifierOptions;

  constructor(config: Partial<ResolvedConfig> = {}, options: NotifierOptions = {}) {
    this.config = { ...BUILTIN_DEFAULTS, ...config };
    this.options = options;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async init(): Promise<void> {
    return this.initialize();
  }

  async notifyQuotaAlert(alert: QuotaAlert): Promise<void> {
    this.alerts.push(alert);

    // Format rich ASCII box for console output
    const poolName = alert.pool.displayName || alert.pool.poolId;
    const remainingPct = `${alert.remainingPercentage}%`;
    const milestoneText = `${alert.milestoneHours}h before reset`;
    const resetTime = alert.pool.resetTime;

    const line1 = `│ [QUOTA ALERT] ${poolName}`.padEnd(72) + '│';
    const line2 =
      `│ Headroom: ${remainingPct} remaining | Milestone: ${milestoneText}`.padEnd(72) + '│';
    const line3 =
      `│ Reset Deadline: ${resetTime} | Triggered: ${alert.triggeredAt}`.padEnd(72) + '│';

    console.log('┌' + '─'.repeat(71) + '┐');
    console.log(line1);
    console.log(line2);
    console.log(line3);
    console.log('└' + '─'.repeat(71) + '┘');
  }

  async notifyDispatchStatus(status: DispatchStatusUpdate): Promise<void> {
    this.statuses.push(status);

    const step = status.status ?? (status.step as string) ?? 'executing';
    const repo = status.repositoryName ?? 'N/A';
    const branch = status.branchName ?? 'N/A';
    const msg = status.message ?? '';

    const line1 = `│ [DISPATCH STATUS] Step: ${step.toUpperCase()}`.padEnd(72) + '│';
    const line2 = `│ Repo: ${repo} | Branch: ${branch}`.padEnd(72) + '│';
    const line3 = `│ Message: ${msg}`.padEnd(72) + '│';

    console.log('┌' + '─'.repeat(71) + '┐');
    console.log(line1);
    console.log(line2);
    console.log(line3);
    console.log('└' + '─'.repeat(71) + '┘');
  }

  async testNotification(): Promise<{ success: boolean; message: string; channel: string }> {
    const poolName = 'Claude and GPT models';
    const remainingPct = '25%';
    const milestoneText = '3h before reset';
    const resetTime = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    const triggeredAt = new Date().toISOString();

    const line1 = `│ [TEST QUOTA ALERT] ${poolName}`.padEnd(72) + '│';
    const line2 =
      `│ Headroom: ${remainingPct} remaining | Milestone: ${milestoneText}`.padEnd(72) + '│';
    const line3 = `│ Reset Deadline: ${resetTime} | Triggered: ${triggeredAt}`.padEnd(72) + '│';

    console.log('┌' + '─'.repeat(71) + '┐');
    console.log(line1);
    console.log(line2);
    console.log(line3);
    console.log('└' + '─'.repeat(71) + '┘');

    return {
      success: true,
      message: 'Test notification printed to local console.',
      channel: this.channelName,
    };
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }
}
