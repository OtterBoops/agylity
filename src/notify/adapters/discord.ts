import { Client, GatewayIntentBits } from 'discord.js';
import { normalizeStep, isTerminalStep } from '../embeds/formatters.js';
import { type ResolvedConfig } from '../../config/types.js';
import { BUILTIN_DEFAULTS } from '../../config/registry.js';
import { logger } from '../../logs/logger.js';
import type {
  Notifier,
  QuotaAlert,
  QuotaSnapshot,
  DispatchStatusUpdate,
  DeliveryOutcome,
  InfoNotice,
} from '../types.js';
import { buildQuotaAlertEmbed, buildTestAlertEmbed } from '../embeds/index.js';
import type { DiscordNotifierOptions } from '../discord/types.js';
import { renderDispatchEmbed, renderInfoEmbed } from '../discord/embeds.js';
import { createRepoSelectMenu } from '../discord/components.js';
import { registerSlashCommands } from '../discord/commands.js';
import { routeInteraction } from '../discord/interactions.js';
import type { DiscordInteractionDeps } from '../discord/interactions.js';

/** A resolved channel is only usable if it can receive a message; discord.js unions several that cannot. */
type SendableChannel = { send(payload: unknown): Promise<unknown> };

const isSendableChannel = (channel: unknown): channel is SendableChannel =>
  typeof channel === 'object' &&
  channel !== null &&
  typeof (channel as SendableChannel).send === 'function';

export { renderQuotaEmbed, renderDispatchEmbed } from '../discord/embeds.js';
export { createRepoSelectMenu, createDispatchModal } from '../discord/components.js';
export type { CreateDispatchModalOptions } from '../discord/components.js';
export { TaskPromptSchema } from '../discord/commands.js';
export type { DiscordNotifierOptions } from '../discord/types.js';

export class DiscordNotifier implements Notifier {
  readonly channelName: string;
  readonly destinationType = 'discord' as const;
  public client: Client | null = null;
  public initialized = false;
  private loginRetryAt = 0;
  private connectPromise: Promise<boolean> | null = null;
  public activeInteractions = new Map<string, any>();
  public maxActiveInteractions = 200;
  public interactionRetentionMs = 30 * 60 * 1000;
  private config: ResolvedConfig;
  private options: DiscordNotifierOptions;
  private activeSubmissions = new Set<string>();
  private pinnedOwnerUserId?: string;
  private interactionListenerBound = false;

  constructor(config: Partial<ResolvedConfig> = {}, options: DiscordNotifierOptions = {}) {
    this.channelName = options.channelName?.trim() || 'discord';
    this.config = { ...BUILTIN_DEFAULTS, ...config } as ResolvedConfig;
    this.options = options;
    if (this.config.discordOwnerUserId?.trim()) {
      this.pinnedOwnerUserId = this.config.discordOwnerUserId.trim();
    }

    if (options.client) {
      this.client = options.client;
    }
  }

  private failure(error: string): DeliveryOutcome {
    return { delivered: false, results: { [this.channelName]: { success: false, error } } };
  }

  private withOwnerMention(payload: any, ownerId: string | undefined): any {
    const mention = this.resolveOwnerMention(ownerId);
    if (!mention || !ownerId) return payload;
    return { ...payload, content: mention, allowedMentions: { users: [ownerId] } };
  }

  public getBoundOwnerUserId(): string | undefined {
    return this.config.discordOwnerUserId?.trim() || this.pinnedOwnerUserId;
  }

