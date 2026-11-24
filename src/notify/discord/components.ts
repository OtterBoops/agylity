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

interface DispatchRepositoryOption {
  id: string;
  name: string;
  path?: string;
  description?: string;
}

const buildRepositorySelect = (
  repositories: DispatchRepositoryOption[],
  options: { customId: string; placeholder: string; selectedRepoId?: string }
): StringSelectMenuBuilder => {
  const select = new StringSelectMenuBuilder().setCustomId(options.customId);
  const list = repositories ?? [];

  // Discord rejects a select with zero options, so the empty registry gets a disabled placeholder.
  if (list.length === 0) {
    return select
      .setDisabled(true)
      .setPlaceholder('No repositories configured')
      .addOptions([{ label: 'None', value: 'none' }]);
  }

  const wanted = (options.selectedRepoId ?? '').trim();
  return select
    .setPlaceholder(
      list.length > 25 ? `Select repository (showing 25 of ${list.length})...` : options.placeholder
    )
    .addOptions(
      list.slice(0, 25).map((repo) => {
        const option: { label: string; value: string; description?: string; default?: boolean } = {
          label: (repo.name || repo.id).slice(0, 100),
          value: repo.id.slice(0, 100),
        };
        if (wanted) {
          option.default = repo.id === wanted || repo.name === wanted;
        }
        const desc = (repo.description ?? repo.path ?? '').trim();
        if (desc.length > 0) {
          option.description = desc.slice(0, 100);
        }
        return option;
      })
    );
};

export const createRepoSelectMenu = (
  repositories: DispatchRepositoryOption[],
  poolGroup?: string
): ActionRowBuilder<StringSelectMenuBuilder> =>
  new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    buildRepositorySelect(repositories, {
      customId: poolGroup ? `repo_select:${poolGroup}` : 'repo_select',
      placeholder: 'Select target repository to dispatch task...',
    })
  );

export interface CreateDispatchModalOptions {
  includeModelInput?: boolean;
  defaultModel?: string;
  defaultEffort?: string;
  poolGroup?: string;
  repositories?: DispatchRepositoryOption[];
  selectedRepoId?: string;
}

export const createDispatchModal = (
  repoId?: string | null,
  repoName?: string | null,
  options?: CreateDispatchModalOptions
): ModalBuilder => {
  const boundRepoId = (repoId ?? '').trim();
  const boundRepoName = (repoName ?? '').trim();
  // An unbound modal carries an empty repo slot in its customId (`modal_dispatch[::poolGroup]`):
  // the submit handler reads the repository out of the task_repository select instead.
  const unbound = boundRepoId.length === 0;

  const title = (
    unbound ? 'Dispatch Task' : `Dispatch Task: ${boundRepoName || boundRepoId}`
  ).slice(0, 45);
  const rawCustomId = unbound
    ? options?.poolGroup
      ? `modal_dispatch::${options.poolGroup}`
      : 'modal_dispatch'
    : options?.poolGroup
      ? `modal_dispatch:${boundRepoId}:${options.poolGroup}`
      : `modal_dispatch:${boundRepoId}`;
  const safeCustomId = rawCustomId.slice(0, 100);
  const modal = new ModalBuilder().setCustomId(safeCustomId).setTitle(title);

  if (unbound) {
    modal.addComponents(
      new LabelBuilder().setLabel('Repository').setStringSelectMenuComponent(
        buildRepositorySelect(options?.repositories ?? [], {
          customId: 'task_repository',
          placeholder: 'Select target repository',
          selectedRepoId: options?.selectedRepoId,
        })
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
      opts.poolGroup,
      opts.defaultModel || 'gemini-4-argon'
    );

    const scoped = CANONICAL_AGY_MODELS.filter(
      (m) => !opts.poolGroup || m.poolGroup === opts.poolGroup
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
