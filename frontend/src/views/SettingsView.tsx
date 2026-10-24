import { useState } from 'preact/hooks';
import type { ConfigData, ToastState } from '../types';
import type { Route } from '../router';
import { SettingsForm, type FieldDef } from '../components/SettingsForm';
import { RepoEditor } from '../components/RepoEditor';
import { ConfigTable } from '../components/ConfigTable';
import { NotificationsView } from './NotificationsView';
import { updateConfig } from '../api';

interface SettingsViewProps {
  route: Route;
  config: ConfigData;
  onChanged: () => void;
}

// Sentry & Quota Tuning (Includes Antigravity RPC and overcharge safeguards)
const SENTRY_FIELDS: FieldDef[] = [
  {
    key: 'quotaCheckIntervalSeconds',
    label: 'Polling interval (seconds)',
    type: 'number',
    hint: 'How often to check rolling quota (default: 900s = 15m).',
  },
  {
    key: 'quotaMilestoneHours',
    label: 'Alert milestones (hours before reset)',
    type: 'list',
    placeholder: '24, 12, 3',
    hint: 'Comma-separated hours before reset to trigger warnings.',
  },
  {
    key: 'minDispatchHeadroomPercent',
    label: 'AI safety floor (%)',
    type: 'number',
    hint: 'Block dispatches when quota <= this floor to prevent paid overages (default: 10). Set to 0 if overages do not apply.',
  },
  {
    key: 'quotaAlertThresholdPercent',
    label: 'Alert quota threshold (%)',
    type: 'number',
    hint: 'Only fire milestones if at least this much quota remains unused (default: 25).',
  },
  {
    key: 'antigravityEndpointUrl',
    label: 'Language Server RPC URL',
    type: 'text',
    placeholder: 'http://127.0.0.1:60643',
    hint: 'Custom Antigravity Language Server Connect-RPC URL (optional).',
  },
  {
    key: 'antigravityLsPort',
    label: 'Language Server Port',
    type: 'number',
    placeholder: '60643',
    hint: 'Primary Language Server port (default: 60643, fallback: 60642).',
  },
  {
    key: 'antigravityCsrfToken',
    label: 'CSRF Token (x-codeium-csrf-token)',
    type: 'password',
    hint: '🔒 Encrypted with AES-256-GCM in SQLite. Connect-RPC authentication token.',
  },
  {
    key: 'quotaStateFilePath',
    label: 'State persistence file path',
    type: 'text',
    placeholder: 'data/state.json',
    hint: 'State file for milestone alert deduplication.',
  },
];

