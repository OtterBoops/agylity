import { useState } from 'preact/hooks';
import type { ConfigData, ToastState } from '../types';
import { updateConfig, deleteConfigOverride } from '../api';

export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'list' | 'select' | 'password';
  hint?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
}

interface SettingsFormProps {
  title: string;
  description?: string;
  fields: FieldDef[];
  config: ConfigData;
  onSaved: () => void;
}

const toDisplay = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  return Array.isArray(value) ? value.join(', ') : String(value);
};

const parseValue = (field: FieldDef, raw: string): unknown => {
  if (field.type === 'number') return Number(raw);
  if (field.type === 'list') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return raw;
};

export const SettingsForm = ({
  title,
  description,
  fields,
  config,
  onSaved,
}: SettingsFormProps) => {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const resolved = config.resolved || {};
  const overrides = config.overrides || {};

  const valueOf = (field: FieldDef): string => {
    if (draft[field.key] !== undefined) return draft[field.key];
    if (field.type === 'password') return '';
    const source = overrides[field.key] ?? resolved[field.key];
    return toDisplay(source);
  };

  const dirtyKeys = fields
    .map((f) => f.key)
    .filter((k) => {
      if (draft[k] === undefined) return false;
      const field = fields.find((f) => f.key === k);
      if (field?.type === 'password') {
        return draft[k].trim() !== '';
      }
      return draft[k] !== toDisplay(overrides[k] ?? resolved[k]);
    });

  const handleReset = () => {
    setDraft({});
    setToast(null);
  };

  const handleSave = async (e: Event) => {
    e.preventDefault();
    if (dirtyKeys.length === 0) return;

    setIsSaving(true);
    setToast(null);

    try {
      for (const key of dirtyKeys) {
        const field = fields.find((f) => f.key === key);
        if (!field) continue;

        const raw = draft[key];
        if (field.type === 'password') {
          if (raw.trim() !== '') {
            await updateConfig({ [key]: raw.trim() });
          }
        } else if (raw === '' && overrides[key] !== undefined) {
          await deleteConfigOverride(key);
        } else {
          await updateConfig({ [key]: parseValue(field, raw) });
        }
      }

      setToast({
        type: 'success',
        message: `Saved ${dirtyKeys.length} setting${dirtyKeys.length === 1 ? '' : 's'}!`,
      });
      setDraft({});
      onSaved();
    } catch (err: any) {
      setToast({ type: 'error', message: err?.message || 'Failed to save settings' });
    } finally {
      setIsSaving(false);
    }
  };

  const inputClass =
    'rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris';

  return (
    <form
      onSubmit={handleSave}
      autoComplete="off"
      class="flex flex-col gap-5 rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm"
    >
      {/* Hidden dummy credentials to trap aggressive browser autofill */}
      <input
        type="text"
        style={{ display: 'none' }}
        tabIndex={-1}
        aria-hidden="true"
        autoComplete="off"
      />
      <input
        type="password"
        style={{ display: 'none' }}
        tabIndex={-1}
        aria-hidden="true"
        autoComplete="off"
      />

      <div>
        <h2 class="text-lg font-semibold text-pine-text">{title}</h2>
        {description && <p class="mt-0.5 text-xs text-pine-subtle">{description}</p>}
      </div>

      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        {fields.map((f) => {
          const isSecret = f.type === 'password';
          const isConfigured = Boolean(resolved[f.key]);
          const placeholder =
            f.placeholder ?? (isSecret && isConfigured ? '•••••••• (Encrypted)' : undefined);

          return (
            <div key={f.key} class="flex flex-col gap-1.5">
              <label
                class="flex items-center justify-between text-xs font-medium text-pine-subtle"
                for={`f-${f.key}`}
              >
                <span>{f.label}</span>
                {Object.prototype.hasOwnProperty.call(overrides, f.key) && (
                  <span class="font-mono text-[10px] text-pine-gold">override</span>
                )}
              </label>
              {f.type === 'select' ? (
                <select
                  id={`f-${f.key}`}
                  name={`agylity_cfg_${f.key}`}
                  class={`${inputClass} cursor-pointer`}
                  value={valueOf(f)}
                  onChange={(e) =>
                    setDraft({ ...draft, [f.key]: (e.target as HTMLSelectElement).value })
                  }
                >
                  {f.options?.map((o) => (
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
                    autoComplete="new-password"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-form-type="other"
                    data-bwignore="true"
                    class={`${inputClass} w-full pr-14`}
                    placeholder={
                      f.placeholder ??
                      (isConfigured
                        ? '•••••••• (Encrypted — enter new token to update)'
                        : undefined)
                    }
                    value={valueOf(f)}
                    onInput={(e) =>
                      setDraft({ ...draft, [f.key]: (e.target as HTMLInputElement).value })
                    }
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    class="absolute right-2 cursor-pointer px-2 py-1 text-xs text-pine-subtle transition-colors hover:text-pine-text"
                    onClick={() => setShowSecrets({ ...showSecrets, [f.key]: !showSecrets[f.key] })}
                  >
                    {showSecrets[f.key] ? 'Hide' : 'Show'}
                  </button>
                </div>
              ) : (
                <input
                  id={`f-${f.key}`}
                  name={`agylity_cfg_${f.key}`}
                  type={f.type === 'number' ? 'number' : 'text'}
                  autoComplete="off"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  class={inputClass}
                  placeholder={placeholder}
                  value={valueOf(f)}
                  onInput={(e) =>
                    setDraft({ ...draft, [f.key]: (e.target as HTMLInputElement).value })
                  }
                />
              )}
              {f.hint && <p class="text-xs text-pine-muted sm:text-sm">{f.hint}</p>}
            </div>
          );
        })}
      </div>

      {/* Bottom Action Bar */}
      <div class="flex flex-wrap items-center justify-between gap-4 border-t border-pine-highlight pt-4">
        <div>
          {dirtyKeys.length > 0 ? (
            <span class="text-xs font-medium text-pine-gold">
              {dirtyKeys.length} unsaved {dirtyKeys.length === 1 ? 'change' : 'changes'}
            </span>
          ) : (
            <span class="text-xs text-pine-muted">
              Clear a field and save to fall back to environment default.
            </span>
          )}
        </div>

        <div class="flex items-center gap-3">
          <button
            type="button"
            onClick={handleReset}
            disabled={isSaving || dirtyKeys.length === 0}
            class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-4 py-2 text-xs font-medium text-pine-subtle transition-colors hover:text-pine-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            Reset
          </button>

          <button
            type="submit"
            class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-xs font-semibold text-pine-base shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isSaving || dirtyKeys.length === 0}
          >
            {isSaving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </div>

      {toast && (
        <div
          class={`rounded-lg border p-3 text-xs font-medium ${
            toast.type === 'success'
              ? 'border-pine-pine bg-pine-pine/20 text-pine-foam'
              : 'border-pine-love bg-pine-love/20 text-pine-love'
          }`}
        >
          {toast.message}
        </div>
      )}
    </form>
  );
};
