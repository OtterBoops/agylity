import { EFFORT_OPTIONS, MODEL_OPTIONS, resolveModelEffort } from '../config/fields';
import type { ModelCatalogEntry, QuotaSnapshot, ReasoningEffort } from '../types';

export interface RepoItem {
  id?: string;
  name: string;
  path?: string;
  cloneUrl?: string;
}

export const FALLBACK_MODELS: ModelOption[] = MODEL_OPTIONS.map((m) => {
  const family: ModelCatalogEntry['family'] = m.value.includes('flash')
    ? 'gemini-flash'
    : m.value.includes('argon')
      ? 'gemini-argon'
      : 'claude';
  return { id: m.value, label: m.label, family };
});

/** `family: null` marks an entry that maps to no known pool, so it claims no headroom. */
export interface ModelOption {
  id: string;
  label: string;
  family: ModelCatalogEntry['family'] | null;
}

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

interface DispatchFormFieldsProps {
  repos: RepoItem[];
  selectedRepo: string;
  onRepoChange: (val: string) => void;
  selectedModel: string;
  onModelChange: (val: string) => void;
  catalogModels: ModelCatalogEntry[];
  quota: QuotaSnapshot[];
  scheduleMode: 'immediate' | 'pre_reset';
  onScheduleModeChange: (val: 'immediate' | 'pre_reset') => void;
  effort: ReasoningEffort;
  onEffortChange: (val: ReasoningEffort) => void;
  requestedBy: string;
  onRequestedByChange: (val: string) => void;
  autoCreatePr: boolean;
  onAutoCreatePrChange: (val: boolean) => void;
  taskPrompt: string;
  onTaskPromptChange: (val: string) => void;
}

export const DispatchFormFields = ({
  repos,
  selectedRepo,
  onRepoChange,
  selectedModel,
  onModelChange,
  catalogModels,
  quota,
  scheduleMode,
  onScheduleModeChange,
  effort,
  onEffortChange,
  requestedBy,
  onRequestedByChange,
  autoCreatePr,
  onAutoCreatePrChange,
  taskPrompt,
  onTaskPromptChange,
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

  return (
    <>
      <div class="flex flex-col gap-1.5">
        <label for="repoSelect" class="text-xs font-medium text-pine-subtle">
          Target Repository
        </label>
        <select
          id="repoSelect"
          name="repositoryId"
          class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
          value={selectedRepo}
          onChange={(e) => onRepoChange((e.target as HTMLSelectElement).value)}
          required
        >
          <option value="">-- Select Pre-Configured Repository --</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} ({r.path || 'default'})
            </option>
          ))}
        </select>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="flex flex-col gap-1.5 sm:col-span-2">
          <label for="modelSelect" class="text-xs font-medium text-pine-subtle">
            Target Model (--model)
          </label>
          <select
            id="modelSelect"
            name="model"
            class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
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
          <label for="scheduleModeSelect" class="text-xs font-medium text-pine-subtle">
            Schedule Mode
          </label>
          <select
            id="scheduleModeSelect"
            name="scheduleMode"
            class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
            value={scheduleMode}
            onChange={(e) =>
              onScheduleModeChange(
                (e.target as HTMLSelectElement).value as 'immediate' | 'pre_reset'
              )
            }
          >
            <option value="immediate">Run Immediately</option>
            <option value="pre_reset">Pre-Reset Window (Opportunistic)</option>
          </select>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="flex flex-col gap-1.5">
          <label for="effortSelect" class="text-xs font-medium text-pine-subtle">
            Reasoning Effort (--effort)
          </label>
          <select
            id="effortSelect"
            name="effort"
            class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
            value={effort}
            onChange={(e) =>
              onEffortChange((e.target as HTMLSelectElement).value as ReasoningEffort)
            }
          >
            {EFFORT_OPTIONS.filter((o) =>
              resolveModelEffort(catalogModels, selectedModel).supported.includes(o.value)
            ).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div class="flex flex-col gap-1.5">
          <label for="requestedByInput" class="text-xs font-medium text-pine-subtle">
            Requested By Identifier
          </label>
          <input
            id="requestedByInput"
            name="requestedBy"
            type="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellcheck={false}
            class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
            value={requestedBy}
            onInput={(e) => onRequestedByChange((e.target as HTMLInputElement).value)}
          />
        </div>
      </div>

      <div class="mt-2 flex items-center gap-2">
        <input
          id="autoCreatePrCheck"
          type="checkbox"
          class="size-4 cursor-pointer rounded-sm border-pine-highlight text-pine-iris focus:ring-pine-iris"
          checked={autoCreatePr}
          onChange={(e) => onAutoCreatePrChange((e.target as HTMLInputElement).checked)}
        />
        <label for="autoCreatePrCheck" class="cursor-pointer text-xs text-pine-text">
          Automatically create Pull Request via{' '}
          <code class="font-mono text-pine-foam">gh pr create</code> on branch push
        </label>
      </div>

      <div class="flex flex-col gap-1.5">
        <label for="taskPromptInput" class="text-xs font-medium text-pine-subtle">
          Task Continuation Prompt / Instructions
        </label>
        <textarea
          id="taskPromptInput"
          name="prompt"
          class="min-h-[121px] rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
          placeholder="e.g. Continue unit test suite implementation on isolated branch..."
          value={taskPrompt}
          onInput={(e) => onTaskPromptChange((e.target as HTMLTextAreaElement).value)}
          required
        />
      </div>
    </>
  );
};
