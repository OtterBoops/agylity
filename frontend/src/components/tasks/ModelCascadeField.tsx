import { faArrowDown, faArrowUp, faXmark } from '@fortawesome/free-solid-svg-icons';
import {
  EFFORT_CODES,
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  resolveModelEffort,
} from '../../config/fields';
import { useModelCatalog } from '../../state/modelCatalogStore';
import type { CascadeHop, ModelCatalogEntry, ReasoningEffort } from '../../types';
import { modelSupportsEffort } from '../../../../src/shared/models.ts';
import { Icon } from '../Icon';

const DEFAULT_HINT = 'Evaluated in order; the first pool above the floor wins.';

interface ModelCascadeFieldProps {
  value: CascadeHop[];
  onChange: (next: CascadeHop[]) => void;
  label?: string;
  hint?: string;
  id?: string;
}

const EFFORT_LABELS = new Map(EFFORT_OPTIONS.map((option) => [option.value, option.label]));

const EFFORT_ORDER = new Map(EFFORT_OPTIONS.map((option, index) => [option.value, index]));

const labelFor = (effort: ReasoningEffort): string => EFFORT_LABELS.get(effort) ?? effort;

export const modelChainLabel = (cascade: CascadeHop[]): string => {
  const primary = cascade[0];
  if (!primary) return 'no model';
  // Effort is still stored for effortless models, but the runner never passes it — don't print it.
  const effort = modelSupportsEffort(primary.model)
    ? ` · ${EFFORT_CODES[primary.effort] ?? primary.effort}`
    : '';
  const base = `${primary.model}${effort}`;
  const extra = cascade.length - 1;
  return extra > 0 ? `${base} (+${extra})` : base;
};

interface CascadeOption {
  id: string;
  label: string;
  headroom: number | null;
}

const chipButtonClass =
  'inline-flex min-h-8 min-w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-pine-muted transition-colors hover:bg-pine-highlight/40 hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-30';

const addChipClass =
  'min-h-8 cursor-pointer rounded-md border border-dashed border-pine-highlight px-2 text-xs font-medium whitespace-nowrap text-pine-subtle transition-colors hover:border-pine-iris/60 hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden';

const staticEffortClass =
  'flex min-h-9 shrink-0 items-center rounded-md border border-pine-highlight bg-pine-base/40 px-2 text-xs font-medium text-pine-muted';

const effortsFor = (modelId: string, current: ReasoningEffort, catalog: ModelCatalogEntry[]) => {
  const supported = resolveModelEffort(catalog, modelId).supported;
  // Empty must stay empty: appending `current` would fake a one-item effort control.
  return supported.length === 0
    ? []
    : supported.includes(current)
      ? supported
      : [...supported, current];
};

const orderedEfforts = (efforts: ReasoningEffort[]): ReasoningEffort[] =>
  [...efforts].sort((a, b) => (EFFORT_ORDER.get(a) ?? 0) - (EFFORT_ORDER.get(b) ?? 0));

const EffortPills = ({
  name,
  efforts,
  value,
  onChange,
}: {
  name: string;
  efforts: ReasoningEffort[];
  value: ReasoningEffort;
  onChange: (next: ReasoningEffort) => void;
}) => (
  <div
    role="group"
    aria-label={`${name} effort`}
    class="flex shrink-0 flex-wrap items-center gap-0.5 rounded-md border border-pine-highlight bg-pine-base/40 p-0.5"
  >
    {efforts.map((effort) => {
      const active = effort === value;
      return (
        <button
          key={effort}
          type="button"
          aria-pressed={active}
          onClick={() => onChange(effort)}
          class={`min-h-7 cursor-pointer rounded-sm px-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
            active ? 'bg-pine-iris/15 text-pine-iris' : 'text-pine-subtle hover:text-pine-text'
          }`}
        >
          {labelFor(effort)}
        </button>
      );
    })}
  </div>
);

const EffortFixed = ({ effort }: { effort: ReasoningEffort }) => (
  <span class={staticEffortClass}>{labelFor(effort)}</span>
);

