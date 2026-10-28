import { faCheck, faCopy, faTimes, faWifi } from '@fortawesome/free-solid-svg-icons';
import { useState } from 'preact/hooks';
import { Icon } from './Icon';
import { APP_VERSION } from '../utils/version';

interface ConnectionInspectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  lastProbeSource?: string;
  lastProbeAt?: string;
  orchestratorEnabled?: boolean;
  minHeadroomPercent?: number;
}

export const ConnectionInspectorModal = ({
  isOpen,
  onClose,
  lastProbeSource = 'connect_rpc',
  lastProbeAt,
  orchestratorEnabled = false,
  minHeadroomPercent = 10,
}: ConnectionInspectorModalProps) => {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleCopyDiagnostics = async () => {
    const diag = {
      appVersion: APP_VERSION,
      probeSource: lastProbeSource,
      lastProbeAt: lastProbeAt || 'N/A',
      orchestratorEnabled,
      minHeadroomPercent,
      url: window.location.href,
      timestamp: new Date().toISOString(),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        class="flex w-full max-w-lg flex-col rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div class="flex items-center justify-between border-b border-pine-highlight pb-4">
          <div class="flex items-center gap-2.5">
            <div class="flex size-8 items-center justify-center rounded-lg border border-pine-highlight bg-pine-overlay text-pine-iris">
              <Icon icon={faWifi} class="size-4" />
            </div>
            <div>
              <h3 class="text-base font-bold text-pine-text">System &amp; Connection Inspector</h3>
              <p class="text-xs text-pine-muted">Runtime telemetry &amp; Antigravity sentry link</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            class="cursor-pointer rounded-lg p-1.5 text-pine-muted transition-colors hover:bg-pine-overlay hover:text-pine-text"
          >
            <Icon icon={faTimes} class="size-4" />
          </button>
        </div>

        {/* Diagnostic Grid */}
        <div class="mt-4 flex flex-col gap-3">
          <div class="grid grid-cols-2 gap-3 text-xs">
            <div class="flex flex-col gap-1 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-3">
              <span class="text-pine-muted">Language Server RPC</span>
              <div class="mt-0.5 flex items-center gap-2 font-medium text-pine-text">
                <span class="size-2 rounded-full bg-pine-pine"></span>
                <span>
                  {lastProbeSource === 'connect_rpc' ? 'Connect-RPC (Live)' : 'CLI Fallback'}
                </span>
              </div>
            </div>

            <div class="flex flex-col gap-1 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-3">
              <span class="text-pine-muted">Sentry Evaluation</span>
              <div class="mt-0.5 font-medium text-pine-text">Multi-tier (Weekly &amp; 5h)</div>
            </div>

            <div class="flex flex-col gap-1 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-3">
              <span class="text-pine-muted">Last Telemetry Probe</span>
              <div class="mt-0.5 font-mono text-[11px] text-pine-text">
                {lastProbeAt ? new Date(lastProbeAt).toLocaleTimeString() : 'Pending'}
              </div>
            </div>

            <div class="flex flex-col gap-1 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-3">
              <span class="text-pine-muted">Safety Floor Guard</span>
              <div class="mt-0.5 font-mono font-medium text-pine-foam">
                {minHeadroomPercent}% headroom lock
              </div>
            </div>

            <div class="flex flex-col gap-1 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-3">
              <span class="text-pine-muted">Autonomous Orchestrator</span>
              <div class="mt-0.5 font-medium text-pine-text">
                {orchestratorEnabled ? (
                  <span class="font-semibold text-pine-foam">Enabled</span>
                ) : (
                  <span class="text-pine-muted">Disabled</span>
                )}
              </div>
            </div>

            <div class="flex flex-col gap-1 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-3">
              <span class="text-pine-muted">Software Release</span>
              <div class="mt-0.5 flex items-center justify-between font-mono text-[11px] text-pine-text">
                <span>v{APP_VERSION}</span>
                <span class="font-sans text-[10px] text-pine-foam">Up to date</span>
              </div>
            </div>
          </div>

          <div class="rounded-lg border border-pine-highlight bg-pine-overlay/20 p-3 text-xs text-pine-subtle">
            <p>
              Agylity communicates with Google Antigravity Language Server RPC to inspect pool
              quotas and orchestrates autonomous Git tasks strictly within your safe quota budget.
            </p>
          </div>
        </div>

        {/* Modal Footer */}
        <div class="mt-5 flex items-center justify-between border-t border-pine-highlight pt-4">
          <button
            type="button"
            onClick={handleCopyDiagnostics}
            class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-medium text-pine-subtle transition-colors hover:text-pine-text"
          >
            <Icon icon={copied ? faCheck : faCopy} class="size-3 text-pine-foam" />
            <span>{copied ? 'Copied' : 'Copy Diagnostics'}</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-4 py-1.5 text-xs font-medium text-pine-text transition-colors hover:bg-pine-highlight/50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
