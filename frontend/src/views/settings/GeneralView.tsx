import { useState, useEffect } from 'preact/hooks';
import { faGlobe, faNetworkWired } from '@fortawesome/free-solid-svg-icons';
import type { ConfigData, ToastState } from '../../types';
import { updateConfig, deleteConfigOverride } from '../../api';
import { Icon } from '../../components/Icon';
import { ToggleSwitch } from '../../components/ToggleSwitch';
import { GeneralSettingsCard } from '../../components/GeneralSettingsCard';
import { SettingsLayout } from '../../components/SettingsLayout';
import { StatusBanner } from '../../components/StatusBanner';

interface GeneralViewProps {
  config: ConfigData;
  onChanged: () => void;
}

export const GeneralView = ({ config, onChanged }: GeneralViewProps) => {
  const isCoordinatorEnabled = Boolean(config.resolved?.coordinatorEnabled);
  const [isTogglingCoordinator, setIsTogglingCoordinator] = useState(false);
  const serverBaseUrl = String(config.resolved?.baseUrl || '');
  const [baseUrl, setBaseUrl] = useState(serverBaseUrl);
  const [isSaving, setIsSaving] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  useEffect(() => {
    setBaseUrl(serverBaseUrl);
  }, [serverBaseUrl]);

  const handleToggleCoordinator = async () => {
    setIsTogglingCoordinator(true);
    try {
      await updateConfig({ coordinatorEnabled: !isCoordinatorEnabled });
      onChanged();
    } finally {
      setIsTogglingCoordinator(false);
    }
  };

  const isDirty = baseUrl.trim().replace(/\/+$/, '') !== serverBaseUrl.replace(/\/+$/, '');

  const handleSave = async (e: Event) => {
    e.preventDefault();
    if (!isDirty) return;

    setIsSaving(true);
    setToast(null);

    const value = baseUrl.trim().replace(/\/+$/, '');
    try {
      if (value === '' && config.overrides?.baseUrl !== undefined) {
        await deleteConfigOverride('baseUrl');
        setToast({ type: 'success', message: 'Base URL override cleared.' });
      } else {
        await updateConfig({ baseUrl: value });
        setToast({ type: 'success', message: 'Instance Base URL saved.' });
      }
      onChanged();
    } catch (err: any) {
      setToast({ type: 'error', message: err?.message || 'Failed to save Instance Base URL' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <SettingsLayout>
      <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
        <div class="flex items-center justify-between gap-4">
          <div class="flex min-w-0 flex-1 items-start gap-3">
            <div class="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-pine-highlight bg-pine-overlay/40 text-pine-iris">
              <Icon icon={faNetworkWired} class="size-4.5" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="text-base font-bold text-pine-text">Task Coordinator</h2>
                <span
                  class={`rounded-full border px-2.5 py-0.5 text-xs font-bold tracking-wider whitespace-nowrap uppercase ${
                    isCoordinatorEnabled
                      ? 'border-pine-pine bg-pine-pine/20 text-pine-foam'
                      : 'border-pine-highlight bg-pine-overlay text-pine-subtle'
                  }`}
                >
                  {isCoordinatorEnabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <p class="mt-0.5 text-xs text-pine-subtle">
                Enable or disable autonomous background execution and swarm pull runners. When
                disabled, Agylity operates in pure Quota Sentry mode (monitoring &amp; alerting
                only).
              </p>
            </div>
          </div>

          <div class="flex shrink-0 items-center">
            <ToggleSwitch
              checked={isCoordinatorEnabled}
              disabled={isTogglingCoordinator}
              onChange={handleToggleCoordinator}
              label="Task Coordinator"
            />
          </div>
        </div>
      </div>

      <GeneralSettingsCard />

      <form
        onSubmit={handleSave}
        autoComplete="off"
        class="flex flex-col gap-5 rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm"
      >
        <div class="flex items-start gap-3">
          <div class="flex size-9 shrink-0 items-center justify-center rounded-lg border border-pine-highlight bg-pine-overlay/40 text-pine-iris">
            <Icon icon={faGlobe} class="size-4.5" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-base font-bold text-pine-text">Instance Base URL</h2>
              <span class="rounded-full border border-pine-love/40 bg-pine-love/15 px-2.5 py-0.5 text-xs font-bold tracking-wider whitespace-nowrap text-pine-love uppercase">
                Required
              </span>
            </div>
            <p class="mt-0.5 text-xs text-pine-subtle">
              Canonical public origin for this Agylity instance. Required for dashboard links in
              alert notifications, runner callbacks, and webhook payloads.
            </p>
          </div>
        </div>

        <div class="flex flex-col gap-1.5 border-t border-pine-highlight pt-4">
          <label for="agylity-general-base-url" class="text-xs font-medium text-pine-subtle">
            Public origin
          </label>
          <div class="flex flex-col gap-2 sm:flex-row">
            <input
              id="agylity-general-base-url"
              type="url"
              name="agylity_general_base_url"
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              class="flex-1 rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 font-mono text-sm text-pine-text placeholder-pine-subtle transition-colors outline-none focus:border-pine-iris"
              placeholder="https://agylity.example.com or http://localhost:8484"
              value={baseUrl}
              onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
            />
            <button
              type="submit"
              disabled={isSaving || !isDirty}
              class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-xs font-semibold whitespace-nowrap text-pine-base shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
          <span class="text-xs text-pine-subtle">
            Trailing slashes are stripped. Must be a full origin including scheme and port.
          </span>
        </div>

        {toast && <StatusBanner status={toast} />}
      </form>
    </SettingsLayout>
  );
};
