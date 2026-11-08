import type { ResolvedConfig } from '../../config/schema.js';
import type { DispatchRequest, DispatchResult, QuotaSnapshot } from '../types.js';
import { logger } from '../../logs/logger.js';
import {
  CANONICAL_AGY_MODELS,
  ReasoningEffortSchema,
  resolveConcreteModelId,
} from '../../coordinator/models.js';
import type { DiscordNotifierOptions } from './types.js';
import { TaskPromptSchema } from './commands.js';
import { renderQuotaEmbed } from './embeds.js';
import { createRepoSelectMenu, createDispatchModal } from './components.js';

// Live context handed to the interaction handlers: the notifier's config, callbacks and shared
export interface DiscordInteractionDeps {
  config: ResolvedConfig;
  options: DiscordNotifierOptions;
  activeInteractions: Map<string, any>;
  activeSubmissions: Set<string>;
  readonly maxActiveInteractions: number;
  readonly interactionRetentionMs: number;
  verifyOwnerBinding(interaction: any): { allowed: boolean; reason?: string };
}

// Components V2 selects submit through getStringSelectValues, not getTextInputValue.
const readStringSelect = (interaction: any, customId: string): string => {
  try {
    return interaction.fields?.getStringSelectValues?.(customId)?.[0] ?? '';
  } catch {
    return '';
  }
};

// Retains a dispatched interaction for status relaying: evicts the oldest entry past the cap and
const retainInteraction = (deps: DiscordInteractionDeps, key: string, interaction: any): void => {
  deps.activeInteractions.set(key, interaction);
  while (deps.activeInteractions.size > deps.maxActiveInteractions) {
    const oldest = deps.activeInteractions.keys().next().value;
    if (oldest === undefined) break;
    deps.activeInteractions.delete(oldest);
  }
  setTimeout(() => deps.activeInteractions.delete(key), deps.interactionRetentionMs).unref?.();
};

// Main interaction dispatcher handling commands, selects, and modals.
export const routeInteraction = async (
  deps: DiscordInteractionDeps,
  interaction: any
): Promise<void> => {
  if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
    if (interaction.commandName === 'quota') {
      await handleQuotaCommand(deps, interaction);
    } else if (interaction.commandName === 'dispatch') {
      await handleDispatchCommand(deps, interaction);
    }
    return;
  }

  if (interaction.isAutocomplete && interaction.isAutocomplete()) {
    await handleAutocomplete(deps, interaction);
    return;
  }

  if (interaction.isStringSelectMenu && interaction.isStringSelectMenu()) {
    if (
      interaction.customId === 'repo_select' ||
      (typeof interaction.customId === 'string' && interaction.customId.startsWith('repo_select:'))
    ) {
      await handleRepoSelect(deps, interaction);
    }
    return;
  }

  if (interaction.isModalSubmit && interaction.isModalSubmit()) {
    if (
      typeof interaction.customId === 'string' &&
      interaction.customId.startsWith('modal_dispatch:')
    ) {
      await handleModalSubmit(deps, interaction);
    }
    return;
  }
};

// Autocomplete is served live from the current config, so the offered choices never go stale
// the way baked-in command choices do (those need a re-register to change).
const handleAutocomplete = async (
  deps: DiscordInteractionDeps,
  interaction: any
): Promise<void> => {
  const focused = interaction.options?.getFocused?.(true);
  const query = String(focused?.value ?? '').toLowerCase();
  const optionName = focused?.name;

  let candidates: Array<{ name: string; value: string }> = [];
  if (optionName === 'repository') {
    candidates = deps.config.repositories.map((r) => ({ name: r.name || r.id, value: r.id }));
  } else if (optionName === 'model') {
    candidates = CANONICAL_AGY_MODELS.map((m) => ({ name: m.id, value: m.id }));
  }

  const filtered = candidates
    .filter((c) => c.name.toLowerCase().includes(query) || c.value.toLowerCase().includes(query))
    .slice(0, 25);

  try {
    await interaction.respond(filtered);
  } catch {
    // An autocomplete response is best-effort and must never surface an error.
  }
};

const handleDispatchCommand = async (
  deps: DiscordInteractionDeps,
  interaction: any
): Promise<void> => {
  const ownerCheck = deps.verifyOwnerBinding(interaction);
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

  const repositoryId = interaction.options?.getString?.('repository') ?? '';
  const prompt = interaction.options?.getString?.('prompt') ?? '';
  const model = interaction.options?.getString?.('model') || undefined;
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

  const onDispatch = deps.options.onDispatchRequested || (deps.options as any).onContinueRequested;
  if (!onDispatch) {
    const errReply = { content: '[Error] Coordinator dispatch callback is not registered.' };
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
      repositoryId,
      repositoryName: repositoryId,
      prompt: prompt.trim(),
      requestedBy,
      requestedByUserId,
      model,
      effort,
    });

    if (result.taskId) {
      retainInteraction(deps, result.taskId, interaction);
    }

    let content = '';
    const isQueued = result.status === 'queued' || Boolean(result.taskId && !result.branchName);
    if (!result.success) {
      content = `[Error] Dispatch failed: ${result.error ?? 'Unknown error'}`;
    } else if (isQueued) {
      content = `[Notice] Continuation task \`#${(result.taskId || '').slice(0, 8)}\` queued for \`${repositoryId}\` — waiting for swarm runner...`;
    } else {
      const branch = result.branchName ? ` on branch \`${result.branchName}\`` : '';
      content = `[Success] Antigravity continuation complete${branch}.`;
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
};

