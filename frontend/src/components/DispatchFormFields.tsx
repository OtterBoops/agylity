import {
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  PR_POLICY_OPTIONS,
  resolveModelEffort,
} from '../config/fields';
import type { ModelCatalogEntry, PrPolicy, QuotaSnapshot, ReasoningEffort } from '../types';

export interface RepoItem {
  id?: string;
  name: string;
  path?: string;
  cloneUrl?: string;
}

/** `family: null` marks an entry that maps to no known pool, so it claims no headroom. */
export interface ModelOption {
  id: string;
  label: string;
  family: ModelCatalogEntry['family'] | null;
}

export const FALLBACK_MODELS: ModelOption[] = MODEL_OPTIONS.map((m) => {
  const family: ModelCatalogEntry['family'] = m.value.includes('flash')
    ? 'gemini-flash'
    : m.value.includes('argon')
      ? 'gemini-argon'
      : 'claude';
  return { id: m.value, label: m.label, family };
});

/** Live catalog wins; the bundled list only covers the window before it loads. */
export const resolveModelOptions = (catalogModels: ModelCatalogEntry[]): ModelOption[] =>
  catalogModels.length > 0 ? catalogModels : FALLBACK_MODELS;

export const computePoolHeadroomPct = (pool?: QuotaSnapshot): number | null => {
  if (!pool) return null;
  const fractions = [pool.remainingFraction];
  if (pool.weekly) fractions.push(pool.weekly.remainingFraction);
  if (pool.shortTerm) fractions.push(pool.shortTerm.remainingFraction);
  return Math.round(Math.max(0, Math.min(1, Math.min(...fractions))) * 100);
};

export type TaskCreateMode = 'run' | 'backlog' | 'routine';

const MODE_OPTIONS: Array<{ value: TaskCreateMode; label: string }> = [
  { value: 'run', label: 'Run Now' },
  { value: 'backlog', label: 'Backlog Item' },
  { value: 'routine', label: 'Routine' },
];

const FIELD_CLASS =
  'rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris';
const LABEL_CLASS = 'text-xs font-medium text-pine-subtle';

interface DispatchFormFieldsProps {
  mode: TaskCreateMode;
  onModeChange: (val: TaskCreateMode) => void;
  routinesEnabled: boolean;
  repos: RepoItem[];
  selectedRepo: string;
  onRepoChange: (val: string) => void;
  title: string;
  onTitleChange: (val: string) => void;
  taskPrompt: string;
  onTaskPromptChange: (val: string) => void;
  selectedModel: string;
  onModelChange: (val: string) => void;
  catalogModels: ModelCatalogEntry[];
  quota: QuotaSnapshot[];
  effort: ReasoningEffort;
  onEffortChange: (val: ReasoningEffort) => void;
  prPolicy: PrPolicy;
  onPrPolicyChange: (val: PrPolicy) => void;
  verifyCommand: string;
  onVerifyCommandChange: (val: string) => void;
  priority: string;
  onPriorityChange: (val: string) => void;
  triggerHours: string;
  onTriggerHoursChange: (val: string) => void;
  minHeadroom: string;
  onMinHeadroomChange: (val: string) => void;
}

