import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  REST,
  Routes,
  SlashCommandBuilder,
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
import {
  buildQuotaAlertEmbed,
  buildTestAlertEmbed,
  buildQuotaStatusEmbed,
  buildDispatchStatusEmbed,
  renderSquareProgressBar,
  formatResetWindow,
} from '../embeds/index.js';
import {
  parseDiscordModelPriorityInput,
  resolveConcreteModelId,
} from '../../orchestrator/models.js';

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

export { renderSquareProgressBar };

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
  const standard = buildQuotaStatusEmbed(pools);
  const embed = new EmbedBuilder().setTitle(standard.title!).setColor(standard.color!);

  if (standard.description) {
    embed.setDescription(standard.description);
    return embed;
  }

  if (standard.fields && standard.fields.length > 0) {
    embed.addFields(standard.fields);
  }

  return embed;
};

export const renderDispatchEmbed = (status: DispatchStatusUpdate): EmbedBuilder => {
  const standard = buildDispatchStatusEmbed(status);
  const embed = new EmbedBuilder().setTitle(standard.title!).setColor(standard.color!);

  if (standard.description) {
    embed.setDescription(standard.description.slice(0, 4096));
  }

  if (standard.fields && standard.fields.length > 0) {
    embed.addFields(
      standard.fields.map((f) => ({
        name: f.name.slice(0, 256),
        value: f.value.slice(0, 1024),
        inline: f.inline ?? true,
      }))
    );
  }

  if (standard.footer) {
    embed.setFooter({ text: standard.footer.text.slice(0, 2048) });
  }

  if (standard.timestamp) {
    embed.setTimestamp(new Date(standard.timestamp));
  }

  return embed;
};

/**
 * Creates repository StringSelectMenu component.
 * Optional poolFamily encodes the triggering quota alert family into customId (`repo_select:<family>`).
 */
