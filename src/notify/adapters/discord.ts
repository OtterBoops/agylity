import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Interaction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { z } from 'zod';
import type {
  Notifier,
  NotifierOptions,
  QuotaAlert,
  QuotaSnapshot,
  DispatchStatusUpdate,
  DispatchRequest,
  DispatchResult,
} from '../types.js';
import type { ResolvedConfig } from '../../config/schema.js';
import { BUILTIN_DEFAULTS } from '../../config/schema.js';
import { logger } from '../../logs/logger.js';

/**
 * Task prompt validation schema enforcing 1-4000 character boundaries.
 */
export const TaskPromptSchema = z
  .string()
  .trim()
  .min(1, 'Prompt is required')
  .max(4000, 'Prompt exceeds 4000 character limit');

/**
 * Generates an ASCII visual progress bar for quota fractions (e.g. "██████░░░░" or "■■■■■■□□□□").
 */
export const generateProgressBar = (
  fraction: number,
  totalBars = 10,
  filledChar = '█',
  emptyChar = '░'
): string => {
  const safeFraction = Number.isFinite(fraction) ? fraction : 0;
  const clamped = Math.max(0, Math.min(1, safeFraction));
  const safeTotalBars = Number.isFinite(totalBars) && totalBars > 0 ? Math.floor(totalBars) : 10;
  const filled = Math.round(clamped * safeTotalBars);
  const empty = Math.max(0, safeTotalBars - filled);
  return filledChar.repeat(filled) + emptyChar.repeat(empty);
};

export const renderSquareProgressBar = (fraction: number, totalBars = 10): string => {
  const safeTotalBars = Number.isFinite(totalBars) && totalBars > 0 ? Math.floor(totalBars) : 10;
  const bar = generateProgressBar(fraction, safeTotalBars, '■', '□');
  const percent = Math.round(
    Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100
  );
  return `\`[${bar}]\` **${percent}%**`;
};

export const formatProgressBar = (fraction: number, totalBars = 10): string => {
  const safeTotalBars = Number.isFinite(totalBars) && totalBars > 0 ? Math.floor(totalBars) : 10;
  const bar = generateProgressBar(fraction, safeTotalBars);
  const percent = Math.round(
    Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100
  );
  return `[${bar}] ${percent}%`;
};

export const renderProgressBar = (fraction: number, totalBars = 10): string => {
  const safeTotalBars = Number.isFinite(totalBars) && totalBars > 0 ? Math.floor(totalBars) : 10;
  const bar = generateProgressBar(fraction, safeTotalBars);
  const percent = Math.round(
    Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100
  );
  return `\`[${bar}]\` **${percent}%**`;
};

export const renderQuotaEmbed = (pools: QuotaSnapshot[]): EmbedBuilder => {
  const embed = new EmbedBuilder().setTitle('Antigravity Model Quota Status').setColor(0x5865f2);

  if (pools.length === 0) {
    embed.setDescription('No active quota pools currently monitored.');
    return embed;
  }

  for (const pool of pools) {
    const hoursText =
      pool.hoursUntilReset !== undefined && pool.hoursUntilReset > 0
        ? `${pool.hoursUntilReset.toFixed(1)}h`
        : '0h';
    const fieldName = (pool.displayName || pool.poolId || 'Quota Pool').slice(0, 256);
    const safeFraction = Number.isFinite(pool.remainingFraction) ? pool.remainingFraction : 0;
    const percent = Math.round(Math.max(0, Math.min(1, safeFraction)) * 100);
    let fieldValue = `${generateProgressBar(pool.remainingFraction)} **${percent}%**\nReset in: ${hoursText}`;

    if (pool.weekly && pool.shortTerm) {
      const weeklyPct = Math.round(pool.weekly.remainingFraction * 100);
      const stPct = Math.round(pool.shortTerm.remainingFraction * 100);
      const wHours = pool.weekly.hoursUntilReset.toFixed(1);
      const stHours = pool.shortTerm.hoursUntilReset.toFixed(1);
      fieldValue =
        `**Weekly (Eval Target):** ${generateProgressBar(pool.weekly.remainingFraction)} **${weeklyPct}%** (${wHours}h)\n` +
        `**5-Hour Throttle:** ${generateProgressBar(pool.shortTerm.remainingFraction)} **${stPct}%** (${stHours}h)`;
    }

    embed.addFields({
      name: fieldName,
      value: fieldValue.slice(0, 1024),
    });
  }

  return embed;
};

