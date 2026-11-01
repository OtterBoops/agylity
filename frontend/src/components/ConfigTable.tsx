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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);

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

  const handleSaveOverride = (e: Event) => {
    e.preventDefault();
    if (!overrideKey.trim()) return;

    setIsSubmitting(true);
    setErrorMessage(null);
    let parsed: any = overrideValue.trim();
    // Guard against Snowflake IEEE-754 precision loss on Discord IDs (16+ digits)
    if (/^\d{16,}$/.test(overrideValue.trim())) {
      parsed = overrideValue.trim();
    } else {
      try {
        parsed = JSON.parse(overrideValue.trim());
      } catch {}
    }

    updateConfig({ [overrideKey.trim()]: parsed })
      .then(() => {
        setOverrideKey('');
        setOverrideValue('');
        onUpdated();
      })
      .catch((err) => setErrorMessage('Failed to save override: ' + (err.message || String(err))))
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
                <tr key={k} class="transition-colors hover:bg-white/2">
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
                      {isOverridden &&
                        (confirmDeleteKey === k ? (
                          <div class="flex items-center gap-1.5">
                            <button
                              type="button"
                              class="cursor-pointer font-medium text-pine-love hover:underline"
                              onClick={() => {
                                deleteConfigOverride(k)
                                  .then(() => {
                                    setConfirmDeleteKey(null);
                                    onUpdated();
                                  })
                                  .catch((err) =>
                                    setErrorMessage(
                                      'Failed to delete override: ' + (err.message || String(err))
                                    )
                                  );
                              }}
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              class="cursor-pointer text-pine-subtle hover:text-pine-text"
                              onClick={() => setConfirmDeleteKey(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            class="cursor-pointer font-medium text-pine-love transition-colors hover:underline"
                            onClick={() => setConfirmDeleteKey(k)}
                          >
                            Reset
                          </button>
                        ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {errorMessage && (
        <div class="rounded-lg border border-pine-love/40 bg-pine-love/10 px-3 py-2 text-xs text-pine-love">
          {errorMessage}
        </div>
      )}

      {/* Edit / Add Override Form */}
      <form
        onSubmit={handleSaveOverride}
        autoComplete="off"
        class="flex flex-wrap items-end gap-3 pt-1"
      >
        <div class="flex min-w-[200px] flex-1 flex-col gap-1.5">
          <label class="text-xs font-medium text-pine-subtle">Setting key</label>
          <input
            type="text"
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
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
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
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
