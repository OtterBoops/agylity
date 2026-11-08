import {
  faArrowUpRightFromSquare,
  faCheck,
  faCopy,
  faTimes,
  faWifi,
} from '@fortawesome/free-solid-svg-icons';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './Icon';
import { dialogBackdropClickHandler } from '../utils/dialog';
import { describeProbe } from '../utils/probe';
import { APP_VERSION, fetchLatestRelease, isNewerVersion } from '../utils/version';
import { formatTime, useTimeFormat } from '../utils/time';

interface ConnectionInspectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  lastProbeSource?: string;
  lastProbeAt?: string;
  coordinatorEnabled?: boolean;
  minHeadroomPercent?: number;
}

export const ConnectionInspectorModal = ({
  isOpen,
  onClose,
  lastProbeSource,
  lastProbeAt,
  coordinatorEnabled = false,
  minHeadroomPercent = 10,
}: ConnectionInspectorModalProps) => {
  const [timeFormat] = useTimeFormat();
  const [copied, setCopied] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{
    hasUpdate: boolean;
    latestVersion: string | null;
    releaseUrl: string | null;
  }>({
    hasUpdate: false,
    latestVersion: null,
    releaseUrl: null,
  });
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let mounted = true;
    fetchLatestRelease().then((rel) => {
      if (!mounted) return;
      if (rel && isNewerVersion(APP_VERSION, rel.latest)) {
        setUpdateInfo({
          hasUpdate: true,
          latestVersion: rel.latest,
          releaseUrl: rel.url,
        });
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen) {
      if (!dialog.open) dialog.showModal();
    } else {
      if (dialog.open) dialog.close();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const { label: probeStatus, color: probeColor } = describeProbe(lastProbeSource);

  const handleCopyDiagnostics = async () => {
    const diag = {
      appVersion: APP_VERSION,
      probeSource: lastProbeSource,
      lastProbeAt: lastProbeAt || 'N/A',
      coordinatorEnabled,
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

  const handleDialogClick = dialogBackdropClickHandler(dialogRef, onClose);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={handleDialogClick}
      class="fixed inset-0 m-auto flex max-h-[85vh] w-[calc(100%-2rem)] max-w-lg flex-col overflow-y-auto rounded-xl border border-pine-highlight bg-pine-surface p-4 text-pine-text shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-xs sm:p-6"
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
            <span class="text-pine-muted">Telemetry Probe Source</span>
            <div class="mt-0.5 flex items-center gap-2 font-medium text-pine-text">
              <span class={`size-2 rounded-full ${probeColor}`}></span>
              <span>{probeStatus}</span>
            </div>
          </div>

          <div class="flex flex-col gap-1 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-3">
            <span class="text-pine-muted">Sentry Evaluation</span>
            <div class="mt-0.5 font-medium text-pine-text">Multi-tier (Weekly &amp; 5h)</div>
          </div>

          <div class="flex flex-col gap-1 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-3">
            <span class="text-pine-muted">Last Telemetry Probe</span>
            <div class="mt-0.5 font-mono text-xs text-pine-text">
              {lastProbeAt
                ? formatTime(lastProbeAt, { includeSeconds: true, timeFormat })
                : 'Pending'}
            </div>
          </div>

          <div class="flex flex-col gap-1 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-3">
            <span class="text-pine-muted">Safety Floor Guard</span>
            <div class="mt-0.5 font-mono font-medium text-pine-foam">
              {minHeadroomPercent}% headroom lock
            </div>
          </div>

          <div class="flex flex-col gap-1 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-3">
            <span class="text-pine-muted">Autonomous Coordinator</span>
            <div class="mt-0.5 font-medium text-pine-text">
              {coordinatorEnabled ? (
                <span class="font-semibold text-pine-foam">Enabled</span>
              ) : (
                <span class="text-pine-muted">Disabled</span>
              )}
            </div>
          </div>

          <div class="flex flex-col gap-1 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-3">
            <span class="text-pine-muted">Software Release</span>
            <div class="mt-0.5 flex items-center justify-between font-mono text-xs text-pine-text">
              <span>v{APP_VERSION}</span>
              {updateInfo.hasUpdate ? (
                <a
                  href={
                    updateInfo.releaseUrl || 'https://github.com/OtterBoops/agylity/releases/latest'
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1 rounded-sm bg-pine-iris/20 px-1.5 py-0.5 text-[10px] font-semibold text-pine-iris hover:bg-pine-iris/30"
                >
                  <span>Update v{updateInfo.latestVersion}</span>
                  <Icon icon={faArrowUpRightFromSquare} class="size-2.5" />
                </a>
              ) : (
                <span class="font-sans text-xs text-pine-foam">Up to date</span>
              )}
            </div>
          </div>
        </div>

        <div class="rounded-lg border border-pine-highlight bg-pine-overlay/20 p-3 text-xs text-pine-subtle">
          <p>
            Agylity communicates with Google Antigravity Language Server RPC to inspect pool quotas
            and coordinates autonomous Git tasks strictly within your safe quota budget.
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
    </dialog>
  );
};
