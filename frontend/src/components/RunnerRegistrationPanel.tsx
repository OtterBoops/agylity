import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { useState } from 'preact/hooks';
import type { RunnerRegistrationTokenResult } from '../types';
import { createRegistrationToken } from '../api';
import { Icon } from './Icon';

interface RunnerRegistrationPanelProps {
  coordinatorOrigin: string;
}

export const RunnerRegistrationPanel = ({ coordinatorOrigin }: RunnerRegistrationPanelProps) => {
  const [runnerNameHint, setRunnerNameHint] = useState('');
  const [runnerLabelsInput, setRunnerLabelsInput] = useState('docker, linux');
  const [isGeneratingToken, setIsGeneratingToken] = useState(false);
  const [generatedReg, setGeneratedReg] = useState<RunnerRegistrationTokenResult | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inputClass =
    'rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors outline-none focus:border-pine-iris';

  const handleGenerateRegistrationToken = async (e: Event) => {
    e.preventDefault();
    setIsGeneratingToken(true);
    setError(null);
    try {
      const labels = runnerLabelsInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await createRegistrationToken({
        nameHint: runnerNameHint.trim() || undefined,
        labels,
      });
      setGeneratedReg(res);
    } catch (err: any) {
      setError(err?.message || 'Failed to generate runner registration token');
    } finally {
      setIsGeneratingToken(false);
    }
  };

  const copyToClipboard = (key: string, text: string) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    }
  };

  const dockerCoordinatorUrl = coordinatorOrigin.replace(
    /\/\/(127\.0\.0\.1|localhost)(:\d+)?$/,
    '//host.docker.internal$2'
  );

  const labelsArg =
    generatedReg?.labels && generatedReg.labels.length > 0 ? generatedReg.labels.join(', ') : '';

  const dockerCommand = generatedReg
    ? [
        `docker run -d --name ${generatedReg.nameHint || 'agylity-runner-1'} \\`,
        `  --restart unless-stopped \\`,
        `  -e COORDINATOR_URL=${dockerCoordinatorUrl} \\`,
        `  -e REGISTRATION_TOKEN=${generatedReg.registrationToken} \\`,
        `  -e RUNNER_STATE_PATH=/data/runner.json \\`,
        labelsArg ? `  -e RUNNER_LABELS="${labelsArg}" \\` : null,
        `  -v agylity-runner-data:/data \\`,
        `  -v agylity-gemini:/home/node/.gemini \\`,
        `  ghcr.io/otterboops/agylity-runner:latest`,
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const cliCommand = generatedReg
    ? [
        `node dist/runner-cli.js \\`,
        `  --url ${coordinatorOrigin} \\`,
        `  --token ${generatedReg.registrationToken} \\`,
        `  --name ${generatedReg.nameHint || 'desktop-runner'}${labelsArg ? ' \\' : ''}`,
        labelsArg ? `  --labels "${labelsArg}"` : null,
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  return (
    <div class="mt-4 border-t border-pine-highlight/60 pt-4">
      <h3 class="text-sm font-semibold text-pine-text">Register New Swarm Runner</h3>
      <p class="mt-0.5 text-xs text-pine-subtle">
        Generate a short-lived one-time registration token (valid for 1 hour). The runner exchanges
        it on first boot for a unique persistent credential stored in{' '}
        <code class="font-mono text-pine-foam">runner.json</code>.
      </p>

      {error && (
        <div
          role="alert"
          class="mt-3 rounded-lg border border-pine-love/40 bg-pine-love/10 p-2.5 text-xs text-pine-love"
        >
          {error}
        </div>
      )}

      <form
        onSubmit={handleGenerateRegistrationToken}
        class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2"
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
          <label class="text-xs font-medium text-pine-subtle" for="runner-labels-input">
            Labels (comma-separated)
          </label>
          <div class="flex flex-col gap-2 sm:flex-row">
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
                  Option A: Container Runner (agylity-runner)
                </span>
                <button
                  type="button"
                  onClick={() => copyToClipboard('docker', dockerCommand)}
                  class="cursor-pointer text-xs text-pine-iris hover:underline"
                >
                  {copiedKey === 'docker' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre class="overflow-x-auto font-mono text-xs/relaxed whitespace-pre-wrap text-pine-text">
                {dockerCommand}
              </pre>
            </div>

            <div class="rounded-lg border border-pine-highlight bg-pine-base p-3">
              <div class="mb-1.5 flex items-center justify-between">
                <span class="font-semibold text-pine-subtle">
                  Option B: Host / Desktop CLI Runner
                </span>
                <button
                  type="button"
                  onClick={() => copyToClipboard('cli', cliCommand)}
                  class="cursor-pointer text-xs text-pine-iris hover:underline"
                >
                  {copiedKey === 'cli' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre class="overflow-x-auto font-mono text-xs/relaxed whitespace-pre-wrap text-pine-text">
                {cliCommand}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