export const SettingsView = ({ route, config, onChanged }: SettingsViewProps) => {
  const [showRawTable, setShowRawTable] = useState(false);
  const [isUpdatingOrchestrator, setIsUpdatingOrchestrator] = useState(false);
  const [orchestratorToast, setOrchestratorToast] = useState<ToastState | null>(null);

  const resolved = config.resolved || {};
  const isOrchestratorEnabled = Boolean(resolved.orchestratorEnabled);

  const handleToggleOrchestrator = async () => {
    setIsUpdatingOrchestrator(true);
    setOrchestratorToast(null);

    const nextState = !isOrchestratorEnabled;
    try {
      await updateConfig({ orchestratorEnabled: nextState });
      setOrchestratorToast({
        type: 'success',
        message: nextState
          ? 'Orchestrator enabled! Task continuation and worker routing are now active.'
          : 'Orchestrator disabled. Agylity is running strictly in alerting-only mode.',
      });
      onChanged();
    } catch (err: any) {
      setOrchestratorToast({
        type: 'error',
        message: err?.message || 'Failed to update orchestrator setting',
      });
    } finally {
      setIsUpdatingOrchestrator(false);
    }
  };

  switch (route) {
    case 'settings/notifications':
      return <NotificationsView config={config} onSaved={onChanged} />;

    case 'settings/remote':
      return (
        <div class="flex flex-col gap-6">
          <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
            <div class="mb-4 flex flex-wrap items-start justify-between gap-4">
              <div>
                <div class="mb-1 flex items-center gap-2">
                  <span class="text-2xl">🐝</span>
                  <h3 class="text-lg font-semibold text-pine-text">
                    Task Orchestrator &amp; Swarm Settings
                  </h3>
                </div>
                <p class="text-xs text-pine-subtle">
                  Toggle task continuation and worker dispatch capabilities. By default, Agylity
                  operates purely as an autonomous 24/7 quota sentry.
                </p>
              </div>

              <span
                class={`rounded-full border px-3 py-1 text-xs font-bold tracking-wider uppercase ${
                  isOrchestratorEnabled
                    ? 'border-pine-pine bg-pine-pine/20 text-pine-foam'
                    : 'border-pine-highlight bg-pine-overlay text-pine-subtle'
                }`}
              >
                {isOrchestratorEnabled ? '● Orchestrator Active' : '○ Orchestrator Disabled'}
              </span>
            </div>

            <div class="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-pine-highlight/60 bg-pine-overlay/40 p-4">
              <div>
                <p class="text-sm font-semibold text-pine-text">
                  {isOrchestratorEnabled
                    ? 'Orchestrator is currently enabled'
                    : 'Orchestrator is currently disabled'}
                </p>
                <p class="mt-0.5 text-xs text-pine-muted">
                  {isOrchestratorEnabled
                    ? 'Task dispatch is enabled for configured repositories. Pull-based swarm workers can connect and accept continuation tasks.'
                    : 'Task dispatch is blocked. Agylity runs zero remote execution sockets or commands, focusing strictly on quota monitoring.'}
                </p>
              </div>

              <button
                type="button"
                onClick={handleToggleOrchestrator}
                disabled={isUpdatingOrchestrator}
                class={`cursor-pointer rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition-all ${
                  isOrchestratorEnabled
                    ? 'bg-pine-love text-pine-base hover:opacity-90'
                    : 'bg-pine-iris text-pine-base hover:opacity-90'
                }`}
              >
                {isUpdatingOrchestrator
                  ? 'Updating...'
                  : isOrchestratorEnabled
                    ? 'Disable Orchestrator'
                    : 'Enable Orchestrator'}
              </button>
            </div>

            {orchestratorToast && (
              <div
                class={`mt-4 rounded-lg border p-3 text-xs font-medium ${
                  orchestratorToast.type === 'success'
                    ? 'border-pine-pine bg-pine-pine/20 text-pine-foam'
                    : 'border-pine-love bg-pine-love/20 text-pine-love'
                }`}
              >
                {orchestratorToast.message}
              </div>
            )}
          </div>

          <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
            <h4 class="mb-2 text-sm font-semibold text-pine-text">
              Pull-Based Swarm Architecture (Roadmap)
            </h4>
            <p class="text-xs/relaxed text-pine-subtle">
              When enabled, worker machines or homelab containers connect upstream to Agylity via
              secure WebSockets. When a model quota is nearing reset, tasks can be assigned
              dynamically to any connected worker node on an isolated git branch without requiring
              inbound network firewall exceptions or manual broadcast packets across boundaries.
            </p>
          </div>
        </div>
      );

    case 'settings/repositories':
      return <RepoEditor config={config} onSaved={onChanged} />;

    case 'settings/advanced':
      return (
        <div class="flex flex-col gap-6">
          <SettingsForm
            title="Sentry &amp; Quota Safeguards"
            description="Fine-tune quota polling frequency, milestone warnings, Language Server Connect-RPC, and overcharge safety floor."
            fields={SENTRY_FIELDS}
            config={config}
            onSaved={onChanged}
          />

          <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
            <button
              type="button"
              onClick={() => setShowRawTable(!showRawTable)}
              class="flex w-full cursor-pointer items-center justify-between text-sm font-semibold text-pine-subtle transition-colors hover:text-pine-text"
            >
              <div>
                <span class="text-pine-text">Direct SQLite Overrides</span>
                <p class="mt-0.5 text-xs font-normal text-pine-muted">
                  Inspect and edit low-level key-value settings stored directly in SQLite (
                  {showRawTable ? 'Hide table' : 'Expand table'})
                </p>
              </div>
              <span class="rounded bg-pine-overlay px-2 py-1 text-xs text-pine-iris">
                {showRawTable ? '▲ Collapse' : '▼ View All Keys'}
              </span>
            </button>

            {showRawTable && (
              <div class="mt-6 border-t border-pine-highlight pt-6">
                <ConfigTable config={config} onUpdated={onChanged} />
              </div>
            )}
          </div>
        </div>
      );

    default:
      return null;
  }
};