export const createRepoSelectMenu = (
  repositories: Array<{ id: string; name: string; path?: string; description?: string }>,
  poolFamily?: string
): ActionRowBuilder<StringSelectMenuBuilder> => {
  const customId = poolFamily ? `repo_select:${poolFamily}` : 'repo_select';
  const select = new StringSelectMenuBuilder().setCustomId(customId);
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

export interface CreateDispatchModalOptions {
  includeModelInput?: boolean;
  defaultModel?: string;
  poolFamily?: string;
}

/**
 * Creates modal dialog for task prompt (and optional model/priority input).
 */
export const createDispatchModal = (
  repoId: string,
  repoName: string,
  options?: CreateDispatchModalOptions
): ModalBuilder => {
  const title = `Dispatch Task: ${repoName}`.slice(0, 45);
  const rawCustomId = options?.poolFamily
    ? `modal_dispatch:${repoId}:${options.poolFamily}`
    : `modal_dispatch:${repoId}`;
  const safeCustomId = rawCustomId.slice(0, 100);
  const modal = new ModalBuilder().setCustomId(safeCustomId).setTitle(title);

  const promptInput = new TextInputBuilder()
    .setCustomId('task_prompt')
    .setLabel('Task Prompt / Objectives')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Enter the exact task instructions for Antigravity continuation...')
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(4000);

  const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(promptInput);
  modal.addComponents(row1);

  if (options?.includeModelInput) {
    const initialModel = resolveConcreteModelId(
      options.poolFamily,
      options.defaultModel || 'gemini-4-argon'
    );
    const modelInput = new TextInputBuilder()
      .setCustomId('task_model_priority')
      .setLabel('Model & Priority (e.g. model-id P0/P1/P2)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('gemini-4-argon P0 (or claude-opus-5-5, P2)')
      .setValue(`${initialModel} P0`)
      .setRequired(false)
      .setMaxLength(120);

    const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(modelInput);
    modal.addComponents(row2);
  }

  return modal;
};

export interface DiscordNotifierOptions extends NotifierOptions {
  client?: Client | any;
  onContinueRequested?: (req: any) => Promise<DispatchResult>;
}

export class DiscordNotifier implements Notifier {
  readonly channelName: string = 'discord';
  public client: Client | null = null;
  public initialized = false;
  public activeInteractions = new Map<string, any>();
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

  /**
   * Returns the currently bound Discord owner user ID (explicitly configured or TOFU-pinned).
   */
  public getBoundOwnerUserId(): string | undefined {
    return this.config.discordOwnerUserId?.trim() || this.pinnedOwnerUserId;
  }

  /**
   * Enforces strict single-user binding on Discord interactions.
   * - If `discordOwnerUserId` is explicitly configured, only that user ID is permitted.
   * - Otherwise, pins the first interacting Discord user ID (Trust-On-First-Use) for the session
   *   and rejects any subsequent interactions from different Discord users.
   */
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
        await this.registerSlashCommands();
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

  private async registerSlashCommands(): Promise<void> {
    if (!this.config.discordToken || !this.config.discordClientId) return;
    try {
      const rest = new REST({ version: '10' }).setToken(this.config.discordToken);
      const commands = [
        new SlashCommandBuilder()
          .setName('quota')
          .setDescription('Check remaining Antigravity model quota headroom')
          .toJSON(),
        new SlashCommandBuilder()
          .setName('dispatch')
          .setDescription('Dispatch a background continuation task to Antigravity swarm')
          .addStringOption((opt) =>
            opt
              .setName('repository')
              .setDescription('Target repository ID or name')
              .setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName('prompt').setDescription('Task prompt or instructions').setRequired(true)
          )
          .addStringOption((opt) =>
            opt
              .setName('model')
              .setDescription('Model override (e.g. gemini-4-argon, claude-opus-5-5)')
              .setRequired(false)
          )
          .addStringOption((opt) =>
            opt.setName('priority').setDescription('Task priority (P0, P1, P2)').setRequired(false)
          )
          .addStringOption((opt) =>
            opt
              .setName('effort')
              .setDescription('Reasoning effort (low, medium, high)')
              .setRequired(false)
          )
          .toJSON(),
      ];

      if (this.config.discordGuildId) {
        await rest.put(
          Routes.applicationGuildCommands(this.config.discordClientId, this.config.discordGuildId),
          { body: commands }
        );
      } else {
        await rest.put(Routes.applicationCommands(this.config.discordClientId), {
          body: commands,
        });
      }
      logger
        .child('notify:discord')
        .info('Registered Discord application commands (/quota, /dispatch).');
    } catch (err: any) {
      logger.child('notify:discord').warn('Failed to register Discord commands: %s', err.message);
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
      await this.registerSlashCommands();
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
      } else if (interaction.commandName === 'dispatch') {
        await this.handleDispatchCommand(interaction);
      }
      return;
    }

    if (interaction.isStringSelectMenu && interaction.isStringSelectMenu()) {
      if (
        interaction.customId === 'repo_select' ||
        interaction.customId === 'select_dispatch_repo' ||
        (typeof interaction.customId === 'string' &&
          interaction.customId.startsWith('repo_select:'))
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

  private async handleDispatchCommand(interaction: any): Promise<void> {
    const ownerCheck = this.verifyOwnerBinding(interaction);
    if (!ownerCheck.allowed) {
      if (typeof interaction.reply === 'function') {
        await interaction.reply({
          content: ownerCheck.reason,
          ephemeral: true,
        });
      }
      return;
    }

    const canDefer = typeof interaction.deferReply === 'function';
    if (canDefer) {
      try {
        await interaction.deferReply({ ephemeral: true });
      } catch {
        // Safe catch on defer
      }
    }

    const repositoryName = interaction.options?.getString?.('repository') ?? '';
    const prompt = interaction.options?.getString?.('prompt') ?? '';
    const model = interaction.options?.getString?.('model') || undefined;
    const rawPriority = interaction.options?.getString?.('priority');
    const priority =
      rawPriority && ['P0', 'P1', 'P2'].includes(rawPriority.toUpperCase())
        ? (rawPriority.toUpperCase() as 'P0' | 'P1' | 'P2')
        : undefined;
    const effort = interaction.options?.getString?.('effort') || undefined;

    if (!prompt.trim()) {
      const errReply = { content: '[Error] Task prompt cannot be empty.' };
      if (canDefer && typeof interaction.editReply === 'function') {
        await interaction.editReply(errReply);
      } else if (typeof interaction.reply === 'function') {
        await interaction.reply({ ...errReply, ephemeral: true });
      }
      return;
    }

    const onDispatch =
      this.options.onDispatchRequested || (this.options as any).onContinueRequested;
    if (!onDispatch) {
      const errReply = { content: '[Error] Orchestrator dispatch callback is not registered.' };
      if (canDefer && typeof interaction.editReply === 'function') {
        await interaction.editReply(errReply);
      } else if (typeof interaction.reply === 'function') {
        await interaction.reply({ ...errReply, ephemeral: true });
      }
      return;
    }

    const requestedBy = interaction.user?.tag || interaction.user?.username || 'Discord User';
    const requestedByUserId = interaction.user?.id;
    try {
      const result = await onDispatch({
        repositoryName,
        prompt: prompt.trim(),
        requestedBy,
        requestedByUserId,
        model,
        priority,
        effort,
      });

      if (result.taskId) {
        this.activeInteractions.set(result.taskId, interaction);
      }

      let content = '';
      const isQueued = result.status === 'queued' || Boolean(result.taskId && !result.branchName);
      if (!result.success) {
        content = `[Error] Dispatch failed: ${result.error ?? 'Unknown error'}`;
      } else if (isQueued) {
        content = `[Notice] Continuation task \`#${(result.taskId || '').slice(0, 8)}\` (${result.priority ?? priority ?? 'P1'}) queued for \`${repositoryName}\` — waiting for swarm runner...`;
      } else {
        content = `[Success] Antigravity continuation complete on branch \`${result.branchName ?? 'main'}\`.`;
      }

      if (canDefer && typeof interaction.editReply === 'function') {
        await interaction.editReply({ content });
      } else if (typeof interaction.reply === 'function') {
        await interaction.reply({ content, ephemeral: true });
      }
    } catch (err: any) {
      const content = `[Error] Dispatch invocation failed: ${err.message}`;
      if (canDefer && typeof interaction.editReply === 'function') {
        await interaction.editReply({ content });
      } else if (typeof interaction.reply === 'function') {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  }

  private async handleQuotaCommand(interaction: any): Promise<void> {
    const ownerCheck = this.verifyOwnerBinding(interaction);
    if (!ownerCheck.allowed) {
      if (typeof interaction.reply === 'function') {
        await interaction.reply({
          content: ownerCheck.reason,
          ephemeral: true,
        });
      }
      return;
    }

    const allowedChannelId = this.config.discordNotificationChannelId;
    const inGuild = typeof interaction.inGuild === 'function' ? interaction.inGuild() : true;
    if (
      inGuild &&
      allowedChannelId &&
      interaction.channelId &&
      interaction.channelId !== allowedChannelId
    ) {
      if (typeof interaction.reply === 'function') {
        await interaction.reply({
          content: 'You do not have permission to run /quota in this channel.',
          ephemeral: true,
        });
      }
      return;
    }

    const canDefer = typeof interaction.deferReply === 'function';
    if (canDefer) {
      try {
        await interaction.deferReply();
      } catch {
        // Safe catch on interaction defer
      }
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

    if (canDefer && typeof interaction.editReply === 'function') {
      await interaction.editReply({
        embeds: [embed],
        components: [actionRow],
      });
    } else if (typeof interaction.reply === 'function') {
      await interaction.reply({
        embeds: [embed],
        components: [actionRow],
      });
    }
  }

  private async handleRepoSelect(interaction: any): Promise<void> {
    const ownerCheck = this.verifyOwnerBinding(interaction);
    if (!ownerCheck.allowed) {
      if (
        typeof interaction.reply === 'function' &&
        !interaction.replied &&
        !interaction.deferred
      ) {
        try {
          await interaction.reply({
            content: ownerCheck.reason,
            ephemeral: true,
          });
        } catch {
          // Safe catch on interaction reply
        }
      }
      return;
    }

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
    const poolFamily =
      typeof interaction.customId === 'string' && interaction.customId.startsWith('repo_select:')
        ? interaction.customId.slice('repo_select:'.length)
        : undefined;

    const modal = createDispatchModal(selectedRepoId, repoName, {
      includeModelInput: true,
      defaultModel: this.config.defaultDispatchModel,
      poolFamily,
    });
    await interaction.showModal(modal);
  }

  private async handleModalSubmit(interaction: any): Promise<void> {
    // 3s Discord timeout guard: defer immediately before async tasks
    try {
      await interaction.deferReply({ ephemeral: false });
    } catch (err: any) {
      logger
        .child('notify:discord')
        .debug('Modal deferReply failed or already acknowledged: %s', err.message);
    }

    const ownerCheck = this.verifyOwnerBinding(interaction);
    if (!ownerCheck.allowed) {
      await interaction.editReply({
        content: ownerCheck.reason,
      });
      return;
    }

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

    const rawCustomSuffix =
      typeof interaction.customId === 'string' && interaction.customId.startsWith('modal_dispatch:')
        ? interaction.customId.slice('modal_dispatch:'.length)
        : typeof interaction.customId === 'string' &&
            interaction.customId.startsWith('modal_dispatch_')
          ? interaction.customId.slice('modal_dispatch_'.length)
          : '';

    const lastColonIdx = rawCustomSuffix.lastIndexOf(':');
    const rawRepoId =
      lastColonIdx !== -1 ? rawCustomSuffix.slice(0, lastColonIdx) : rawCustomSuffix;
    const alertPoolFamily =
      lastColonIdx !== -1 ? rawCustomSuffix.slice(lastColonIdx + 1) : undefined;

    const repo = this.config.repositories.find(
      (r) => r.id === rawRepoId || r.name === rawRepoId || (rawRepoId && r.id.startsWith(rawRepoId))
    );
    const repoId = rawRepoId;
    const repoName = repo?.name ?? rawRepoId;
    const repoPath = repo?.path ?? '';

    let result: DispatchResult | undefined;
    try {
      const rawPrompt = interaction.fields?.getTextInputValue?.('task_prompt') ?? '';
      let rawModelInput = '';
      try {
        rawModelInput = interaction.fields?.getTextInputValue?.('task_model_priority') ?? '';
      } catch {
        rawModelInput = '';
      }
      const parseResult = TaskPromptSchema.safeParse(rawPrompt);
      if (!parseResult.success) {
        const errorMsg =
          `[Error] Invalid prompt: ${parseResult.error.issues[0]?.message ?? 'Prompt is required'}`.slice(
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
        const dispatchPayload: DispatchRequest = {
          repositoryId: repoId,
          repositoryName: repoName,
          repositoryPath: repoPath,
          prompt,
          requestedBy: interaction.user?.username ?? 'otter',
          requestedByUserId: interaction.user?.id,
        };

        if (rawModelInput.trim() || alertPoolFamily) {
          const parsedMeta = parseDiscordModelPriorityInput(
            rawModelInput,
            this.config.defaultDispatchModel,
            alertPoolFamily
          );
          dispatchPayload.model = parsedMeta.model;
          dispatchPayload.effort = parsedMeta.effort;
          if (alertPoolFamily) {
            dispatchPayload.poolFamily = alertPoolFamily;
          }
        }

        result = await this.options.onDispatchRequested(dispatchPayload);

        const isQueued = result.status === 'queued' || Boolean(result.taskId && !result.branchName);
        if (result.success) {
          if (isQueued) {
            const p = result.priority ?? dispatchPayload.priority ?? 'P1';
            const msg = `[Notice] Continuation task \`#${(result.taskId || '').slice(0, 8)}\` (${p}) queued for \`${repoName || repoId}\` — waiting for swarm runner...`;
            await interaction.editReply({
              content: msg,
            });
          } else {
            const branch = result.branchName ? ` on branch \`${result.branchName}\`` : '';
            const msg = `[Success] Antigravity continuation complete${branch}`.slice(0, 2000);
            await interaction.editReply({
              content: msg,
            });
          }
        } else {
          const errMsg = result.error ? `: ${result.error}` : ': Execution aborted.';
          const prefix =
            result.code === 'OVERAGE_PROTECTION_TRIGGERED'
              ? '[Blocked] Safety Floor'
              : '[Blocked] Task Dispatch';
          const msg = `${prefix}${errMsg}`.slice(0, 2000);
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
      const isQueuedTask =
        result?.status === 'queued' || Boolean(result?.taskId && !result?.branchName);
      if (isQueuedTask && result?.taskId) {
        this.activeInteractions.set(result.taskId, interaction);
        setTimeout(
          () => {
            if (result?.taskId) this.activeInteractions.delete(result.taskId);
            if (repoId) this.activeInteractions.delete(repoId);
            if (repoName) this.activeInteractions.delete(repoName);
          },
          30 * 60 * 1000
        ).unref?.();
      } else {
        if (repoId) this.activeInteractions.delete(repoId);
        if (repoName) this.activeInteractions.delete(repoName);
      }
    }
  }

  /**
   * Automatically discovers and binds the Discord server owner ID if discordOwnerUserId is unset.
   */
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

  async notifyQuotaAlert(alert: QuotaAlert): Promise<void> {
    if (!this.client || !this.initialized) return;

    const channelId = this.config.discordNotificationChannelId;
    if (!channelId || typeof this.client.channels?.fetch !== 'function') return;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased?.()) return;

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
    } catch (err: any) {
      logger.child('notify:discord').error('Failed to notify quota alert: %s', err.message);
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
      const st = String(status.status || status.step || '').toLowerCase();
      if (['completed', 'failed', 'aborted'].includes(st)) {
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

      const st = String(status.status || status.step || '').toLowerCase();
      const isTerminal = ['completed', 'failed', 'aborted'].includes(st);
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
