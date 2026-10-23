import { useState } from 'preact/hooks';
import type { ConfigData } from '../types';
import { updateConfig, deleteConfigOverride } from '../api';

interface ConfigTableProps {
  config: ConfigData;
  onUpdated: () => void;
}

export const ConfigTable = ({ config, onUpdated }: ConfigTableProps) => {
  const [overrideKey, setOverrideKey] = useState('');
  const [overrideValue, setOverrideValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resolved = config.resolved || {};
  const overrides = config.overrides || {};
  const keys = Object.keys(resolved).sort();

  const handleEditRow = (key: string) => {
    const val = resolved[key];
    setOverrideKey(key);
    setOverrideValue(
      typeof val === 'object' && val !== null
        ? JSON.stringify(val)
        : val !== undefined
          ? String(val)
          : ''
    );
    const input = document.getElementById('overrideValInput');
    if (input) {
      input.focus();
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const handleDeleteOverride = (key: string) => {
    if (!confirm(`Reset setting "${key}" back to environment variable or built-in default?`))
      return;
    deleteConfigOverride(key)
      .then(() => onUpdated())
      .catch((err) => alert('Failed to delete override: ' + err.message));
  };

  const handleSaveOverride = (e: Event) => {
    e.preventDefault();
    if (!overrideKey.trim()) return;

    setIsSubmitting(true);
    let parsed: any = overrideValue.trim();
    try {
      parsed = JSON.parse(overrideValue.trim());
    } catch {}

    updateConfig({ [overrideKey.trim()]: parsed })
      .then(() => {
        setOverrideKey('');
        setOverrideValue('');
        onUpdated();
      })
      .catch((err) => alert('Failed to save override: ' + err.message))
      .finally(() => setIsSubmitting(false));
  };

  return (
    <div class="mb-8">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-xl font-semibold text-pine-text">SQLite Configuration Overrides</h2>
        <span class="text-xs text-pine-muted">
          Hierarchy: SQLite UI Overrides &gt; Environment Variables (.env) &gt; Built-in Defaults
        </span>
      </div>

      <div class="mb-6 overflow-hidden rounded-xl border border-pine-highlight bg-pine-surface shadow-sm">
        <div class="overflow-x-auto">
          <table class="w-full border-collapse text-left text-sm">
            <thead>
              <tr class="border-b border-pine-highlight bg-pine-overlay text-pine-subtle">
                <th class="px-4 py-3 font-semibold">Setting Key</th>
                <th class="px-4 py-3 font-semibold">Resolved Value</th>
                <th class="px-4 py-3 font-semibold">Source</th>
                <th class="px-4 py-3 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody id="configTableBody" class="divide-y divide-pine-highlight/40">
              {keys.map((k) => {
                const isOverridden = Object.prototype.hasOwnProperty.call(overrides, k);
                const val = resolved[k];
                const displayVal =
                  typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val ?? '');

                return (
                  <tr key={k} class="transition-colors hover:bg-white/[0.02]">
                    <td class="px-4 py-3 font-mono text-xs text-pine-iris">
                      <span class="rounded bg-pine-overlay px-1.5 py-0.5">{k}</span>
                    </td>
                    <td class="max-w-md px-4 py-3 break-all text-pine-text">{displayVal}</td>
                    <td class="px-4 py-3">
                      {isOverridden ? (
                        <span class="rounded border border-pine-gold bg-pine-gold/20 px-2 py-0.5 text-[11px] font-bold tracking-wider text-pine-gold uppercase">
                          SQLite Override
                        </span>
                      ) : (
                        <span class="text-xs text-pine-muted">Default / Env</span>
                      )}
                    </td>
                    <td class="px-4 py-3 text-right">
                      <div class="flex justify-end gap-2">
                        <button
                          type="button"
                          class="cursor-pointer rounded-md border border-pine-highlight bg-pine-overlay px-2.5 py-1 text-xs font-medium text-pine-text transition-colors hover:bg-pine-highlight/50"
                          onClick={() => handleEditRow(k)}
                        >
                          Edit
                        </button>
                        {isOverridden && (
                          <button
                            type="button"
                            class="cursor-pointer rounded-md border border-pine-love/30 bg-pine-love/15 px-2.5 py-1 text-xs font-medium text-pine-love transition-colors hover:bg-pine-love hover:text-white"
                            onClick={() => handleDeleteOverride(k)}
                          >
                            Reset
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit / Add Override Form */}
      <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
        <h3 class="mb-3 text-sm font-semibold text-pine-text">Set SQLite Configuration Override</h3>
        <form onSubmit={handleSaveOverride} class="flex flex-wrap items-end gap-3">
          <div class="flex min-w-[220px] flex-1 flex-col gap-1.5">
            <label class="text-xs font-medium text-pine-subtle">Setting Key</label>
            <input
              type="text"
              class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
              placeholder="e.g. quotaAlertThresholdPercent"
              value={overrideKey}
              onInput={(e) => setOverrideKey((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="flex min-w-[280px] flex-2 flex-col gap-1.5">
            <label class="text-xs font-medium text-pine-subtle">New Value (JSON or string)</label>
            <input
              type="text"
              id="overrideValInput"
              class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris"
              placeholder="e.g. 35"
              value={overrideValue}
              onInput={(e) => setOverrideValue((e.target as HTMLInputElement).value)}
            />
          </div>
          <button
            type="submit"
            class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-sm font-semibold text-pine-base shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
            disabled={isSubmitting || !overrideKey.trim()}
          >
            {isSubmitting ? 'Saving...' : '💾 Apply Override'}
          </button>
        </form>
      </div>
    </div>
  );
};
