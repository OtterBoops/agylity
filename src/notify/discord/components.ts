import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
} from 'discord.js';
import {
  ALL_EFFORTS,
  CANONICAL_AGY_MODELS,
  resolveConcreteModelId,
  resolveReasoningEffortForModel,
} from '../../coordinator/models.js';

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

export interface DispatchRepositoryOption {
  id: string;
  name: string;
  path?: string;
  description?: string;
}

export interface CreateDispatchModalOptions {
  includeModelInput?: boolean;
  defaultModel?: string;
  defaultEffort?: string;
  poolFamily?: string;
  repositories?: DispatchRepositoryOption[];
  selectedRepoId?: string;
}

const buildRepositorySelect = (
  repositories: DispatchRepositoryOption[],
  selectedRepoId?: string
): StringSelectMenuBuilder => {
  const select = new StringSelectMenuBuilder().setCustomId('task_repository');
  const list = repositories ?? [];

  // Discord rejects a select with zero options, so the command path guards this case first.
  if (list.length === 0) {
    return select
      .setDisabled(true)
      .setPlaceholder('No repositories configured')
      .addOptions([{ label: 'None', value: 'none' }]);
  }

  const displayRepos = list.slice(0, 25);
  const wanted = (selectedRepoId ?? '').trim();

  return select
    .setPlaceholder(
      list.length > 25
        ? `Select repository (showing 25 of ${list.length})...`
        : 'Select target repository'
    )
    .addOptions(
      displayRepos.map((repo) => {
        const option: { label: string; value: string; description?: string; default?: boolean } = {
          label: (repo.name || repo.id).slice(0, 100),
          value: repo.id.slice(0, 100),
          default: Boolean(wanted) && (repo.id === wanted || repo.name === wanted),
        };
        const desc = (repo.description ?? repo.path ?? '').trim();
        if (desc.length > 0) {
          option.description = desc.slice(0, 100);
        }
        return option;
      })
    );
};

export const createDispatchModal = (
  repoId?: string | null,
  repoName?: string | null,
  options?: CreateDispatchModalOptions
): ModalBuilder => {
  const boundRepoId = (repoId ?? '').trim();
  const boundRepoName = (repoName ?? '').trim();
  // An unbound modal carries an empty repo slot in its customId (`modal_dispatch[::family]`):
  // the submit handler reads the repository out of the task_repository select instead.
  const unbound = boundRepoId.length === 0;

  const title = (
    unbound ? 'Dispatch Task' : `Dispatch Task: ${boundRepoName || boundRepoId}`
  ).slice(0, 45);
  const rawCustomId = unbound
    ? options?.poolFamily
      ? `modal_dispatch::${options.poolFamily}`
      : 'modal_dispatch'
    : options?.poolFamily
      ? `modal_dispatch:${boundRepoId}:${options.poolFamily}`
      : `modal_dispatch:${boundRepoId}`;
  const safeCustomId = rawCustomId.slice(0, 100);
  const modal = new ModalBuilder().setCustomId(safeCustomId).setTitle(title);

  if (unbound) {
    modal.addComponents(
      new LabelBuilder()
        .setLabel('Repository')
        .setStringSelectMenuComponent(
          buildRepositorySelect(options?.repositories ?? [], options?.selectedRepoId)
        )
    );
  }

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

  if (options?.includeModelInput || unbound) {
    const opts = options ?? {};
    const initialModel = resolveConcreteModelId(
      opts.poolFamily,
      opts.defaultModel || 'gemini-4-argon'
    );

    const scoped = CANONICAL_AGY_MODELS.filter(
      (m) => !opts.poolFamily || m.family === opts.poolFamily
    );
    const offered = (scoped.length > 0 ? scoped : CANONICAL_AGY_MODELS).slice(0, 25);
    const initialEffort = resolveReasoningEffortForModel(initialModel, opts.defaultEffort);

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

    const effortSelect = new StringSelectMenuBuilder()
      .setCustomId('task_effort')
      .setPlaceholder('Select reasoning effort')
      .addOptions(
        ALL_EFFORTS.map((effort) => ({
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
