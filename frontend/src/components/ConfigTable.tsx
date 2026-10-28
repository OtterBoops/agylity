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
    <div class="flex flex-col gap-4">
      <div class="overflow-x-auto rounded-lg border border-pine-highlight bg-pine-base/40">
        <table class="w-full border-collapse text-left text-sm">
          <thead>
            <tr class="border-b border-pine-highlight bg-pine-overlay/40 text-xs font-medium text-pine-subtle">
              <th class="px-4 py-2.5">Setting Key</th>
              <th class="px-4 py-2.5">Resolved Value</th>
              <th class="px-4 py-2.5">Source</th>
              <th class="px-4 py-2.5 text-right">Actions</th>
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
                  <td class="px-4 py-2.5 font-mono text-xs text-pine-iris">{k}</td>
                  <td class="max-w-md px-4 py-2.5 text-xs break-all text-pine-text">
                    {displayVal}
                  </td>
                  <td class="px-4 py-2.5">
                    {isOverridden ? (
                      <span class="font-mono text-xs text-pine-gold">override</span>
                    ) : (
                      <span class="text-xs text-pine-muted">default</span>
                    )}
                  </td>
                  <td class="px-4 py-2.5 text-right">
                    <div class="flex justify-end gap-3 text-xs">
                      <button
                        type="button"
                        class="cursor-pointer font-medium text-pine-subtle transition-colors hover:text-pine-text"
                        onClick={() => handleEditRow(k)}
                      >
                        Edit
                      </button>
                      {isOverridden && (
                        <button
                          type="button"
                          class="cursor-pointer font-medium text-pine-love transition-colors hover:underline"
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

      {/* Edit / Add Override Form */}
      <form onSubmit={handleSaveOverride} class="flex flex-wrap items-end gap-3 pt-1">
        <div class="flex min-w-[200px] flex-1 flex-col gap-1.5">
          <label class="text-xs font-medium text-pine-subtle">Setting key</label>
          <input
            type="text"
            class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs text-pine-text transition-colors outline-none focus:border-pine-iris"
            placeholder="e.g. quotaAlertThresholdPercent"
            value={overrideKey}
            onInput={(e) => setOverrideKey((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="flex min-w-[240px] flex-2 flex-col gap-1.5">
          <label class="text-xs font-medium text-pine-subtle">
            Override value (JSON or string)
          </label>
          <input
            type="text"
            id="overrideValInput"
            class="rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs text-pine-text transition-colors outline-none focus:border-pine-iris"
            placeholder="e.g. 35"
            value={overrideValue}
            onInput={(e) => setOverrideValue((e.target as HTMLInputElement).value)}
          />
        </div>
        <button
          type="submit"
          class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-xs font-semibold text-pine-base shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isSubmitting || !overrideKey.trim()}
        >
          {isSubmitting ? 'Saving...' : 'Apply override'}
        </button>
      </form>
    </div>
  );
};