/**
 * Creates repository StringSelectMenu component.
 */
export const createRepoSelectMenu = (
  repositories: Array<{ id: string; name: string; path?: string; description?: string }>
): ActionRowBuilder<StringSelectMenuBuilder> => {
  const select = new StringSelectMenuBuilder().setCustomId('repo_select');
  const list = repositories ?? [];

  if (list.length === 0) {
    select
      .setDisabled(true)
      .setPlaceholder('No repositories configured')
      .addOptions([{ label: 'None', value: 'none' }]);
  } else {
    const displayRepos = list.slice(0, 25);
    select
      .setPlaceholder(
        list.length > 25
          ? `Select repository (showing 25 of ${list.length})...`
          : 'Select target repository to dispatch task...'
      )
      .addOptions(
        displayRepos.map((repo) => {
          const option: { label: string; value: string; description?: string } = {
            label: (repo.name || repo.id).slice(0, 100),
            value: repo.id.slice(0, 100),
          };
          const desc = (repo.description ?? repo.path ?? '').trim();
          if (desc.length > 0) {
            option.description = desc.slice(0, 100);
          }
          return option;
        })
      );
  }

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
};

/**
 * Creates modal dialog for task prompt.
 */
export const createDispatchModal = (repoId: string, repoName: string): ModalBuilder => {
  const title = `Dispatch Task: ${repoName}`.slice(0, 45);
  const safeCustomId = `modal_dispatch:${repoId}`.slice(0, 100);
  const modal = new ModalBuilder().setCustomId(safeCustomId).setTitle(title);

  const promptInput = new TextInputBuilder()
    .setCustomId('task_prompt')
    .setLabel('Task Prompt / Objectives')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Enter the exact task instructions for Antigravity continuation...')
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(4000);

  const row = new ActionRowBuilder<TextInputBuilder>().addComponents(promptInput);
  modal.addComponents(row);
  return modal;
};

export interface DiscordNotifierOptions extends NotifierOptions {
  client?: Client | any;
}

export class DiscordNotifier implements Notifier {
  readonly channelName: string = 'discord';
  public client: Client | null = null;
  public initialized = false;
  public activeInteractions = new Map<string, any>();
  private config: ResolvedConfig;
  private options: DiscordNotifierOptions;
  private activeSubmissions = new Set<string>();

