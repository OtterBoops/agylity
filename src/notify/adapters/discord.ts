import { Client, GatewayIntentBits } from 'discord.js';
import { normalizeStep, isTerminalStep } from '../embeds/formatters.js';
import type { ResolvedConfig } from '../../config/schema.js';
import { BUILTIN_DEFAULTS } from '../../config/schema.js';
import { logger } from '../../logs/logger.js';
import type {
  Notifier,
  QuotaAlert,
  QuotaSnapshot,
  DispatchStatusUpdate,
  DeliveryOutcome,
} from '../types.js';
import { buildQuotaAlertEmbed, buildTestAlertEmbed } from '../embeds/index.js';
import type { DiscordNotifierOptions } from '../discord/types.js';
import { renderDispatchEmbed } from '../discord/embeds.js';
import { createRepoSelectMenu } from '../discord/components.js';
import { registerSlashCommands } from '../discord/commands.js';
import { routeInteraction } from '../discord/interactions.js';
import type { DiscordInteractionDeps } from '../discord/interactions.js';

export {
  generateProgressBar,
  formatProgressBar,
  renderProgressBar,
  renderSquareProgressBar,
} from '../discord/progress.js';
export { renderQuotaEmbed, renderDispatchEmbed } from '../discord/embeds.js';
export { createRepoSelectMenu, createDispatchModal } from '../discord/components.js';
export type { CreateDispatchModalOptions } from '../discord/components.js';
export { TaskPromptSchema } from '../discord/commands.js';
export type { DiscordNotifierOptions } from '../discord/types.js';

export class DiscordNotifier implements Notifier {
  readonly channelName: string = 'discord';
  public client: Client | null = null;
  public initialized = false;
  public activeInteractions = new Map<string, any>();
  // Bounds retention of dispatched interactions so cancelled or reaped tasks cannot leak entries.
  public maxActiveInteractions = 200;
  public interactionRetentionMs = 30 * 60 * 1000;
  private config: ResolvedConfig;
  private options: DiscordNotifierOptions;
  private activeSubmissions = new Set<string>();
  private pinnedOwnerUserId?: string;

  constructor(config: Partial<ResolvedConfig> = {}, options: DiscordNotifierOptions = {}) {
    this.config = { ...BUILTIN_DEFAULTS, ...config };
    this.options = options;
    if (this.config.discordOwnerUserId?.trim()) {
      this.pinnedOwnerUserId = this.config.discordOwnerUserId.trim();
    }

    if (options.client) {
      this.client = options.client;
    }
  }

  // Returns the currently bound Discord owner user ID (explicitly configured or TOFU-pinned).
  public getBoundOwnerUserId(): string | undefined {
    return this.config.discordOwnerUserId?.trim() || this.pinnedOwnerUserId;
  }

  // Owner binding is single-user: a configured owner id, else the first interactor pins the session.
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

  // Bundles the live interaction context for the extracted handlers; the retention caps are getters
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

    if (!this.client) {
      this.client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
        allowedMentions: {
          parse: ['users'],
          repliedUser: true,
        },
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
        await this.autoDiscoverOwnerUserId();
        await registerSlashCommands(this.config);
        this.initialized = true;
      } catch (err: any) {
        logger.child('notify:discord').error('Client login failed: %s', err.message);
        // Do not mark initialized if login threw
      }
    } else {
      // Mock or unauthenticated client mode
      this.initialized = true;
    }
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

  async init(): Promise<void> {
    return this.initialize();
  }

  // The first awaited call on every handler path must be the Discord ack, inside the 3s deadline.
  async handleInteraction(interaction: any): Promise<void> {
    return routeInteraction(this.interactionDeps(), interaction);
  }

  // Automatically discovers and binds the Discord server owner ID if discordOwnerUserId is unset.
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
          } catch {
            // Safe catch on callback
          }
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
    if (!this.client || !this.initialized) {
      return {
        delivered: false,
        results: {
          [this.channelName]: { success: false, error: 'Discord client is not initialized' },
        },
      };
    }

    const channelId = this.config.discordNotificationChannelId;
    if (!channelId || typeof this.client.channels?.fetch !== 'function') {
      return {
        delivered: false,
        results: {
          [this.channelName]: {
            success: false,
            error: 'No Discord notification channel configured',
          },
        },
      };
    }

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased?.()) {
        return {
          delivered: false,
          results: {
            [this.channelName]: { success: false, error: 'Discord channel is unavailable' },
          },
        };
      }

      const ownerId = await this.resolveOwnerUserId();
      const embed = buildQuotaAlertEmbed(alert, {
        ownerUserId: ownerId,
        pingOwner: this.config.discordPingOwner !== false,
      });
      const actionRow = createRepoSelectMenu(this.config.repositories, alert.pool.family);
      const mention = this.resolveOwnerMention(ownerId);

      const sendPayload: any = {
        embeds: [embed],
        components: [actionRow],
      };

      if (mention && ownerId) {
        sendPayload.content = mention;
        sendPayload.allowedMentions = {
          users: [ownerId],
        };
      }

      await (channel as any).send(sendPayload);
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
      return {
        delivered: false,
        results: { [this.channelName]: { success: false, error: err.message } },
      };
    }
  }

  async notifyDispatchStatus(status: DispatchStatusUpdate): Promise<void> {
    const taskKey = status.taskId;
    const repoKey = status.repositoryName;
    const interaction =
      (taskKey ? this.activeInteractions.get(taskKey) : undefined) ||
      (repoKey ? this.activeInteractions.get(repoKey) : undefined);

    if (interaction) {
      try {
        const step = status.status ?? (status.step as string) ?? 'executing';
        const msg = (status.message ?? `Step: ${step}`).slice(0, 2000);
        await interaction.editReply({ content: msg });
      } catch {
        // Safe catch on interaction update
      }
      const st = normalizeStep(status);
      if (isTerminalStep(st)) {
        if (taskKey) this.activeInteractions.delete(taskKey);
        if (repoKey) this.activeInteractions.delete(repoKey);
      }
    }

    if (!this.client || !this.initialized) return;
    const channelId = this.config.discordNotificationChannelId;
    if (!channelId || typeof this.client.channels?.fetch !== 'function') return;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased?.()) return;

      const st = normalizeStep(status);
      const isTerminal = isTerminalStep(st);
      const isInitial = st === 'polling' || st === 'waking';

      // Only notify on initial dispatch and final completion
      // Drop noisy intermediate runner progress heartbeats (checking out branch, launching agy)
      if (!isInitial && !isTerminal) {
        return;
      }

      const embed = renderDispatchEmbed(status);
      await (channel as any).send({ embeds: [embed] });
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

        const ownerId = await this.resolveOwnerUserId();
        const embed = buildTestAlertEmbed(samplePool, {
          ownerUserId: ownerId,
          pingOwner: this.config.discordPingOwner !== false,
        });
        const mention = this.resolveOwnerMention(ownerId);

        const sendPayload: any = {
          embeds: [embed],
        };

        if (mention && ownerId) {
          sendPayload.content = mention;
          sendPayload.allowedMentions = {
            users: [ownerId],
          };
        }

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
    if (this.client) {
      if (typeof this.client.removeAllListeners === 'function') {
        try {
          this.client.removeAllListeners();
        } catch {
          // Safe catch
        }
      }
      if (typeof this.client.destroy === 'function') {
        try {
          await this.client.destroy();
        } catch {
          // Safe catch on destroy
        }
      }
      this.client = null;
    }
  }
}
