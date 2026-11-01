import {
  faChevronDown,
  faChevronUp,
  faCodeBranch,
  faCopy,
  faNetworkWired,
  faPause,
  faPlay,
  faPlus,
  faTrash,
} from '@fortawesome/free-solid-svg-icons';
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { ConfigData, RunnerRegistrationTokenResult, SwarmWorkerRecord } from '../types';
import type { Route } from '../router';
import {
  createRegistrationToken,
  getWorkers,
  revokeWorker,
  setWorkerEnabled,
  updateConfig,
} from '../api';
import { SettingsForm, type FieldDef } from '../components/SettingsForm';
import { ConfigTable } from '../components/ConfigTable';
import { RepoEditor } from '../components/RepoEditor';
import { Icon } from '../components/Icon';
import { NotificationsView } from './NotificationsView';

interface SettingsViewProps {
  route: Route;
  config: ConfigData;
  onChanged: () => void;
}

const MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
  { value: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
  { value: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
  { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { value: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { value: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { value: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
  { value: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)' },
  { value: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low)' },
  { value: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
  { value: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)' },
  { value: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' },
  { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
];

const ORCHESTRATOR_FIELDS: FieldDef[] = [
  {
    key: 'defaultDispatchModel',
    label: 'Default dispatch model',
    type: 'select',
    options: MODEL_OPTIONS,
    hint: 'Explicit model passed via --model when dispatching tasks (prevents accidental Claude drain).',
  },
  {
    key: 'defaultDispatchEffort',
    label: 'Default reasoning effort',
    type: 'select',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'X-High' },
      { value: 'max', label: 'Max' },
    ],
    hint: 'Reasoning effort level passed to agy --effort.',
  },
  {
    key: 'defaultWorkerMode',
    label: 'Default runner target mode',
    type: 'select',
    options: [
      { value: 'headless', label: 'Headless (Unattended Docker / Server)' },
      { value: 'visible', label: 'Visible (Supervised Desktop Terminal)' },
      { value: 'any', label: 'Any Available Runner' },
    ],
    hint: 'Target runner class for newly queued continuation tasks.',
  },
  {
    key: 'workerSharedSecret',
    label: 'Fallback shared runner secret (optional)',
    type: 'password',
    hint: 'Encrypted at rest with AES-256-GCM. Optional fallback token alongside per-runner registration tokens.',
  },
  {
    key: 'agyBinPath',
    label: 'Antigravity CLI binary path',
    type: 'text',
    placeholder: 'agy',
    hint: 'Executable name or path for official Antigravity CLI on runners.',
  },
  {
    key: 'quotaBurnMaxHours',
    label: 'P2 Quota-Burn reset window (hours)',
    type: 'number',
    placeholder: '2',
    hint: 'Maximum hours remaining before reset to release P2 opportunistic tasks (default: 2h).',
  },
  {
    key: 'quotaBurnMinHeadroomPercent',
    label: 'P2 Quota-Burn minimum headroom (%)',
    type: 'number',
    placeholder: '30',
    hint: 'Minimum remaining pool quota required to release P2 opportunistic tasks (default: 30%).',
  },
];

// Sentry & Quota Tuning (Includes Antigravity RPC and overcharge safeguards)
const SENTRY_FIELDS: FieldDef[] = [
  {
    key: 'quotaCheckIntervalSeconds',
    label: 'Polling interval (seconds)',
    type: 'number',
    hint: 'How often to check rolling quota (default: 60s, minimum: 30s).',
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
    hint: 'Encrypted at rest with AES-256-GCM. Connect-RPC authentication token.',
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
  const [isTogglingOrchestrator, setIsTogglingOrchestrator] = useState(false);
  const [workers, setWorkers] = useState<SwarmWorkerRecord[]>([]);

  // Runner Registration Generator State
  const [showRegisterPanel, setShowRegisterPanel] = useState(false);
  const [runnerNameHint, setRunnerNameHint] = useState('');
  const [runnerMode, setRunnerMode] = useState<'headless' | 'visible' | 'any'>('headless');
  const [runnerLabelsInput, setRunnerLabelsInput] = useState('docker, linux');
  const [isGeneratingToken, setIsGeneratingToken] = useState(false);
  const [generatedReg, setGeneratedReg] = useState<RunnerRegistrationTokenResult | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const isOrchestratorEnabled = Boolean(config.resolved?.orchestratorEnabled);

  const refreshWorkers = useCallback(() => {
    getWorkers().then((list) => setWorkers(list));
  }, []);

  useEffect(() => {
    if (route !== 'settings/remote' || !isOrchestratorEnabled) return;
    refreshWorkers();
    const timer = setInterval(refreshWorkers, 8000);
    return () => clearInterval(timer);
  }, [route, isOrchestratorEnabled, refreshWorkers]);

  const handleToggleOrchestrator = async () => {
    setIsTogglingOrchestrator(true);
    try {
      await updateConfig({ orchestratorEnabled: !isOrchestratorEnabled });
      onChanged();
    } finally {
      setIsTogglingOrchestrator(false);
    }
  };

  const handleGenerateRegistrationToken = async (e: Event) => {
    e.preventDefault();
    setIsGeneratingToken(true);
    try {
      const labels = runnerLabelsInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await createRegistrationToken({
        nameHint: runnerNameHint.trim() || undefined,
        workerMode: runnerMode,
        labels,
      });
      setGeneratedReg(res);
    } finally {
      setIsGeneratingToken(false);
    }
  };

  const handleToggleWorkerEnabled = async (worker: SwarmWorkerRecord) => {
    await setWorkerEnabled(worker.workerId, !worker.enabled);
    refreshWorkers();
  };

  const handleRevokeWorker = async (worker: SwarmWorkerRecord) => {
    await revokeWorker(worker.workerId);
    refreshWorkers();
  };

  const copyToClipboard = (key: string, text: string) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    }
  };

  const coordinatorOrigin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://agylity:8484';

  const inputClass =
    'rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris';

  switch (route) {
    case 'settings/notifications':
      return <NotificationsView config={config} onSaved={onChanged} />;

    case 'settings/remote':
      return (
        <div class="flex flex-col gap-6">
          <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
            <div class="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div class="mb-1 flex flex-wrap items-center gap-2">
                  <Icon icon={faNetworkWired} class="size-5 text-pine-iris" />
                  <h3 class="text-lg font-semibold text-pine-text">
                    Task Orchestrator &amp; Swarm Runners
                  </h3>
                  <span
                    class={`rounded-full border px-2.5 py-0.5 text-xs font-bold tracking-wider whitespace-nowrap uppercase ${
                      isOrchestratorEnabled
                        ? 'border-pine-pine bg-pine-pine/20 text-pine-foam'
                        : 'border-pine-highlight bg-pine-overlay text-pine-subtle'
                    }`}
                  >
                    {isOrchestratorEnabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
                <p class="text-xs text-pine-subtle">
                  Pure runner control plane: queue tasks into SQLite and execute isolated
                  continuation branches across registered Docker or host CLI runners.
                </p>
              </div>

              <div class="flex flex-wrap items-center gap-2.5">
                {isOrchestratorEnabled && (
                  <button
                    type="button"
                    onClick={() => setShowRegisterPanel(!showRegisterPanel)}
                    class="flex cursor-pointer items-center gap-1.5 rounded-lg border border-pine-iris/40 bg-pine-iris/15 px-3.5 py-2 text-xs font-semibold whitespace-nowrap text-pine-iris transition-colors hover:bg-pine-iris hover:text-pine-base sm:text-sm"
                  >
                    <Icon icon={faPlus} class="size-3" />
                    <span>New Runner</span>
                  </button>
                )}

                <button
                  type="button"
                  disabled={isTogglingOrchestrator}
                  onClick={handleToggleOrchestrator}
                  class={`cursor-pointer rounded-lg px-4 py-2 text-xs font-semibold whitespace-nowrap transition-colors sm:text-sm ${
                    isOrchestratorEnabled
                      ? 'border border-pine-love/40 bg-pine-love/15 text-pine-love hover:bg-pine-love hover:text-white'
                      : 'bg-pine-iris text-pine-base hover:opacity-90'
                  }`}
                >
                  {isTogglingOrchestrator
                    ? 'Updating...'
                    : isOrchestratorEnabled
                      ? 'Disable Orchestrator'
                      : 'Enable Orchestrator'}
                </button>
              </div>
            </div>

            {/* GitHub-Runner-Style Registration Token Generator */}
            {isOrchestratorEnabled && showRegisterPanel && (
              <div class="mt-5 rounded-xl border border-pine-highlight bg-pine-overlay/40 p-4">
                <h4 class="text-sm font-semibold text-pine-text">Register New Swarm Runner</h4>
                <p class="mt-0.5 text-xs text-pine-subtle">
                  Generate a short-lived one-time registration token (valid for 1 hour). The runner
                  exchanges it on first boot for a unique persistent credential stored in{' '}
                  <code class="font-mono text-pine-foam">runner.json</code>.
                </p>

                <form
                  onSubmit={handleGenerateRegistrationToken}
                  class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3"
                >
                  <div class="flex flex-col gap-1">
                    <label class="text-xs font-medium text-pine-subtle" for="runner-name-hint">
                      Runner name
                    </label>
                    <input
                      id="runner-name-hint"
                      type="text"
                      placeholder="runner-1"
                      autoComplete="off"
                      data-1p-ignore="true"
                      data-lpignore="true"
                      class={inputClass}
                      value={runnerNameHint}
                      onInput={(e) => setRunnerNameHint((e.target as HTMLInputElement).value)}
                    />
                  </div>

                  <div class="flex flex-col gap-1">
                    <label class="text-xs font-medium text-pine-subtle" for="runner-mode-select">
                      Execution mode
                    </label>
                    <select
                      id="runner-mode-select"
                      class={`${inputClass} cursor-pointer`}
                      value={runnerMode}
                      onChange={(e) =>
                        setRunnerMode(
                          (e.target as HTMLSelectElement).value as 'headless' | 'visible' | 'any'
                        )
                      }
                    >
                      <option value="headless">Headless (Docker / Unattended)</option>
                      <option value="visible">Visible (Desktop Terminal)</option>
                      <option value="any">Any Mode</option>
                    </select>
                  </div>

                  <div class="flex flex-col gap-1">
                    <label class="text-xs font-medium text-pine-subtle" for="runner-labels-input">
                      Labels (comma-separated)
                    </label>
                    <div class="flex gap-2">
                      <input
                        id="runner-labels-input"
                        type="text"
                        placeholder="docker, linux, fast"
                        autoComplete="off"
                        data-1p-ignore="true"
                        data-lpignore="true"
                        class={`${inputClass} min-w-0 flex-1`}
                        value={runnerLabelsInput}
                        onInput={(e) => setRunnerLabelsInput((e.target as HTMLInputElement).value)}
                      />
                      <button
                        type="submit"
                        disabled={isGeneratingToken}
                        class="cursor-pointer rounded-lg bg-pine-iris px-3.5 py-2 text-xs font-semibold whitespace-nowrap text-pine-base transition-opacity hover:opacity-90 disabled:opacity-50"
                      >
                        {isGeneratingToken ? 'Generating...' : 'Generate Token'}
                      </button>
                    </div>
                  </div>
                </form>

                {generatedReg && (
                  <div class="mt-4 flex flex-col gap-3 border-t border-pine-highlight pt-3 text-xs">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <span class="font-medium text-pine-foam">
                        [Notice] One-time registration token generated (expires{' '}
                        {new Date(generatedReg.expiresAt).toLocaleTimeString()}):
                      </span>
                      <button
                        type="button"
                        onClick={() => copyToClipboard('token', generatedReg.registrationToken)}
                        class="flex cursor-pointer items-center gap-1.5 rounded-sm border border-pine-highlight bg-pine-surface px-2.5 py-1 font-mono text-xs text-pine-subtle hover:text-pine-text"
                      >
                        <Icon icon={faCopy} class="size-3" />
                        <span>{copiedKey === 'token' ? 'Copied' : 'Copy Token'}</span>
                      </button>
                    </div>

                    <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
                      <div class="rounded-lg border border-pine-highlight bg-pine-base p-3">
                        <div class="mb-1.5 flex items-center justify-between">
                          <span class="font-semibold text-pine-subtle">
                            Option A: Container Runner (agylity-worker)
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              copyToClipboard(
                                'docker',
                                `docker run -d --name ${generatedReg.nameHint || 'agylity-worker-1'} --restart unless-stopped -e COORDINATOR_URL=${coordinatorOrigin} -e REGISTRATION_TOKEN=${generatedReg.registrationToken} -e WORKER_NAME=${generatedReg.nameHint || 'agylity-worker-1'} -v ./oauth_creds.json:/home/node/.gemini/oauth_creds.json ghcr.io/otterboops/agylity-worker:latest`
                              )
                            }
                            class="cursor-pointer text-xs text-pine-iris hover:underline"
                          >
                            {copiedKey === 'docker' ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                        <pre class="overflow-x-auto font-mono text-xs/relaxed text-pine-text">
                          {`docker run -d --name ${generatedReg.nameHint || 'agylity-worker-1'} \\\n  -e COORDINATOR_URL=${coordinatorOrigin} \\\n  -e REGISTRATION_TOKEN=${generatedReg.registrationToken} \\\n  -v ./oauth_creds.json:/home/node/.gemini/oauth_creds.json \\\n  ghcr.io/otterboops/agylity-worker:latest`}
                        </pre>
                      </div>

                      <div class="rounded-lg border border-pine-highlight bg-pine-base p-3">
                        <div class="mb-1.5 flex items-center justify-between">
                          <span class="font-semibold text-pine-subtle">
                            Option B: Host / Desktop CLI Runner
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              copyToClipboard(
                                'cli',
                                `node dist/worker-cli.js --url ${coordinatorOrigin} --token ${generatedReg.registrationToken} --name ${generatedReg.nameHint || 'desktop-runner'} --mode ${generatedReg.workerMode}`
                              )
                            }
                            class="cursor-pointer text-xs text-pine-iris hover:underline"
                          >
                            {copiedKey === 'cli' ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                        <pre class="overflow-x-auto font-mono text-xs/relaxed text-pine-text">
                          {`node dist/worker-cli.js \\\n  --url ${coordinatorOrigin} \\\n  --token ${generatedReg.registrationToken} \\\n  --name ${generatedReg.nameHint || 'desktop-runner'} \\\n  --mode ${generatedReg.workerMode}`}
                        </pre>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Registered Swarm Runners List */}
            {isOrchestratorEnabled && (
              <div class="mt-5 border-t border-pine-highlight pt-4">
                <div class="mb-2.5 flex items-center justify-between">
                  <h4 class="text-xs font-semibold tracking-wider text-pine-subtle uppercase">
                    Registered Swarm Runners ({workers.length})
                  </h4>
                </div>

                {workers.length === 0 ? (
                  <div class="rounded-lg border border-pine-highlight bg-pine-overlay/25 p-4 text-xs text-pine-muted">
                    No runners registered yet. Click{' '}
                    <strong class="text-pine-text">New Runner</strong> above to generate a
                    registration token and connect a Docker or CLI runner.
                  </div>
                ) : (
                  <div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {workers.map((w) => (
                      <div
                        key={w.workerId}
                        class="flex flex-col justify-between gap-3 rounded-lg border border-pine-highlight bg-pine-overlay/40 p-3.5 text-xs"
                      >
                        <div class="flex items-start justify-between gap-2">
                          <div class="min-w-0">
                            <div class="font-mono font-semibold wrap-break-word text-pine-text">
                              {w.name}
                            </div>
                            <div class="mt-0.5 font-mono text-xs text-pine-muted">{w.workerId}</div>
                          </div>

                          <div class="flex items-center gap-1.5">
                            {!w.enabled && (
                              <span class="rounded-sm border border-pine-muted/40 bg-pine-overlay px-2 py-0.5 text-xs font-bold tracking-wider whitespace-nowrap text-pine-muted uppercase">
                                Paused
                              </span>
                            )}
                            <span
                              class={`rounded-sm border px-2 py-0.5 text-xs font-bold tracking-wider whitespace-nowrap uppercase ${
                                w.status === 'busy'
                                  ? 'border-pine-gold bg-pine-gold/20 text-pine-gold'
                                  : w.status === 'offline'
                                    ? 'border-pine-love/40 bg-pine-love/15 text-pine-love'
                                    : 'border-pine-pine bg-pine-pine/20 text-pine-foam'
                              }`}
                            >
                              {w.status}
                            </span>
                          </div>
                        </div>

                        <div class="flex flex-wrap items-center gap-1.5 text-xs text-pine-muted">
                          <span class="rounded-sm bg-pine-surface px-2 py-0.5 font-mono whitespace-nowrap text-pine-subtle">
                            mode:{w.workerMode}
                          </span>
                          {w.labels?.map((lbl) => (
                            <span
                              key={lbl}
                              class="rounded-sm bg-pine-iris/15 px-2 py-0.5 font-mono whitespace-nowrap text-pine-iris"
                            >
                              {lbl}
                            </span>
                          ))}
                        </div>

                        <div class="flex items-center justify-between border-t border-pine-highlight/60 pt-2.5">
                          <span class="text-xs text-pine-muted">
                            Seen {new Date(w.lastSeenAt).toLocaleTimeString()}
                          </span>

                          <div class="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleToggleWorkerEnabled(w)}
                              title={w.enabled ? 'Pause runner' : 'Resume runner'}
                              class="flex cursor-pointer items-center gap-1 rounded-sm border border-pine-highlight bg-pine-surface px-2 py-1 text-xs font-medium whitespace-nowrap text-pine-subtle transition-colors hover:text-pine-text"
                            >
                              <Icon icon={w.enabled ? faPause : faPlay} class="size-2.5" />
                              <span>{w.enabled ? 'Pause' : 'Resume'}</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => handleRevokeWorker(w)}
                              title="Revoke runner credential and remove"
                              class="flex cursor-pointer items-center gap-1 rounded-sm border border-pine-love/30 bg-pine-love/10 px-2 py-1 text-xs font-medium whitespace-nowrap text-pine-love transition-colors hover:bg-pine-love hover:text-white"
                            >
                              <Icon icon={faTrash} class="size-2.5" />
                              <span>Revoke</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {isOrchestratorEnabled && (
            <SettingsForm
              title="Model Selection &amp; Swarm Queue Parameters"
              description="Configure the explicit default dispatch model, fallback runner secret, and P2 opportunistic quota-burn thresholds."
              fields={ORCHESTRATOR_FIELDS}
              config={config}
              onSaved={onChanged}
            />
          )}
        </div>
      );

    case 'settings/repositories':
      if (!isOrchestratorEnabled) {
        return (
          <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
            <div class="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div class="mb-1 flex items-center gap-2">
                  <Icon icon={faCodeBranch} class="size-5 text-pine-subtle" />
                  <h3 class="text-lg font-semibold text-pine-text">Repositories</h3>
                  <span class="rounded-full border border-pine-highlight bg-pine-overlay px-2.5 py-0.5 text-xs font-bold tracking-wider whitespace-nowrap text-pine-subtle uppercase">
                    Orchestrator Off
                  </span>
                </div>
                <p class="text-xs text-pine-subtle">
                  Enable the Task Orchestrator first to register and manage local git repositories
                  for swarm runners.
                </p>
              </div>
              <button
                type="button"
                disabled={isTogglingOrchestrator}
                onClick={handleToggleOrchestrator}
                class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-xs font-semibold whitespace-nowrap text-pine-base transition-opacity hover:opacity-90 disabled:opacity-50 sm:text-sm"
              >
                {isTogglingOrchestrator ? 'Enabling...' : 'Enable Orchestrator'}
              </button>
            </div>
          </div>
        );
      }
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

          <div class="rounded-xl border border-pine-highlight bg-pine-surface shadow-sm">
            <button
              type="button"
              onClick={() => setShowRawTable(!showRawTable)}
              class="group flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
            >
              <div>
                <h3 class="text-sm font-semibold text-pine-text">Configuration Overrides</h3>
                <p class="mt-0.5 text-xs text-pine-subtle">
                  Inspect and edit low-level key-value settings
                </p>
              </div>
              <span class="flex items-center gap-1.5 text-xs text-pine-subtle transition-colors group-hover:text-pine-text">
                <span>{showRawTable ? 'Hide' : 'View all keys'}</span>
                <Icon icon={showRawTable ? faChevronUp : faChevronDown} class="size-2.5" />
              </span>
            </button>

            {showRawTable && (
              <div class="border-t border-pine-highlight p-4">
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
