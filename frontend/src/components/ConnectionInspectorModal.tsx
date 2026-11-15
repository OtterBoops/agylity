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
import { configStore, useStore } from '../state';

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
  const { config } = useStore(configStore);
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

  const resolved = config.resolved ?? {};
  const probeIntervalSeconds = resolved.quotaCheckIntervalSeconds;
  const channels = resolved.notificationChannels;
  const probeIntervalLabel =
    typeof probeIntervalSeconds === 'number' ? `${probeIntervalSeconds}s` : '—';
  const channelsLabel = Array.isArray(channels) && channels.length > 0 ? channels.join(', ') : '—';

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
      id="connection-inspector-dialog"
      aria-labelledby="connection-inspector-title"
      aria-modal="true"
      ref={dialogRef}
      onClose={onClose}
      onCancel={onClose}
      onClick={handleDialogClick}
      class="fixed inset-0 m-auto flex max-h-[85vh] w-[calc(100%-2rem)] max-w-lg flex-col overflow-y-auto rounded-xl border border-pine-highlight bg-pine-surface p-4 text-pine-text shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-xs sm:p-6"
    >
      {/* Header */}
      <div class="flex items-center justify-between gap-3 border-b border-pine-highlight pb-4">
        <div class="flex min-w-0 items-center gap-2.5">
          <div class="flex size-8 shrink-0 items-center justify-center rounded-lg border border-pine-highlight bg-pine-overlay text-pine-iris">
            <Icon icon={faWifi} class="size-4" />
          </div>
          <h3 id="connection-inspector-title" class="text-base font-bold text-pine-text">
            System &amp; Connection Inspector
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close connection inspector"
          class="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-pine-muted transition-colors hover:bg-pine-overlay hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
        >
          <Icon icon={faTimes} class="size-4" />
        </button>
      </div>

      <dl class="mt-4 flex shrink-0 flex-col divide-y divide-pine-highlight/40 overflow-hidden rounded-xl border border-pine-highlight bg-pine-overlay/20 text-xs">
        <div class="flex flex-col gap-0.5 px-3 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <dt class="text-pine-subtle">Telemetry Probe Source</dt>
          <dd class="flex items-center gap-2 font-mono text-pine-text">
            <span class={`size-2 shrink-0 rounded-full ${probeColor}`}></span>
            <span>{probeStatus}</span>
          </dd>
        </div>

        <div class="flex flex-col gap-0.5 px-3 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <dt class="text-pine-subtle">Last Telemetry Probe</dt>
          <dd class="font-mono text-pine-text">
            {lastProbeAt
              ? formatTime(lastProbeAt, { includeSeconds: true, timeFormat })
              : 'Pending'}
          </dd>
        </div>

        <div class="flex flex-col gap-0.5 px-3 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <dt class="text-pine-subtle">Probe Interval</dt>
          <dd class="font-mono text-pine-text">{probeIntervalLabel}</dd>
        </div>

        <div class="flex flex-col gap-0.5 px-3 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <dt class="text-pine-subtle">Notification Channels</dt>
          <dd class="font-mono text-pine-text">{channelsLabel}</dd>
        </div>

        <div class="flex flex-col gap-0.5 px-3 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <dt class="text-pine-subtle">Safety Floor Guard</dt>
          <dd class="font-mono text-pine-text">{minHeadroomPercent}%</dd>
        </div>

        <div class="flex flex-col gap-0.5 px-3 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <dt class="text-pine-subtle">Autonomous Coordinator</dt>
          <dd class="font-mono text-pine-text">{coordinatorEnabled ? 'Enabled' : 'Disabled'}</dd>
        </div>

        <div class="flex flex-col gap-0.5 px-3 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <dt class="text-pine-subtle">Software Release</dt>
          <dd class="flex flex-wrap items-center gap-2 font-mono text-pine-text">
            <span>v{APP_VERSION}</span>
            {updateInfo.hasUpdate ? (
              <a
                href={
                  updateInfo.releaseUrl || 'https://github.com/OtterBoops/agylity/releases/latest'
                }
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1 rounded-sm bg-pine-iris/20 px-1.5 py-0.5 text-xs font-semibold text-pine-iris hover:bg-pine-iris/30"
              >
                <span>Update v{updateInfo.latestVersion}</span>
                <Icon icon={faArrowUpRightFromSquare} class="size-2.5" />
              </a>
            ) : (
              <span class="font-sans text-xs text-pine-subtle">Up to date</span>
            )}
          </dd>
        </div>
      </dl>

      {/* Modal Footer */}
      <div class="mt-5 flex items-center border-t border-pine-highlight pt-4">
        <button
          type="button"
          onClick={handleCopyDiagnostics}
          class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-medium text-pine-subtle transition-colors hover:text-pine-text"
        >
          <Icon icon={copied ? faCheck : faCopy} class="size-3 text-pine-foam" />
          <span>{copied ? 'Copied' : 'Copy Diagnostics'}</span>
        </button>
      </div>
    </dialog>
  );
};