  private verifyOwnerBinding(interaction: any): { allowed: boolean; reason?: string } {
    const userId = typeof interaction?.user?.id === 'string' ? interaction.user.id.trim() : '';
    const configuredOwner = this.config.discordOwnerUserId?.trim();

    if (configuredOwner) {
      if (!userId || userId !== configuredOwner) {
        logger
          .child('notify:discord')
          .warn(
            'Blocked unauthorized Discord interaction from user %s (bound owner: %s)',
            userId || 'unknown',
            configuredOwner
          );
        return {
          allowed: false,
          reason:
            '[Blocked] Single-User Binding: This Agylity instance is restricted to the configured Discord owner.',
        };
      }
      return { allowed: true };
    }

    if (userId) {
      if (!this.pinnedOwnerUserId) {
        this.pinnedOwnerUserId = userId;
        return { allowed: true };
      }
      if (this.pinnedOwnerUserId !== userId) {
        logger
          .child('notify:discord')
          .warn(
            'Blocked Discord interaction from secondary user %s (session pinned to owner: %s)',
            userId,
            this.pinnedOwnerUserId
          );
        return {
          allowed: false,
          reason:
            '[Blocked] Single-User Binding: This Agylity session is already bound to another Discord user. Set DISCORD_OWNER_USER_ID to configure explicit owner binding.',
        };
      }
    }

    return { allowed: true };
  }

  // Retention caps stay getters so a later config change still applies to these deps.
  private interactionDeps(): DiscordInteractionDeps {
    const self = this;
    return {
      config: this.config,
      options: this.options,
      activeInteractions: this.activeInteractions,
      activeSubmissions: this.activeSubmissions,
      get maxActiveInteractions(): number {
        return self.maxActiveInteractions;
      },
      get interactionRetentionMs(): number {
        return self.interactionRetentionMs;
      },
      verifyOwnerBinding: (interaction: any) => self.verifyOwnerBinding(interaction),
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    const attempt = this.performInitialize().finally(() => {
      if (this.connectPromise === attempt) {
        this.connectPromise = null;
      }
    });
    this.connectPromise = attempt;
    await attempt;
  }

  private async performInitialize(): Promise<boolean> {
    if (this.initialized) return this.client !== null;

    if (!this.client) {
      this.client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
        allowedMentions: {
          parse: ['users'],
          repliedUser: true,
        },
      });
    }

