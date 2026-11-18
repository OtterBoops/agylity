import { useState } from 'preact/hooks';
import { autocompleteForType, normalizeModelId, resolveModelEffort } from '../config/fields';
import type { ConfigData, ReasoningEffort, ToastState } from '../types';
import { deleteConfigOverride } from '../api';
import { clearDraft, configStore, dirtyKeys, saveDrafts, setDraft } from '../state/configStore';
import { useStore } from '../state/store';
import { ProvenanceBadge } from './settings/ProvenanceBadge';
import { StatusBanner } from './StatusBanner';
import { ToggleSwitch } from './ToggleSwitch';

export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'list' | 'select' | 'password' | 'boolean';
  hint?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  onLabel?: string;
  offLabel?: string;
  colSpan?: 1 | 2;
  autocomplete?: string;
}

interface SettingsFormProps {
  title: string;
  description?: string;
  fields: FieldDef[];
  config: ConfigData;
  onSaved: () => void;
  modelOptions?: Array<{ value: string; label: string; supportedEfforts?: ReasoningEffort[] }>;
  searchQuery?: string;
}

const CATALOG_OPTION_KEYS = new Set(['defaultDispatchModel']);

const toDisplay = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  return Array.isArray(value) ? value.join(', ') : String(value);
};

const normalizeValueForField = (
  field: FieldDef,
  rawValue: string,
  modelIds: Array<{ id: string }>
): string =>
  field.key === 'defaultDispatchModel' ? normalizeModelId(rawValue, modelIds) : rawValue;

const autocompleteFor = (field: FieldDef): string =>
  field.autocomplete ?? autocompleteForType(field.type);

const fieldMatches = (field: FieldDef, query: string): boolean => {
  const haystack = [field.label, field.key, field.hint, field.placeholder]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
};

