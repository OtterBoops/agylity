import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
} from 'discord.js';
import {
  CANONICAL_AGY_MODELS,
  resolveConcreteModelId,
  resolveReasoningEffortForModel,
} from '../../orchestrator/models.js';

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
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Enter the exact task instructions for Antigravity continuation...')
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(4000);

  modal.addComponents(
    new LabelBuilder().setLabel('Task Prompt / Objectives').setTextInputComponent(promptInput)
  );

  if (options?.includeModelInput) {
    const initialModel = resolveConcreteModelId(
      options.poolFamily,
      options.defaultModel || 'gemini-4-argon'
    );

    // Offer only the models the target pool can reach, and pre-select the pool's default.
    const scoped = CANONICAL_AGY_MODELS.filter(
      (m) => !options.poolFamily || m.family === options.poolFamily
    );
    const offered = (scoped.length > 0 ? scoped : CANONICAL_AGY_MODELS).slice(0, 25);
    const initialEffort = resolveReasoningEffortForModel(initialModel, undefined);

    const modelSelect = new StringSelectMenuBuilder()
      .setCustomId('task_model')
      .setPlaceholder('Select model')
      .addOptions(
        offered.map((m) => ({
          label: m.id.slice(0, 100),
          value: m.id.slice(0, 100),
          default: m.id === initialModel,
        }))
      );

    // Every effort is listed; the runner clamps to what the chosen model supports.
    const effortSelect = new StringSelectMenuBuilder()
      .setCustomId('task_effort')
      .setPlaceholder('Select reasoning effort')
      .addOptions(
        (['low', 'medium', 'high'] as const).map((effort) => ({
          label: effort,
          value: effort,
          default: effort === initialEffort,
        }))
      );

    modal.addComponents(
      new LabelBuilder().setLabel('Model').setStringSelectMenuComponent(modelSelect),
      new LabelBuilder().setLabel('Reasoning Effort').setStringSelectMenuComponent(effortSelect)
    );
  }

  return modal;
};
