import type {
  Notifier,
  NotifierOptions,
  QuotaAlert,
  DispatchStatusUpdate,
  DeliveryOutcome,
  InfoNotice,
} from '../types.js';
import type { ResolvedConfig } from '../../config/schema.js';
import { BUILTIN_DEFAULTS } from '../../config/schema.js';
import { normalizeStep } from '../embeds/formatters.js';
import { FAMILY_DISPLAY_NAMES } from '../../sentry/models.js';

const BOX_MIN_WIDTH = 70;

const printAsciiBox = (lines: string[]): void => {
  const width = Math.max(BOX_MIN_WIDTH, ...lines.map((line) => line.length + 2));
  const border = '─'.repeat(width);
  console.log(`┌${border}┐`);
  for (const line of lines) {
    console.log(`│${` ${line}`.padEnd(width)}│`);
  }
  console.log(`└${border}┘`);
};

export class ConsoleNotifier implements Notifier {
  readonly channelName: string = 'console';
  public initialized = false;
  protected config: ResolvedConfig;
  protected options: NotifierOptions;

  constructor(config: Partial<ResolvedConfig> = {}, options: NotifierOptions = {}) {
    this.config = { ...BUILTIN_DEFAULTS, ...config };
    this.options = options;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async notifyQuotaAlert(alert: QuotaAlert): Promise<DeliveryOutcome> {
    const poolName = alert.pool.displayName || alert.pool.poolId;
    printAsciiBox([
      `[QUOTA ALERT] ${poolName}`,
      `Headroom: ${alert.remainingPercentage}% remaining | Milestone: ${alert.milestoneHours}h before reset`,
      `Reset Deadline: ${alert.pool.resetTime} | Triggered: ${alert.triggeredAt}`,
    ]);
    return { delivered: true, results: { [this.channelName]: { success: true } } };
  }

  async notifyDispatchStatus(status: DispatchStatusUpdate): Promise<void> {
    const step = normalizeStep(status);
    printAsciiBox([
      `[DISPATCH STATUS] Step: ${step.toUpperCase()}`,
      `Repo: ${status.repositoryName ?? 'N/A'} | Branch: ${status.branchName ?? 'N/A'}`,
      `Message: ${status.message ?? ''}`,
    ]);
  }

  async notifyInfo(notice: InfoNotice): Promise<DeliveryOutcome | void> {
    printAsciiBox([`[NOTICE] ${notice.title}`, notice.message]);
    return { delivered: true, results: { [this.channelName]: { success: true } } };
  }

  async testNotification(): Promise<{ success: boolean; message: string; channel: string }> {
    const resetTime = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    printAsciiBox([
      `[TEST QUOTA ALERT] ${FAMILY_DISPLAY_NAMES.claude}`,
      'Headroom: 25% remaining | Milestone: 3h before reset',
      `Reset Deadline: ${resetTime} | Triggered: ${new Date().toISOString()}`,
    ]);

    return {
      success: true,
      message: 'Test notification printed to local console.',
      channel: this.channelName,
    };
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  async updateConfig(newConfig: Partial<ResolvedConfig>): Promise<void> {
    this.config = { ...this.config, ...newConfig };
  }
}