export const SettingsForm = ({
  title,
  description,
  fields,
  config,
  onSaved,
  modelOptions = [],
  searchQuery,
}: SettingsFormProps) => {
  const { drafts, saving } = useStore(configStore);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<ToastState | null>(null);

  const resolved = config.resolved || {};
  const overrides = config.overrides || {};
  const modelIds = modelOptions.map((o) => ({ id: o.value }));
  const modelEfforts = modelOptions.map((o) => ({
    id: o.value,
    supportedEfforts: o.supportedEfforts,
  }));

  const formKeys = fields.map((f) => f.key);
  const formKeySet = new Set(formKeys);
  // Dirty keys compare against the server config: a filtered-out row still counts.
  const formDirtyKeys = dirtyKeys(config).filter((key) => formKeySet.has(key));

  const query = (searchQuery ?? '').trim();
  const visibleFields = query ? fields.filter((f) => fieldMatches(f, query)) : fields;

  const valueOf = (field: FieldDef): string => {
    if (drafts[field.key] !== undefined) return drafts[field.key];
    if (field.type === 'password') return '';
    const source = overrides[field.key] ?? resolved[field.key];
    const raw = toDisplay(source);
    return normalizeValueForField(field, raw, modelIds);
  };

  const optionsFor = (field: FieldDef): Array<{ value: string; label: string }> => {
    const fromCatalog =
      field.options && CATALOG_OPTION_KEYS.has(field.key) && modelOptions.length > 0;
    const options = fromCatalog ? modelOptions : (field.options ?? []);
    // A stored id the catalog no longer offers must still render, or the select goes blank.
    const current = valueOf(field);
    if (current !== '' && !options.some((o) => o.value === current)) {
      return [...options, { value: current, label: `${current} (not offered by agy)` }];
    }
    return options;
  };

  const dispatchModelField = fields.find((f) => f.key === 'defaultDispatchModel');
  const dispatchModelId = dispatchModelField ? valueOf(dispatchModelField) : '';
  // A model with no effort variants must not offer a picker agy would reject with --effort.
  const dispatchEffortLocked =
    dispatchModelId !== '' &&
    resolveModelEffort(modelEfforts, dispatchModelId).supported.length === 0;

  const handleReset = () => {
    for (const key of formKeys) clearDraft(key);
    setToast(null);
  };

  const handleSave = async (e: Event) => {
    e.preventDefault();
    if (formDirtyKeys.length === 0) return;

    setToast(null);
    try {
      await saveDrafts(formKeys);
      setToast({
        type: 'success',
        message: `Saved ${formDirtyKeys.length} setting${formDirtyKeys.length === 1 ? '' : 's'}!`,
      });
      onSaved();
    } catch (err: any) {
      setToast({ type: 'error', message: err?.message || 'Failed to save settings' });
    }
  };

  const handleDropOverride = async (key: string) => {
    try {
      await deleteConfigOverride(key);
      clearDraft(key);
      onSaved();
    } catch (err: any) {
      setToast({ type: 'error', message: err?.message || 'Failed to reset' });
    }
  };

  if (query && visibleFields.length === 0) return null;

  const inputClass =
    'rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text placeholder-pine-subtle transition-colors outline-none focus:border-pine-iris';

  return (
    <form
      onSubmit={handleSave}
      autoComplete="off"
      class="flex flex-col gap-5 rounded-xl border border-pine-highlight bg-pine-surface p-6"
    >
      <div>
        <h2 class="text-lg font-semibold text-pine-text">{title}</h2>
        {description && <p class="mt-0.5 text-xs text-pine-subtle">{description}</p>}
      </div>

      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        {visibleFields.map((f) => {
          const isSecret = f.type === 'password';
          const isConfigured = Boolean(config.secretsMeta?.[f.key]?.isSet || resolved[f.key]);
          const placeholder =
            f.placeholder ??
            (isSecret && isConfigured ? 'Enter new secret to update...' : undefined);
          const isEffortField = f.key === 'defaultDispatchEffort';
          const hintText =
            isEffortField && dispatchEffortLocked
              ? 'This model has no effort variants; agy runs it without --effort.'
              : f.hint;

          return (
            <div
              key={f.key}
              class={`flex flex-col gap-1.5 ${f.colSpan === 2 ? 'md:col-span-2' : ''}`}
            >
              <div class="flex items-center justify-between gap-2 text-xs font-medium text-pine-subtle">
                {f.type === 'boolean' ? (
                  <span class="min-w-0 truncate" title={f.label}>
                    {f.label}
                  </span>
                ) : (
                  <label class="min-w-0 truncate" for={`f-${f.key}`} title={f.label}>
                    {f.label}
                  </label>
                )}
                <span class="flex shrink-0 items-center gap-1.5">
                  <ProvenanceBadge
                    source={config.sources?.[f.key]}
                    isSecretSet={config.secretsMeta?.[f.key]?.isSet}
                    secret={isSecret}
                  />
                  {Object.prototype.hasOwnProperty.call(overrides, f.key) && !isSecret && (
                    <button
                      type="button"
                      class="cursor-pointer text-xs text-pine-subtle transition-colors hover:text-pine-love"
                      onClick={() => handleDropOverride(f.key)}
                    >
                      (reset)
                    </button>
                  )}
                </span>
              </div>
              {f.type === 'boolean' ? (
                <div class="flex items-center gap-3 rounded-lg border border-pine-highlight px-3 py-2">
                  <ToggleSwitch
                    checked={valueOf(f) === 'true'}
                    onChange={(next) => setDraft(f.key, String(next))}
                    label={f.label}
                  />
                  <span class="text-sm text-pine-text">
                    {valueOf(f) === 'true' ? (f.onLabel ?? 'Allowed') : (f.offLabel ?? 'Blocked')}
                  </span>
                </div>
              ) : f.type === 'select' ? (
                <select
                  id={`f-${f.key}`}
                  name={`agylity_cfg_${f.key}`}
                  autoComplete={autocompleteFor(f)}
                  class={`${inputClass} cursor-pointer disabled:cursor-not-allowed disabled:opacity-60`}
                  value={valueOf(f)}
                  disabled={isEffortField && dispatchEffortLocked}
                  onChange={(e) => setDraft(f.key, (e.target as HTMLSelectElement).value)}
                >
                  {optionsFor(f).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : isSecret ? (
                <div class="relative flex items-center">
                  <input
                    id={`f-${f.key}`}
                    name={`agylity_cfg_${f.key}`}
                    type={showSecrets[f.key] ? 'text' : 'password'}
                    autoComplete={autocompleteFor(f)}
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-form-type="other"
                    data-bwignore="true"
                    class={`${inputClass} w-full pr-24 placeholder-pine-subtle`}
                    placeholder={
                      f.placeholder ?? (isConfigured ? 'Enter new secret to update...' : undefined)
                    }
                    value={valueOf(f)}
                    onInput={(e) => setDraft(f.key, (e.target as HTMLInputElement).value)}
                  />
                  <div class="absolute right-2 flex items-center gap-1">
                    {isConfigured && (
                      <button
                        type="button"
                        class="cursor-pointer rounded-sm px-1.5 py-0.5 text-xs font-medium text-pine-subtle transition-colors hover:text-pine-love focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
                        onClick={() => handleDropOverride(f.key)}
                      >
                        Clear
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={showSecrets[f.key] ? `Hide ${f.label}` : `Show ${f.label}`}
                      class="inline-flex min-h-[36px] min-w-[36px] cursor-pointer items-center justify-center px-1.5 py-0.5 text-xs text-pine-subtle transition-colors hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
                      onClick={() =>
                        setShowSecrets({ ...showSecrets, [f.key]: !showSecrets[f.key] })
                      }
                    >
                      {showSecrets[f.key] ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>
              ) : (
                <input
                  id={`f-${f.key}`}
                  name={`agylity_cfg_${f.key}`}
                  type={f.type === 'number' ? 'number' : 'text'}
                  autoComplete={autocompleteFor(f)}
                  data-1p-ignore="true"
                  data-lpignore="true"
                  class={inputClass}
                  placeholder={placeholder}
                  value={valueOf(f)}
                  onInput={(e) => setDraft(f.key, (e.target as HTMLInputElement).value)}
                />
              )}
              {hintText && <p class="text-xs text-pine-subtle">{hintText}</p>}
            </div>
          );
        })}
      </div>

      <div class="flex flex-wrap items-center justify-between gap-4 border-t border-pine-highlight pt-4">
        <div>
          {formDirtyKeys.length > 0 ? (
            <span class="text-xs font-medium text-pine-gold">
              {formDirtyKeys.length} unsaved {formDirtyKeys.length === 1 ? 'change' : 'changes'}
            </span>
          ) : (
            <span class="text-xs text-pine-subtle">
              Clear a field and save to fall back to environment default.
            </span>
          )}
        </div>

        <div class="flex items-center gap-3">
          <button
            type="button"
            onClick={handleReset}
            disabled={saving || formDirtyKeys.length === 0}
            class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-4 py-2 text-xs font-medium text-pine-subtle transition-colors hover:text-pine-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            Reset
          </button>

          <button
            type="submit"
            class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-xs font-semibold text-pine-base transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={saving || formDirtyKeys.length === 0}
          >
            {saving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </div>

      {toast && <StatusBanner status={toast} />}
    </form>
  );
};