/** Dispatch walks the list until a pool clears its floor, so row order is the whole point. */
export const ModelCascadeField = ({
  value,
  onChange,
  label = 'Model Cascade',
  hint = DEFAULT_HINT,
  id = 'modelCascadeInput',
}: ModelCascadeFieldProps) => {
  const catalog = useModelCatalog();

  const options: CascadeOption[] =
    catalog.models.length > 0
      ? catalog.models.map((model) => ({
          id: model.id,
          label: model.label,
          headroom: model.effectiveHeadroomPercent,
        }))
      : MODEL_OPTIONS.map((model) => ({ id: model.value, label: model.label, headroom: null }));
  const byId = new Map(options.map((option) => [option.id, option]));
  const labelOf = (modelId: string) => byId.get(modelId)?.label ?? modelId;
  const headroomOf = (modelId: string) => byId.get(modelId)?.headroom ?? null;

  const inChain = new Set(value.map((hop) => hop.model));
  const remaining = options.filter((option) => !inChain.has(option.id));

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    onChange(next);
  };

  const remove = (index: number) => onChange(value.filter((_, i) => i !== index));

  const setEffort = (index: number, effort: ReasoningEffort) =>
    onChange(value.map((hop, i) => (i === index ? { ...hop, effort } : hop)));

  const add = (modelId: string) => {
    if (inChain.has(modelId)) return;
    const seeded = resolveModelEffort(catalog.models, modelId).defaultEffort;
    onChange([...value, { model: modelId, effort: seeded }]);
  };

  return (
    <div id={id} class="flex flex-col gap-1.5">
      <span id={`${id}-label`} class="text-xs font-medium text-pine-subtle">
        {label}
      </span>

      {value.length > 0 ? (
        <ol
          aria-labelledby={`${id}-label`}
          class="flex flex-col gap-1 rounded-lg border border-pine-highlight bg-pine-base/40 p-1"
        >
          {value.map((hop, index) => {
            const name = labelOf(hop.model);
            const headroom = headroomOf(hop.model);
            const efforts = orderedEfforts(effortsFor(hop.model, hop.effort, catalog.models));
            const fixed = efforts.length === 1;
            const hasChoices = efforts.length > 1;
            return (
              <li
                key={`${hop.model}-${index}`}
                class="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-pine-overlay px-2 py-1"
              >
                <span class="w-4 shrink-0 font-mono text-xs text-pine-subtle">{index + 1}.</span>
                <span class="min-w-0 flex-1 truncate text-xs font-medium text-pine-text">
                  {name}
                </span>
                {headroom !== null && (
                  <span class="shrink-0 font-mono text-xs whitespace-nowrap text-pine-subtle">
                    {headroom}%
                  </span>
                )}
                <span class="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
                  {fixed ? (
                    <EffortFixed effort={efforts[0]} />
                  ) : (
                    hasChoices && (
                      <EffortPills
                        name={name}
                        efforts={efforts}
                        value={hop.effort}
                        onChange={(effort) => setEffort(index, effort)}
                      />
                    )
                  )}
                  <span class="ml-auto flex items-center sm:ml-0">
                    <button
                      type="button"
                      class={chipButtonClass}
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      aria-label={`Move ${name} up`}
                    >
                      <Icon icon={faArrowUp} class="size-3" />
                    </button>
                    <button
                      type="button"
                      class={chipButtonClass}
                      onClick={() => move(index, 1)}
                      disabled={index === value.length - 1}
                      aria-label={`Move ${name} down`}
                    >
                      <Icon icon={faArrowDown} class="size-3" />
                    </button>
                    <button
                      type="button"
                      class={chipButtonClass}
                      onClick={() => remove(index)}
                      aria-label={`Remove ${name} from the chain`}
                    >
                      <Icon icon={faXmark} class="size-3" />
                    </button>
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p class="text-xs text-pine-subtle">
          No models in the chain yet — dispatch uses the default model.
        </p>
      )}

      {remaining.length > 0 && (
        <div
          role="group"
          aria-label="Add a model to the chain"
          class="flex flex-wrap items-center gap-1.5"
        >
          {remaining.map((option) => (
            <button
              key={option.id}
              type="button"
              class={addChipClass}
              onClick={() => add(option.id)}
              aria-label={`Add ${option.label} to the chain`}
            >
              {`+ ${option.label}`}
              {option.headroom !== null && ` · ${option.headroom}%`}
            </button>
          ))}
        </div>
      )}

      <p class="text-xs text-pine-subtle">{hint}</p>
    </div>
  );
};
