import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { resolveConcreteModelId } from '../../orchestrator/models.js';

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