export const DispatchFormFields = ({
  mode,
  onModeChange,
  routinesEnabled,
  repos,
  selectedRepo,
  onRepoChange,
  title,
  onTitleChange,
  taskPrompt,
  onTaskPromptChange,
  selectedModel,
  onModelChange,
  catalogModels,
  quota,
  effort,
  onEffortChange,
  prPolicy,
  onPrPolicyChange,
  verifyCommand,
  onVerifyCommandChange,
  priority,
  onPriorityChange,
  triggerHours,
  onTriggerHoursChange,
  minHeadroom,
  onMinHeadroomChange,
}: DispatchFormFieldsProps) => {
  const modelOptions = resolveModelOptions(catalogModels);
  // A configured model the live catalog dropped must stay selectable, or the select renders blank.
  // It carries no family, so no pool's headroom is claimed for a model nobody can attribute.
  const visibleModels: ModelOption[] =
    selectedModel !== '' && !modelOptions.some((m) => m.id === selectedModel)
      ? [
          ...modelOptions,
          { id: selectedModel, label: `${selectedModel} (not offered by agy)`, family: null },
        ]
      : modelOptions;

  const supportedEfforts = resolveModelEffort(catalogModels, selectedModel).supported;

  return (
    <>
      <div
        role="group"
        aria-label="New task type"
        class="flex gap-1 rounded-lg border border-pine-highlight bg-pine-overlay/40 p-1"
      >
        {MODE_OPTIONS.filter((option) => option.value !== 'routine' || routinesEnabled).map(
          (option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={mode === option.value}
              onClick={() => onModeChange(option.value)}
              class={`flex-1 cursor-pointer rounded-md px-3 py-1.5 text-xs font-bold whitespace-nowrap uppercase transition-colors ${
                mode === option.value
                  ? 'bg-pine-iris text-pine-base shadow-xs'
                  : 'text-pine-subtle hover:text-pine-text'
              }`}
            >
              {option.label}
            </button>
          )
        )}
      </div>

      <div class="flex flex-col gap-1.5">
        <label for="repoSelect" class={LABEL_CLASS}>
          Repository
        </label>
        <select
          id="repoSelect"
          name="repositoryId"
          class={`cursor-pointer ${FIELD_CLASS}`}
          value={selectedRepo}
          onChange={(e) => onRepoChange((e.target as HTMLSelectElement).value)}
          required
        >
          <option value="">Select a repository</option>
          {repos.map((r) => (
            <option key={r.id ?? r.name} value={r.id ?? r.name}>
              {r.name}
            </option>
          ))}
        </select>
      </div>

      <div class="flex flex-col gap-1.5">
        <label for="taskTitleInput" class={LABEL_CLASS}>
          Title
        </label>
        <input
          id="taskTitleInput"
          name="title"
          type="text"
          autoComplete="off"
          class={FIELD_CLASS}
          placeholder="e.g. Harden quota reset detection"
          value={title}
          onInput={(e) => onTitleChange((e.target as HTMLInputElement).value)}
          required
        />
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="flex flex-col gap-1.5 sm:col-span-2">
          <label for="modelSelect" class={LABEL_CLASS}>
            Model Cascade
          </label>
          <select
            id="modelSelect"
            name="model"
            class={`cursor-pointer ${FIELD_CLASS}`}
            value={selectedModel}
            onChange={(e) => onModelChange((e.target as HTMLSelectElement).value)}
          >
            {visibleModels.map((m) => {
              const live = catalogModels.find((c) => c.id === m.id);
              const pool = m.family
                ? quota.find((q) => q.family === m.family || q.poolId === m.family)
                : undefined;
              const pct = live?.effectiveHeadroomPercent ?? computePoolHeadroomPct(pool);
              const suffix = pct !== null ? ` (${pct}% left)` : '';
              return (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {suffix}
                </option>
              );
            })}
          </select>
        </div>

        <div class="flex flex-col gap-1.5">
          <label for="effortSelect" class={LABEL_CLASS}>
            Effort
          </label>
          <select
            id="effortSelect"
            name="effort"
            class={`cursor-pointer ${FIELD_CLASS}`}
            value={effort}
            onChange={(e) =>
              onEffortChange((e.target as HTMLSelectElement).value as ReasoningEffort)
            }
          >
            {EFFORT_OPTIONS.filter((o) => supportedEfforts.includes(o.value)).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {mode === 'backlog' && (
        <div class="flex flex-col gap-1.5">
          <label for="priorityInput" class={LABEL_CLASS}>
            Priority (lower runs first)
          </label>
          <input
            id="priorityInput"
            name="priorityOrder"
            type="number"
            min={0}
            step={1}
            class={`font-mono ${FIELD_CLASS}`}
            value={priority}
            onInput={(e) => onPriorityChange((e.target as HTMLInputElement).value)}
          />
        </div>
      )}

      {mode === 'routine' && (
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div class="flex flex-col gap-1.5">
            <label for="triggerHoursInput" class={LABEL_CLASS}>
              Trigger Window (hours before reset)
            </label>
            <input
              id="triggerHoursInput"
              name="triggerBeforeResetHours"
              type="number"
              min={1}
              max={24}
              step={1}
              class={`font-mono ${FIELD_CLASS}`}
              value={triggerHours}
              onInput={(e) => onTriggerHoursChange((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="minHeadroomInput" class={LABEL_CLASS}>
              Min Headroom (%)
            </label>
            <input
              id="minHeadroomInput"
              name="minHeadroomPercent"
              type="number"
              min={1}
              max={90}
              step={1}
              class={`font-mono ${FIELD_CLASS}`}
              value={minHeadroom}
              onInput={(e) => onMinHeadroomChange((e.target as HTMLInputElement).value)}
            />
          </div>
        </div>
      )}

      <div class={`grid grid-cols-1 gap-3 ${mode === 'run' ? '' : 'sm:grid-cols-2'}`}>
        {/* runner.ts only enforces a PR policy on agent-tier runs, so an immediate run never reads it. */}
        {mode !== 'run' && (
          <div class="flex flex-col gap-1.5">
            <label for="prPolicySelect" class={LABEL_CLASS}>
              PR Policy
            </label>
            <select
              id="prPolicySelect"
              name="prPolicy"
              class={`cursor-pointer ${FIELD_CLASS}`}
              value={prPolicy}
              onChange={(e) => onPrPolicyChange((e.target as HTMLSelectElement).value as PrPolicy)}
            >
              {PR_POLICY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )}

        <div class="flex flex-col gap-1.5">
          <label for="verifyCommandInput" class={LABEL_CLASS}>
            Verify Command (optional)
          </label>
          <input
            id="verifyCommandInput"
            name="verifyCommand"
            type="text"
            autoComplete="off"
            class={`font-mono ${FIELD_CLASS}`}
            placeholder="npm test"
            value={verifyCommand}
            onInput={(e) => onVerifyCommandChange((e.target as HTMLInputElement).value)}
          />
        </div>
      </div>

      <div class="flex flex-col gap-1.5">
        <label for="taskPromptInput" class={LABEL_CLASS}>
          Prompt
        </label>
        <textarea
          id="taskPromptInput"
          name="prompt"
          class={`min-h-28 ${FIELD_CLASS}`}
          placeholder="Detailed instructions for the autonomous coding agent..."
          value={taskPrompt}
          onInput={(e) => onTaskPromptChange((e.target as HTMLTextAreaElement).value)}
          required
        />
      </div>
    </>
  );
};
