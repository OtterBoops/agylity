import { type ResolvedConfig } from '../../config/types.js';
import type { DispatchRequest, DispatchResult, QuotaSnapshot } from '../types.js';
import { logger } from '../../logs/logger.js';
import {
  CANONICAL_AGY_MODELS,
  resolveConcreteModelId,
  resolveReasoningEffortForModel,
} from '../../coordinator/models.js';
import type { DiscordNotifierOptions } from './types.js';
import { TaskPromptSchema } from './commands.js';
import { renderQuotaEmbed } from './embeds.js';
import { createRepoSelectMenu, createDispatchModal } from './components.js';

export interface DiscordInteractionDeps {
  config: ResolvedConfig;
  options: DiscordNotifierOptions;
  activeInteractions: Map<string, any>;
  activeSubmissions: Set<string>;
  readonly maxActiveInteractions: number;
  readonly interactionRetentionMs: number;
  verifyOwnerBinding(interaction: any): { allowed: boolean; reason?: string };
}

const NO_REPOSITORIES_NOTICE =
  '[Notice] No repositories are currently configured. Please configure repositories in settings.';

const isQueuedResult = (result: {
  status?: string;
  taskId?: string;
  branchName?: string;
}): boolean => result.status === 'queued' || Boolean(result.taskId && !result.branchName);

// Components V2 selects submit through getStringSelectValues, not getTextInputValue.
const readStringSelect = (interaction: any, customId: string): string => {
  try {
    return interaction.fields?.getStringSelectValues?.(customId)?.[0] ?? '';
  } catch {
    return '';
  }
};

const retainInteraction = (deps: DiscordInteractionDeps, key: string, interaction: any): void => {
  deps.activeInteractions.set(key, interaction);
  while (deps.activeInteractions.size > deps.maxActiveInteractions) {
    const oldest = deps.activeInteractions.keys().next().value;
    if (oldest === undefined) break;
    deps.activeInteractions.delete(oldest);
  }
  setTimeout(() => {
    if (deps.activeInteractions.get(key) === interaction) deps.activeInteractions.delete(key);
  }, deps.interactionRetentionMs).unref?.();
};

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
      (interaction.customId === 'modal_dispatch' ||
        interaction.customId.startsWith('modal_dispatch:'))
    ) {
      await handleModalSubmit(deps, interaction);
    }
    return;
  }
};

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
  } catch {}
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

  const repositoryId = String(interaction.options?.getString?.('repository') ?? '');
  const prompt = String(interaction.options?.getString?.('prompt') ?? '');
  const model = interaction.options?.getString?.('model') || undefined;
  const effort = interaction.options?.getString?.('effort') || undefined;

  const ephemeralReply = async (content: string): Promise<void> => {
    if (typeof interaction.reply === 'function') {
      await interaction.reply({ content, ephemeral: true });
    }
  };

  // showModal has to land before any deferReply — an interaction can only be acknowledged once.
  if (!prompt.trim()) {
    const repositories = deps.config.repositories ?? [];
    if (repositories.length === 0) {
      await ephemeralReply(NO_REPOSITORIES_NOTICE);
      return;
    }

    const wantedRepo = repositoryId.trim();
    const preselected = repositories.find((r) => r.id === wantedRepo || r.name === wantedRepo);
    await interaction.showModal(
      createDispatchModal(null, null, {
        includeModelInput: true,
        defaultModel: model || deps.config.defaultDispatchModel,
        defaultEffort: effort || deps.config.defaultDispatchEffort,
        repositories,
        selectedRepoId: preselected?.id ?? '',
      })
    );
    return;
  }

  if (!repositoryId.trim()) {
    await ephemeralReply('[Error] Repository is required when the prompt is given inline.');
    return;
  }

  const canDefer = typeof interaction.deferReply === 'function';
  if (canDefer) {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch {}
  }

  const onDispatch = deps.options.onDispatchRequested || deps.options.onContinueRequested;
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
      cascade: model
        ? [{ model, effort: resolveReasoningEffortForModel(model, effort) }]
        : undefined,
    });

    if (result.taskId) {
      retainInteraction(deps, result.taskId, interaction);
    }

    let content = '';
    const isQueued = isQueuedResult(result);
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
    } catch {}
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
      } catch {}
    }
    return;
  }

  const selectedRepoId = interaction.values?.[0];
  if (!selectedRepoId || selectedRepoId === 'none') {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({
          content: NO_REPOSITORIES_NOTICE,
          ephemeral: true,
        });
      } catch {}
    }
    return;
  }

  const poolGroup =
    typeof interaction.customId === 'string' && interaction.customId.startsWith('repo_select:')
      ? interaction.customId.slice('repo_select:'.length)
      : undefined;

  // Every dispatch entry point opens the same 4-field modal; the selected repo is only a default.
  const modal = createDispatchModal(null, null, {
    includeModelInput: true,
    defaultModel: deps.config.defaultDispatchModel,
    defaultEffort: deps.config.defaultDispatchEffort,
    poolGroup,
    repositories: deps.config.repositories,
    selectedRepoId,
  });
  await interaction.showModal(modal);
};