const handleQuotaCommand = async (
  deps: DiscordInteractionDeps,
  interaction: any
): Promise<void> => {
  const ownerCheck = deps.verifyOwnerBinding(interaction);
  if (!ownerCheck.allowed) {
    if (typeof interaction.reply === 'function') {
      await interaction.reply({
        content: ownerCheck.reason,
        ephemeral: true,
      });
    }
    return;
  }

  const allowedChannelId = deps.config.discordNotificationChannelId;
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
  if (deps.options.onQuotaRequested) {
    try {
      snapshots = await deps.options.onQuotaRequested();
    } catch {
      snapshots = [];
    }
  }

  const embed = renderQuotaEmbed(snapshots, deps.config.baseUrl);
  const actionRow = createRepoSelectMenu(deps.config.repositories);

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
};

const handleRepoSelect = async (deps: DiscordInteractionDeps, interaction: any): Promise<void> => {
  const ownerCheck = deps.verifyOwnerBinding(interaction);
  if (!ownerCheck.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
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
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
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

  const repo = deps.config.repositories.find(
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
    defaultModel: deps.config.defaultDispatchModel,
    poolFamily,
  });
  await interaction.showModal(modal);
};

const handleModalSubmit = async (deps: DiscordInteractionDeps, interaction: any): Promise<void> => {
  // 3s Discord timeout guard: defer immediately before async tasks
  try {
    await interaction.deferReply({ ephemeral: false });
  } catch (err: any) {
    logger
      .child('notify:discord')
      .debug('Modal deferReply failed or already acknowledged: %s', err.message);
  }

  const ownerCheck = deps.verifyOwnerBinding(interaction);
  if (!ownerCheck.allowed) {
    await interaction.editReply({
      content: ownerCheck.reason,
    });
    return;
  }

  // Deduplication / Debounce guard for rapid duplicate clicks
  const userId = interaction.user?.id ?? 'user';
  const submissionKey = `${userId}_${interaction.customId}`;
  if (deps.activeSubmissions.has(submissionKey)) {
    await interaction.editReply({
      content: '[Warning] A task is already in progress. Please wait for it to complete.',
    });
    return;
  }
  deps.activeSubmissions.add(submissionKey);

  const rawCustomSuffix =
    typeof interaction.customId === 'string' && interaction.customId.startsWith('modal_dispatch:')
      ? interaction.customId.slice('modal_dispatch:'.length)
      : '';

  const lastColonIdx = rawCustomSuffix.lastIndexOf(':');
  const rawRepoId = lastColonIdx !== -1 ? rawCustomSuffix.slice(0, lastColonIdx) : rawCustomSuffix;
  const alertPoolFamily = lastColonIdx !== -1 ? rawCustomSuffix.slice(lastColonIdx + 1) : undefined;

  const repo = deps.config.repositories.find(
    (r) => r.id === rawRepoId || r.name === rawRepoId || (rawRepoId && r.id.startsWith(rawRepoId))
  );
  const repoId = rawRepoId;
  const repoName = repo?.name ?? rawRepoId;
  const repoPath = repo?.path ?? '';

  let result: DispatchResult | undefined;
  try {
    const rawPrompt = interaction.fields?.getTextInputValue?.('task_prompt') ?? '';
    const selectedModel = readStringSelect(interaction, 'task_model');
    const selectedEffort = readStringSelect(interaction, 'task_effort');
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
    if (repoId) deps.activeInteractions.set(repoId, interaction);
    if (repoName) deps.activeInteractions.set(repoName, interaction);

    if (deps.options.onDispatchRequested) {
      const dispatchPayload: DispatchRequest = {
        repositoryId: repoId,
        repositoryName: repoName,
        repositoryPath: repoPath,
        prompt,
        requestedBy: interaction.user?.username ?? 'otter',
        requestedByUserId: interaction.user?.id,
      };

      if (selectedModel) {
        dispatchPayload.model = resolveConcreteModelId(
          selectedModel,
          deps.config.defaultDispatchModel
        );
      }
      const effortParse = ReasoningEffortSchema.safeParse(selectedEffort);
      if (effortParse.success) {
        dispatchPayload.effort = effortParse.data;
      }
      if (alertPoolFamily) {
        dispatchPayload.poolFamily = alertPoolFamily;
      }

      result = await deps.options.onDispatchRequested(dispatchPayload);

      const isQueued = result.status === 'queued' || Boolean(result.taskId && !result.branchName);
      if (result.success) {
        if (isQueued) {
          const msg = `[Notice] Continuation task \`#${(result.taskId || '').slice(0, 8)}\` queued for \`${repoName || repoId}\` — waiting for swarm runner...`;
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
        `[Notice] Agylity is operating in alerting-first mode. Task dispatch is inactive while swarm runner architecture is finalized.`.slice(
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
    deps.activeSubmissions.delete(submissionKey);
    const isQueuedTask =
      result?.status === 'queued' || Boolean(result?.taskId && !result?.branchName);
    if (isQueuedTask && result?.taskId) {
      deps.activeInteractions.set(result.taskId, interaction);
      setTimeout(
        () => {
          if (result?.taskId) deps.activeInteractions.delete(result.taskId);
          if (repoId) deps.activeInteractions.delete(repoId);
          if (repoName) deps.activeInteractions.delete(repoName);
        },
        30 * 60 * 1000
      ).unref?.();
    } else {
      if (repoId) deps.activeInteractions.delete(repoId);
      if (repoName) deps.activeInteractions.delete(repoName);
    }
  }
};