  constructor(config: Partial<ResolvedConfig> = {}, options: DiscordNotifierOptions = {}) {
    this.config = { ...BUILTIN_DEFAULTS, ...config };
    this.options = options;

    if (options.client) {
      this.client = options.client;
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!this.client) {
      this.client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
      });
    }

    if (typeof this.client.on === 'function') {
      this.client.on('interactionCreate', async (interaction: any) => {
        try {
          await this.handleInteraction(interaction);
        } catch (err: any) {
          logger.child('notify:discord').error('Interaction handler error: %s', err.message);
        }
      });
    }

    if (this.config.discordToken && typeof this.client.login === 'function') {
      try {
        await this.client.login(this.config.discordToken);
        logger.child('notify:discord').info('Discord client connected.');
      } catch (err: any) {
        logger.child('notify:discord').error('Client login failed: %s', err.message);
      }
    }

    this.initialized = true;
  }

  async updateConfig(newConfig: Partial<ResolvedConfig>): Promise<void> {
    const oldToken = this.config.discordToken;
    this.config = { ...this.config, ...newConfig };

    if (
      this.config.discordToken &&
      this.config.discordToken !== oldToken &&
      this.client &&
      typeof this.client.login === 'function'
    ) {
      try {
        logger.child('notify:discord').info('Connecting Discord client with new token...');
        await this.client.login(this.config.discordToken);
        logger.child('notify:discord').info('Discord client connected via updated configuration.');
      } catch (err: any) {
        logger
          .child('notify:discord')
          .error('Client login with updated token failed: %s', err.message);
      }
    }
  }

  async init(): Promise<void> {
    return this.initialize();
  }

  /**
   * Main interaction dispatcher handling commands, selects, and modals.
   */
  async handleInteraction(interaction: any): Promise<void> {
    if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
      if (interaction.commandName === 'quota') {
        await this.handleQuotaCommand(interaction);
      }
      return;
    }

    if (interaction.isStringSelectMenu && interaction.isStringSelectMenu()) {
      if (
        interaction.customId === 'repo_select' ||
        interaction.customId === 'select_dispatch_repo'
      ) {
        await this.handleRepoSelect(interaction);
      }
      return;
    }

    if (interaction.isModalSubmit && interaction.isModalSubmit()) {
      if (
        typeof interaction.customId === 'string' &&
        (interaction.customId.startsWith('modal_dispatch:') ||
          interaction.customId.startsWith('modal_dispatch_'))
      ) {
        await this.handleModalSubmit(interaction);
      }
      return;
    }
  }

  private async handleQuotaCommand(interaction: any): Promise<void> {
    const allowedChannelId = this.config.discordNotificationChannelId;
    if (allowedChannelId && interaction.channelId && interaction.channelId !== allowedChannelId) {
      await interaction.reply({
        content: 'You do not have permission to run /quota in this channel.',
        ephemeral: true,
      });
      return;
    }

    let snapshots: QuotaSnapshot[] = [];
    if (this.options.onQuotaRequested) {
      try {
        snapshots = await this.options.onQuotaRequested();
      } catch {
        snapshots = [];
      }
    }

    const embed = renderQuotaEmbed(snapshots);
    const actionRow = createRepoSelectMenu(this.config.repositories);

    await interaction.reply({
      embeds: [embed],
      components: [actionRow],
    });
  }

  private async handleRepoSelect(interaction: any): Promise<void> {
    const selectedRepoId = interaction.values?.[0];
    if (!selectedRepoId || selectedRepoId === 'none') {
      if (
        typeof interaction.reply === 'function' &&
        !interaction.replied &&
        !interaction.deferred
      ) {
        try {
          await interaction.reply({
            content:
              '[Notice] No repositories are currently configured. Please configure repositories in settings.',
            ephemeral: true,
          });
        } catch {
          // Safe catch on interaction reply
        }
      }
      return;
    }

    const repo = this.config.repositories.find(
      (r) =>
        r.id === selectedRepoId ||
        r.name === selectedRepoId ||
        (selectedRepoId && r.id.startsWith(selectedRepoId))
    );
    const repoName = repo ? repo.name : selectedRepoId;

    const modal = createDispatchModal(selectedRepoId, repoName);
    await interaction.showModal(modal);
  }

  private async handleModalSubmit(interaction: any): Promise<void> {
    // 3s Discord timeout guard: defer immediately before async tasks
    await interaction.deferReply({ ephemeral: false });

    // Deduplication / Debounce guard for rapid duplicate clicks
    const userId = interaction.user?.id ?? 'user';
    const submissionKey = `${userId}_${interaction.customId}`;
    if (this.activeSubmissions.has(submissionKey)) {
      await interaction.editReply({
        content: '[Warning] A task is already in progress. Please wait for it to complete.',
      });
      return;
    }
    this.activeSubmissions.add(submissionKey);

    const rawRepoId =
      typeof interaction.customId === 'string' && interaction.customId.startsWith('modal_dispatch:')
        ? interaction.customId.slice('modal_dispatch:'.length)
        : typeof interaction.customId === 'string' &&
            interaction.customId.startsWith('modal_dispatch_')
          ? interaction.customId.slice('modal_dispatch_'.length)
          : '';

    const repo = this.config.repositories.find(
      (r) => r.id === rawRepoId || r.name === rawRepoId || (rawRepoId && r.id.startsWith(rawRepoId))
    );
    const repoId = rawRepoId;
    const repoName = repo?.name ?? rawRepoId;
    const repoPath = repo?.path ?? '';

    try {
      const rawPrompt = interaction.fields?.getTextInputValue?.('task_prompt') ?? '';
      const parseResult = TaskPromptSchema.safeParse(rawPrompt);
      if (!parseResult.success) {
        const errorMsg =
          `[Error] Invalid prompt: ${parseResult.error.errors[0]?.message ?? 'Prompt is required'}`.slice(
            0,
            2000
          );
        await interaction.editReply({
          content: errorMsg,
        });
        return;
      }
      const prompt = parseResult.data;

      // Register interaction for asynchronous status update relay
      if (repoId) this.activeInteractions.set(repoId, interaction);
      if (repoName) this.activeInteractions.set(repoName, interaction);

      if (this.options.onDispatchRequested) {
        const result = await this.options.onDispatchRequested({
          repositoryId: repoId,
          repositoryName: repoName,
          repositoryPath: repoPath,
          prompt,
          requestedBy: interaction.user?.username ?? 'otter',
        });

        if (result.success) {
          const branch = result.branchName ? ` on branch \`${result.branchName}\`` : '';
          const msg = `[Success] Antigravity continuation complete${branch}`.slice(0, 2000);
          await interaction.editReply({
            content: msg,
          });
        } else {
          const errMsg = result.error ? `: ${result.error}` : ': Execution aborted.';
          const msg = `[Blocked] Zero-Clobber Guardrail${errMsg}`.slice(0, 2000);
          await interaction.editReply({
            content: msg,
          });
        }
      } else {
        const msg =
          `[Notice] Agylity is operating in alerting-first mode. Task dispatch is inactive while swarm worker architecture is finalized.`.slice(
            0,
            2000
          );
        await interaction.editReply({
          content: msg,
        });
      }
    } catch (err: any) {
      try {
        const msg = `[Error] Task dispatch failed: ${err.message}`.slice(0, 2000);
        await interaction.editReply({
          content: msg,
        });
      } catch {
        // Safe catch on secondary errors
      }
    } finally {
      this.activeSubmissions.delete(submissionKey);
      if (repoId) this.activeInteractions.delete(repoId);
      if (repoName) this.activeInteractions.delete(repoName);
    }
  }

  async notifyQuotaAlert(alert: QuotaAlert): Promise<void> {
    if (!this.client || !this.initialized) return;

    const channelId = this.config.discordNotificationChannelId;
    if (!channelId || typeof this.client.channels?.fetch !== 'function') return;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased?.()) return;

      const poolName = (alert.pool.displayName || alert.pool.poolId || 'Quota Pool').slice(0, 256);
      let resetTimestamp = alert.pool.resetTime || 'Unknown';
      if (alert.pool.resetTime) {
        const resetDate = new Date(alert.pool.resetTime);
        if (!isNaN(resetDate.getTime())) {
          const unixSec = Math.floor(resetDate.getTime() / 1000);
          resetTimestamp = `<t:${unixSec}:R> (<t:${unixSec}:t>)`;
        }
      }

      const embed = new EmbedBuilder()
        .setTitle(`[Alert] Quota Milestone: ${poolName}`.slice(0, 256))
        .setDescription(`Milestone threshold: **${alert.milestoneHours}h** before quota reset.`)
        .setColor(0xffa500)
        .addFields(
          {
            name: 'Remaining Quota',
            value: renderSquareProgressBar(alert.pool.remainingFraction),
            inline: true,
          },
          {
            name: 'Reset Window',
            value: resetTimestamp,
            inline: true,
          }
        );

      if (alert.pool.models && alert.pool.models.length > 0) {
        const modelPills = alert.pool.models.map((m) => `\`${m}\``).join(' • ');
        embed.addFields({
          name: 'Monitored Models',
          value: modelPills.slice(0, 1024),
          inline: false,
        });
      }

      embed
        .setFooter({ text: 'Agylity Quota Sentry' })
        .setTimestamp(new Date(alert.triggeredAt || Date.now()));

      const actionRow = createRepoSelectMenu(this.config.repositories);

      await (channel as any).send({
        embeds: [embed],
        components: [actionRow],
      });
      logger
        .child('notify:discord')
        .info('Quota alert delivered to Discord channel %s (%s)', channelId, poolName);
    } catch (err: any) {
      logger.child('notify:discord').error('Failed to notify quota alert: %s', err.message);
    }
  }

  async notifyDispatchStatus(status: DispatchStatusUpdate): Promise<void> {
    const repoKey = status.repositoryName;
    if (repoKey && this.activeInteractions.has(repoKey)) {
      const interaction = this.activeInteractions.get(repoKey);
      try {
        const step = status.status ?? (status.step as string) ?? 'executing';
        const msg = (status.message ?? `Step: ${step}`).slice(0, 2000);
        await interaction.editReply({ content: msg });
      } catch {
        // Safe catch on interaction update
      }
    }

    if (!this.client || !this.initialized) return;
    const channelId = this.config.discordNotificationChannelId;
    if (!channelId || typeof this.client.channels?.fetch !== 'function') return;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased?.()) return;

      const step = status.status ?? (status.step as string) ?? 'executing';
      const msg = status.message ?? `Status: ${step}`;
      const channelMsg = `**[Dispatch: ${step.toUpperCase()}]** ${msg}`.slice(0, 2000);
      await (channel as any).send({
        content: channelMsg,
      });
    } catch {
      // Safe catch
    }
  }

  async testNotification(): Promise<{ success: boolean; message: string; channel: string }> {
    const channelId = this.config.discordNotificationChannelId;
    if (!channelId) {
      return {
        success: false,
        message:
          'No Discord notification channel configured (discordNotificationChannelId is unset).',
        channel: this.channelName,
      };
    }

    try {
      if (!this.initialized || !this.client) {
        await this.initialize();
      }

      const channel = await this.client?.channels?.fetch(channelId);
      if (
        !channel ||
        !(
          'isTextBased' in channel &&
          typeof channel.isTextBased === 'function' &&
          channel.isTextBased()
        )
      ) {
        return {
          success: false,
          message: `Discord channel ${channelId} could not be resolved or is not text-based.`,
          channel: this.channelName,
        };
      }

      if ('send' in channel && typeof (channel as any).send === 'function') {
        let samplePool: QuotaSnapshot | undefined;
        if (this.options.onQuotaRequested) {
          try {
            const pools = await this.options.onQuotaRequested();
            if (pools && pools.length > 0) {
              samplePool = pools.find((p) => p.family === 'claude') || pools[0];
            }
          } catch {}
        }

        const poolName = samplePool?.displayName || 'Claude and GPT models';
        const modelsList =
          samplePool?.models && samplePool.models.length > 0
            ? samplePool.models
            : ['Claude Opus', 'Claude Sonnet', 'GPT-OSS'];

        const resetDate = new Date(Date.now() + 3 * 3600 * 1000);
        const unixSec = Math.floor(resetDate.getTime() / 1000);
        const resetTimestamp = `<t:${unixSec}:R> (<t:${unixSec}:t>)`;

        const embed = new EmbedBuilder()
          .setTitle(`[Alert] Quota Milestone: ${poolName}`)
          .setDescription('Milestone threshold: **3h** before quota reset.')
          .setColor(0xffa500)
          .addFields(
            {
              name: 'Remaining Quota',
              value: renderSquareProgressBar(0.25),
              inline: true,
            },
            {
              name: 'Reset Window',
              value: resetTimestamp,
              inline: true,
            },
            {
              name: 'Monitored Models',
              value: modelsList.map((m) => `\`${m}\``).join(' • '),
              inline: false,
            }
          )
          .setFooter({ text: 'Agylity Quota Sentry • Test Notification Simulation' })
          .setTimestamp();

        const sendPayload: any = {
          embeds: [embed],
        };

        if (this.config.repositories && this.config.repositories.length > 0) {
          sendPayload.components = [createRepoSelectMenu(this.config.repositories)];
        }

        await (channel as any).send(sendPayload);
      }

      return {
        success: true,
        message: `Discord test message sent to channel ${channelId}`,
        channel: this.channelName,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Discord test failed: ${err.message}`,
        channel: this.channelName,
      };
    }
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
    this.activeInteractions.clear();
    this.activeSubmissions.clear();
    if (this.client && typeof this.client.destroy === 'function') {
      try {
        await this.client.destroy();
      } catch {
        // Safe catch on destroy
      }
    }
  }
}