const handleModalSubmit = async (deps: DiscordInteractionDeps, interaction: any): Promise<void> => {
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

  const rawCustomSuffix =
    typeof interaction.customId === 'string' && interaction.customId.startsWith('modal_dispatch:')
      ? interaction.customId.slice('modal_dispatch:'.length)
      : '';

  const lastColonIdx = rawCustomSuffix.lastIndexOf(':');
  let rawRepoId = lastColonIdx !== -1 ? rawCustomSuffix.slice(0, lastColonIdx) : rawCustomSuffix;
  const alertPoolPoolGroup =
    lastColonIdx !== -1 ? rawCustomSuffix.slice(lastColonIdx + 1) : undefined;

  // An empty repo slot (`modal_dispatch`, `modal_dispatch::<poolGroup>`) means the universal modal,
  // whose repository arrives as a select field.
  if (!rawRepoId) {
    rawRepoId = readStringSelect(interaction, 'task_repository');
  }
  if (rawRepoId === 'none') rawRepoId = '';

  const repo = deps.config.repositories.find(
    (r) => r.id === rawRepoId || r.name === rawRepoId || (rawRepoId && r.id.startsWith(rawRepoId))
  );
  const repoId = rawRepoId;
  const repoName = repo?.name ?? rawRepoId;
  const repoPath = repo?.path ?? '';

  if (!repoId) {
    await interaction.editReply({ content: '[Error] Task repository is required.' });
    return;
  }

  const userId = interaction.user?.id ?? 'user';
  const submissionKey = `${userId}_${interaction.customId}`;
  if (deps.activeSubmissions.has(submissionKey)) {
    await interaction.editReply({
      content: '[Warning] A task is already in progress. Please wait for it to complete.',
    });
    return;
  }
  deps.activeSubmissions.add(submissionKey);

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

    if (repoId) deps.activeInteractions.set(repoId, interaction);
    if (repoName) deps.activeInteractions.set(repoName, interaction);

    if (deps.options.onDispatchRequested) {
      const dispatchPayload: DispatchRequest = {
        repositoryId: repoId,
        repositoryName: repoName,
        repositoryPath: repoPath,
        prompt,
        requestedBy: interaction.user?.username ?? 'Discord User',
        requestedByUserId: interaction.user?.id,
      };

      if (selectedModel) {
        const concrete = resolveConcreteModelId(selectedModel, deps.config.defaultDispatchModel);
        dispatchPayload.cascade = [
          { model: concrete, effort: resolveReasoningEffortForModel(concrete, selectedEffort) },
        ];
      }
      if (alertPoolPoolGroup) {
        dispatchPayload.poolGroup = alertPoolPoolGroup;
      }

      result = await deps.options.onDispatchRequested(dispatchPayload);

      const isQueued = isQueuedResult(result);
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
    } catch {}
  } finally {
    deps.activeSubmissions.delete(submissionKey);
    const isQueuedTask = result !== undefined && isQueuedResult(result);
    if (isQueuedTask && result?.taskId) {
      retainInteraction(deps, result.taskId, interaction);
      if (repoId) retainInteraction(deps, repoId, interaction);
      if (repoName) retainInteraction(deps, repoName, interaction);
    } else {
      if (repoId) deps.activeInteractions.delete(repoId);
      if (repoName) deps.activeInteractions.delete(repoName);
    }
  }
};