    if (!this.interactionListenerBound && typeof this.client.on === 'function') {
      this.interactionListenerBound = true;
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
        await this.autoDiscoverOwnerUserId();
        await registerSlashCommands(this.config);
        this.initialized = true;
        this.loginRetryAt = 0;
      } catch (err: any) {
        // A transient gateway failure must not silence the channel for the life of the process.
        this.loginRetryAt = Date.now() + 30 * 1000;
        logger.child('notify:discord').error('Client login failed: %s', err.message);
      }
    } else {
      this.initialized = true;
    }

    return this.client !== null && this.initialized;
  }

  /** A login that failed at boot is retried on the next delivery, not only when the token changes. */
  private async ensureConnected(): Promise<boolean> {
    if (this.client && this.initialized) return true;
    if (this.connectPromise) return this.connectPromise;
    if (!this.config.discordToken) return false;
    if (Date.now() < this.loginRetryAt) return false;
    await this.initialize();
    return this.client !== null && this.initialized;
  }

  async updateConfig(newConfig: Partial<ResolvedConfig>): Promise<void> {
    const oldToken = this.config.discordToken;
    const oldClientId = this.config.discordClientId;
    const oldGuildId = this.config.discordGuildId;
    this.config = { ...this.config, ...newConfig };
    if (newConfig.discordOwnerUserId !== undefined) {
      this.pinnedOwnerUserId = newConfig.discordOwnerUserId.trim() || undefined;
    }

    if (oldToken && !this.config.discordToken && this.client) {
      logger.child('notify:discord').info('Discord token cleared; disconnecting client.');
      await this.shutdown();
      return;
    }

    if (this.config.discordToken && this.config.discordToken !== oldToken) {
      if (!this.client || typeof this.client.destroy === 'function') {
        await this.shutdown();
      }
      this.initialized = false;
      this.client = null;
      await this.initialize();
    } else if (
      this.client &&
      this.config.discordToken &&
      (this.config.discordClientId !== oldClientId || this.config.discordGuildId !== oldGuildId)
    ) {
      await registerSlashCommands(this.config);
    }
  }

  // The first awaited call on every handler path must be the Discord ack, inside the 3s deadline.
  async handleInteraction(interaction: any): Promise<void> {
    return routeInteraction(this.interactionDeps(), interaction);
  }

  public async autoDiscoverOwnerUserId(): Promise<string | undefined> {
    if (this.config.discordOwnerUserId?.trim()) {
      return this.config.discordOwnerUserId.trim();
    }
    if (this.pinnedOwnerUserId?.trim()) {
      return this.pinnedOwnerUserId.trim();
    }
    if (!this.client) {
      return undefined;
    }

    try {
      let guild: any = null;
      if (this.config.discordGuildId && typeof this.client.guilds?.fetch === 'function') {
        guild = await this.client.guilds.fetch(this.config.discordGuildId).catch(() => null);
      }
      if (!guild && typeof this.client.guilds?.fetch === 'function') {
        const guilds = await this.client.guilds.fetch().catch(() => null);
        const first = guilds?.first?.();
        if (first && typeof first.fetch === 'function') {
          guild = await first.fetch().catch(() => null);
        } else if (first) {
          guild = first;
        }
      }
      if (
        !guild &&
        this.client.guilds?.cache &&
        typeof this.client.guilds.cache.first === 'function'
      ) {
        guild = this.client.guilds.cache.first();
      }

      if (guild?.ownerId) {
        this.pinnedOwnerUserId = guild.ownerId;
        logger
          .child('notify:discord')
          .info(
            'Auto-discovered Discord owner ID from guild %s: %s',
            guild.name || guild.id,
            guild.ownerId
          );
        if (this.options.onOwnerDiscovered) {
          try {
            await this.options.onOwnerDiscovered(guild.ownerId);
          } catch {}
        }
        return guild.ownerId;
      }
    } catch (err: any) {
      logger.child('notify:discord').debug('Could not auto-discover guild owner: %s', err.message);
    }

    return undefined;
  }

  public async resolveOwnerUserId(): Promise<string | undefined> {
    const direct = this.config.discordOwnerUserId?.trim() || this.pinnedOwnerUserId?.trim();
    if (direct) return direct;
    return await this.autoDiscoverOwnerUserId();
  }

  public resolveOwnerMention(ownerId?: string): string | undefined {
    if (this.config.discordPingOwner === false) return undefined;
    const targetOwner = ownerId || this.getBoundOwnerUserId();
    return targetOwner ? `<@${targetOwner}>` : undefined;
  }

  async notifyQuotaAlert(alert: QuotaAlert): Promise<DeliveryOutcome> {
    if (!(await this.ensureConnected()) || !this.client) {
      return this.failure('Discord client is not initialized');
    }

    const channelId = this.config.discordNotificationChannelId;
    if (!channelId || typeof this.client.channels?.fetch !== 'function') {
      return this.failure('No Discord notification channel configured');
    }

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !isSendableChannel(channel)) {
        return this.failure('Discord channel is unavailable');
      }

      const ownerId = await this.resolveOwnerUserId();
      const embed = buildQuotaAlertEmbed(alert, {
        ownerUserId: ownerId,
        pingOwner: this.config.discordPingOwner !== false,
        baseUrl: this.config.baseUrl,
      });
      const actionRow = createRepoSelectMenu(this.config.repositories, alert.pool.poolGroup);
      const sendPayload = this.withOwnerMention(
        { embeds: [embed], components: [actionRow] },
        ownerId
      );

      await channel.send(sendPayload);
      logger
        .child('notify:discord')
        .info(
          'Quota alert delivered to Discord channel %s (%s)',
          channelId,
          alert.pool.displayName || alert.pool.poolId
        );
      return { delivered: true, results: { [this.channelName]: { success: true } } };
    } catch (err: any) {
      logger.child('notify:discord').error('Failed to notify quota alert: %s', err.message);
      return this.failure(err.message);
    }
  }

  async notifyDispatchStatus(status: DispatchStatusUpdate): Promise<void> {
    const taskKey = status.taskId;
    const repoKey = status.repositoryName;
    // The repository key is a fallback for a status that names no task; with a task id present, a miss
    // means this task has no Discord message, not that another task's message is fair game.
    const interaction = taskKey
      ? this.activeInteractions.get(taskKey)
      : repoKey
        ? this.activeInteractions.get(repoKey)
        : undefined;

    if (interaction) {
      try {
        const step = status.status ?? (status.step as string) ?? 'executing';
        // A blank relay is rejected by Discord as an empty message, so it falls back to the step.
        const msg = (status.message?.trim() || `Step: ${step}`).slice(0, 2000);
        await interaction.editReply({ content: msg });
      } catch {}
      const st = normalizeStep(status);
      if (isTerminalStep(st)) {
        if (taskKey && this.activeInteractions.get(taskKey) === interaction) {
          this.activeInteractions.delete(taskKey);
        }
        if (repoKey && this.activeInteractions.get(repoKey) === interaction) {
          this.activeInteractions.delete(repoKey);
        }
      }
    }

    if (!(await this.ensureConnected()) || !this.client) return;
    const channelId = this.config.discordNotificationChannelId;
    if (!channelId || typeof this.client.channels?.fetch !== 'function') return;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !isSendableChannel(channel)) return;

      const st = normalizeStep(status);
      const isTerminal = isTerminalStep(st);
      const isInitial = st === 'polling' || st === 'waking';

      if (!isInitial && !isTerminal) {
        return;
      }

      const embed = renderDispatchEmbed(status, this.config.baseUrl);
      await channel.send({ embeds: [embed] });
    } catch {}
  }

  async notifyInfo(notice: InfoNotice): Promise<DeliveryOutcome> {
    if (!(await this.ensureConnected()) || !this.client) {
      return this.failure('Discord client not initialized');
    }

    const channelId = this.config.discordNotificationChannelId;
    if (!channelId || typeof this.client.channels?.fetch !== 'function') {
      return this.failure('No notification channel configured');
    }

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !isSendableChannel(channel)) {
        return this.failure('Target channel is not text-based');
      }

      const embed = renderInfoEmbed(notice, this.config.baseUrl);
      await channel.send({ embeds: [embed] });
      return { delivered: true, results: { [this.channelName]: { success: true } } };
    } catch (err: any) {
      logger.child('notify:discord').debug('Failed to deliver info notice: %s', err.message);
      return this.failure(err?.message ?? String(err));
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

      if (!isSendableChannel(channel)) {
        return {
          success: false,
          message: `Discord channel ${channelId} cannot receive messages.`,
          channel: this.channelName,
        };
      }

      let samplePool: QuotaSnapshot | undefined;
      if (this.options.onQuotaRequested) {
        try {
          const pools = await this.options.onQuotaRequested();
          if (pools && pools.length > 0) {
            samplePool = pools.find((p) => p.poolGroup === 'claude') || pools[0];
          }
        } catch {}
      }

      const ownerId = await this.resolveOwnerUserId();
      const embed = buildTestAlertEmbed(samplePool, {
        ownerUserId: ownerId,
        pingOwner: this.config.discordPingOwner !== false,
        baseUrl: this.config.baseUrl,
      });
      const sendPayload = this.withOwnerMention({ embeds: [embed] }, ownerId);

      if (this.config.repositories && this.config.repositories.length > 0) {
        sendPayload.components = [createRepoSelectMenu(this.config.repositories)];
      }

      await channel.send(sendPayload);

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
    this.connectPromise = null;
    this.interactionListenerBound = false;
    this.activeInteractions.clear();
    this.activeSubmissions.clear();
    if (this.client) {
      if (typeof this.client.removeAllListeners === 'function') {
        try {
          this.client.removeAllListeners();
        } catch {}
      }
      if (typeof this.client.destroy === 'function') {
        try {
          await this.client.destroy();
        } catch {}
      }
      this.client = null;
    }
  }
}
