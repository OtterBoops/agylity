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
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n) && n > 0);
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
  const [toast, setToast] = useState<ToastState | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const resolved = config.resolved || {};
  const overrides = config.overrides || {};
  const valueOf = (f: FieldDef) => {
    if (f.key in draft) return draft[f.key];
    if (f.type === 'password') return '';
    return toDisplay(resolved[f.key]);
  };
  const dirtyKeys = Object.keys(draft);

  const handleSave = (e: Event) => {
    e.preventDefault();
    setIsSaving(true);
    setToast(null);

    const toSet: Record<string, unknown> = {};
    const toReset: string[] = [];
    for (const f of fields) {
      if (!(f.key in draft)) continue;
      const raw = draft[f.key]!.trim();
      if (raw === '') toReset.push(f.key);
      else toSet[f.key] = parseValue(f, raw);
    }

    const tasks: Promise<unknown>[] = [];
    if (Object.keys(toSet).length > 0) tasks.push(updateConfig(toSet));
    for (const key of toReset) tasks.push(deleteConfigOverride(key));

    Promise.all(tasks)
      .then(() => {
        setDraft({});
        setToast({ type: 'success', message: 'Saved successfully.' });
        onSaved();
      })
      .catch((err) => setToast({ type: 'error', message: err.message || 'Network error' }))
      .finally(() => setIsSaving(false));
  };

  const inputClass =
    'bg-pine-overlay border border-pine-highlight text-pine-text rounded-lg px-3 py-2 text-sm outline-none focus:border-pine-iris transition-colors';

  return (
    <form
      onSubmit={handleSave}
      class="mb-8 flex flex-col gap-5 rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm"
    >
      <div>
        <h2 class="text-lg font-semibold text-pine-text">{title}</h2>
        {description && <p class="mt-0.5 text-xs text-pine-subtle">{description}</p>}
      </div>

      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        {fields.map((f) => {
          const isSecret = f.type === 'password';
          const isConfigured = Boolean(resolved[f.key]);
          const placeholder =
            f.placeholder ??
            (isSecret && isConfigured ? '•••••••• (Encrypted in SQLite)' : undefined);

          return (
            <div key={f.key} class="flex flex-col gap-1.5">
              <label
                class="flex items-center justify-between text-xs font-medium text-pine-subtle"
                for={`f-${f.key}`}
              >
                <span class="flex items-center gap-1.5">
                  {f.label}
                  {isSecret && <span class="text-[10px] text-pine-foam">🔒</span>}
                </span>
                {Object.prototype.hasOwnProperty.call(overrides, f.key) && (
                  <span class="text-[10px] font-semibold tracking-wider text-pine-gold uppercase">
                    SQLite override
                  </span>
                )}
              </label>
              {f.type === 'select' ? (
                <select
                  id={`f-${f.key}`}
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
              ) : (
                <input
                  id={`f-${f.key}`}
                  type={
                    f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text'
                  }
                  class={inputClass}
                  placeholder={placeholder}
                  value={valueOf(f)}
                  onInput={(e) =>
                    setDraft({ ...draft, [f.key]: (e.target as HTMLInputElement).value })
                  }
                />
              )}
              {f.hint && <p class="text-[11px] text-pine-muted">{f.hint}</p>}
            </div>
          );
        })}
      </div>

      <div class="flex items-center justify-between gap-3">
        <p class="text-[11px] text-pine-muted">
          Clear a field and save to fall back to the environment variable or default.
        </p>
        <button
          type="submit"
          class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-sm font-semibold text-pine-base shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
          disabled={isSaving || dirtyKeys.length === 0}
        >
          {isSaving ? 'Saving...' : `Save${dirtyKeys.length ? ` (${dirtyKeys.length})` : ''}`}
        </button>
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
