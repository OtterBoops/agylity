import { useState, useEffect } from 'preact/hooks';
import {
  faArrowUpRightFromSquare,
  faBars,
  faBell,
  faChartPie,
  faCodeBranch,
  faList,
  faNetworkWired,
  faSliders,
  faXmark,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import type { Route } from '../router';
import { Icon } from './Icon';
import { APP_VERSION, fetchLatestRelease, isNewerVersion } from '../utils/version';

import { ConnectionInspectorModal } from './ConnectionInspectorModal';

interface SidebarProps {
  route: Route;
  onNavigate: (route: Route) => void;
  orchestratorEnabled?: boolean;
  lastProbeSource?: string;
  lastProbeAt?: string;
  minHeadroomPercent?: number;
}

interface NavItem {
  route: Route;
  label: string;
  icon: IconDefinition;
}

const MONITOR: NavItem[] = [{ route: 'overview', label: 'Overview', icon: faChartPie }];

const SYSTEM: NavItem[] = [
  { route: 'logs', label: 'Logs', icon: faList },
  { route: 'settings/advanced', label: 'Advanced', icon: faSliders },
];

const NavButton = ({
  item,
  active,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-current={active ? 'page' : undefined}
    class={`group relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium whitespace-nowrap transition-all duration-150 ${
      active
        ? 'bg-pine-iris/10 font-semibold text-pine-iris'
        : 'text-pine-subtle hover:bg-pine-overlay/60 hover:text-pine-text'
    }`}
  >
    {active && <span class="absolute -left-1 h-4 w-1 rounded-full bg-pine-iris transition-all" />}
    <div
      class={`flex size-6.5 shrink-0 items-center justify-center rounded-md border transition-colors ${
        active
          ? 'border-pine-iris/30 bg-pine-iris/15 text-pine-iris shadow-xs'
          : 'border-pine-highlight bg-pine-overlay/40 text-pine-subtle group-hover:bg-pine-overlay group-hover:text-pine-text'
      }`}
    >
      <Icon icon={item.icon} class="size-3.5" />
    </div>
    <span class="truncate">{item.label}</span>
  </button>
);

export const Sidebar = ({
  route,
  onNavigate,
  orchestratorEnabled = false,
  lastProbeSource,
  lastProbeAt,
  minHeadroomPercent = 10,
}: SidebarProps) => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{
    hasUpdate: boolean;
    latestVersion: string | null;
    releaseUrl: string | null;
  }>({
    hasUpdate: false,
    latestVersion: null,
    releaseUrl: null,
  });

  useEffect(() => {
    fetchLatestRelease().then((rel) => {
      if (rel && isNewerVersion(APP_VERSION, rel.latest)) {
        setUpdateInfo({
          hasUpdate: true,
          latestVersion: rel.latest,
          releaseUrl: rel.url,
        });
      }
    });
  }, []);

  const configurationItems = [
    { route: 'settings/notifications' as Route, label: 'Notifications', icon: faBell },
    { route: 'settings/remote' as Route, label: 'Orchestrator', icon: faNetworkWired },
    ...(orchestratorEnabled
      ? [{ route: 'settings/repositories' as Route, label: 'Repositories', icon: faCodeBranch }]
      : []),
  ];

  const handleNav = (r: Route) => {
    onNavigate(r);
    setMobileOpen(false);
  };

  const probeStatus =
    lastProbeSource === 'connect_rpc'
      ? 'Live Connect-RPC'
      : lastProbeSource === 'cli'
        ? 'CLI Fallback'
        : 'Offline';
  const probeColor =
    lastProbeSource === 'connect_rpc'
      ? 'bg-pine-pine'
      : lastProbeSource === 'cli'
        ? 'bg-pine-gold'
        : 'bg-pine-love';

  return (
    <>
      {/* Mobile Sticky Header Bar */}
      <div class="sticky top-0 z-40 flex h-14 w-full items-center justify-between border-b border-pine-highlight bg-pine-surface px-4 md:hidden">
        <div class="flex items-center gap-2.5">
          <div class="flex size-8 shrink-0 items-center justify-center rounded-lg border border-pine-highlight bg-pine-overlay shadow-xs">
            <svg viewBox="0 0 24 24" fill="none" class="size-4.5 text-pine-iris" aria-hidden="true">
              <path
                fill-rule="evenodd"
                clip-rule="evenodd"
                d="M10.882 1.441A1.25 1.25 0 0 1 13.118 1.441L22.118 19.441A1.25 1.25 0 0 1 21 21.25H17A1.25 1.25 0 0 1 15.882 20.559L13.727 16.25H10.273L8.118 20.559A1.25 1.25 0 0 1 7 21.25H3A1.25 1.25 0 0 1 1.882 19.441ZM11.598 9.899A0.45 0.45 0 0 1 12.402 9.899L13.652 12.399A0.45 0.45 0 0 1 13.25 13.05H10.75A0.45 0.45 0 0 1 10.348 12.399Z"
                fill="currentColor"
              />
            </svg>
          </div>
          <span class="text-base leading-none font-bold tracking-tight text-pine-text">
            Agylity
          </span>
          <span class="relative flex size-2 shrink-0">
            <span
              class={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${probeColor}`}
            />
            <span class={`relative inline-flex size-2 rounded-full ${probeColor}`} />
          </span>
        </div>
        <button
          type="button"
          onClick={() => setMobileOpen(!mobileOpen)}
          class="flex size-9 cursor-pointer items-center justify-center rounded-lg border border-pine-highlight bg-pine-overlay/60 text-pine-text transition-colors hover:bg-pine-highlight"
          aria-label="Toggle navigation menu"
          aria-expanded={mobileOpen}
        >
          <Icon icon={mobileOpen ? faXmark : faBars} class="size-4" />
        </button>
      </div>

      {/* Mobile Collapsible Navigation Dropdown */}
      {mobileOpen && (
        <div class="border-b border-pine-highlight bg-pine-surface p-4 md:hidden">
          <nav class="flex flex-col gap-4">
            <div class="flex flex-col gap-1">
              <div class="flex items-center gap-2 px-2 py-0.5">
                <span class="text-[9px] font-bold tracking-widest text-pine-muted uppercase">
                  Monitor
                </span>
                <span class="h-px flex-1 bg-pine-highlight/30" />
              </div>
              <div class="flex flex-col gap-0.5">
                {MONITOR.map((item) => (
                  <NavButton
                    key={item.route}
                    item={item}
                    active={route === item.route}
                    onClick={() => handleNav(item.route)}
                  />
                ))}
              </div>
            </div>

            <div class="flex flex-col gap-1">
              <div class="flex items-center gap-2 px-2 py-0.5">
                <span class="text-[9px] font-bold tracking-widest text-pine-muted uppercase">
                  Configuration
                </span>
                <span class="h-px flex-1 bg-pine-highlight/30" />
              </div>
              <div class="flex flex-col gap-0.5">
                {configurationItems.map((item) => (
                  <NavButton
                    key={item.route}
                    item={item}
                    active={route === item.route}
                    onClick={() => handleNav(item.route)}
                  />
                ))}
              </div>
            </div>

            <div class="flex flex-col gap-1">
              <div class="flex items-center gap-2 px-2 py-0.5">
                <span class="text-[9px] font-bold tracking-widest text-pine-muted uppercase">
                  System
                </span>
                <span class="h-px flex-1 bg-pine-highlight/30" />
              </div>
              <div class="flex flex-col gap-0.5">
                {SYSTEM.map((item) => (
                  <NavButton
                    key={item.route}
                    item={item}
                    active={route === item.route}
                    onClick={() => handleNav(item.route)}
                  />
                ))}
              </div>
            </div>
          </nav>

          {/* Mobile Telemetry & Version Footer */}
          <div class="mt-4 flex flex-col gap-2 rounded-xl border border-pine-highlight bg-pine-base/40 p-3 text-xs">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="relative flex size-2 shrink-0">
                  <span
                    class={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${probeColor}`}
                  />
                  <span class={`relative inline-flex size-2 rounded-full ${probeColor}`} />
                </span>
                <span class="font-medium text-pine-text">{probeStatus}</span>
              </div>
              {lastProbeAt && (
                <span class="font-mono text-[0.6875rem] text-pine-muted" title={lastProbeAt}>
                  {new Date(lastProbeAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
              )}
            </div>
            <div class="flex items-center justify-between border-t border-pine-highlight pt-2 font-mono text-xs text-pine-muted">
              <a
                href="https://github.com/OtterBoops/agylity/releases"
                target="_blank"
                rel="noopener noreferrer"
                class="hover:text-pine-text"
              >
                v{APP_VERSION}
              </a>
              {updateInfo.hasUpdate ? (
                <a
                  href={
                    updateInfo.releaseUrl || 'https://github.com/OtterBoops/agylity/releases/latest'
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1 rounded bg-pine-iris/20 px-1.5 py-0.5 text-[10px] font-semibold text-pine-iris hover:bg-pine-iris/30"
                >
                  <span>Update v{updateInfo.latestVersion}</span>
                  <Icon icon={faArrowUpRightFromSquare} class="size-2.5" />
                </a>
              ) : (
                <span class="text-[10px] text-pine-muted/70">Up to date</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Desktop Locked Sidebar */}
      <aside class="hidden md:flex md:h-screen md:w-60 md:shrink-0 md:flex-col md:justify-between md:overflow-y-auto md:border-r md:border-pine-highlight md:bg-pine-surface/95 md:backdrop-blur-md 2xl:w-68">
        <div class="p-5 md:p-6">
          {/* Brand Header */}
          <div class="mb-8 flex items-center gap-3 px-1">
            <div class="flex size-[42px] shrink-0 items-center justify-center rounded-lg border border-pine-highlight bg-pine-overlay shadow-xs">
              <svg viewBox="0 0 24 24" fill="none" class="size-6 text-pine-iris" aria-hidden="true">
                <path
                  fill-rule="evenodd"
                  clip-rule="evenodd"
                  d="M10.882 1.441A1.25 1.25 0 0 1 13.118 1.441L22.118 19.441A1.25 1.25 0 0 1 21 21.25H17A1.25 1.25 0 0 1 15.882 20.559L13.727 16.25H10.273L8.118 20.559A1.25 1.25 0 0 1 7 21.25H3A1.25 1.25 0 0 1 1.882 19.441ZM11.598 9.899A0.45 0.45 0 0 1 12.402 9.899L13.652 12.399A0.45 0.45 0 0 1 13.25 13.05H10.75A0.45 0.45 0 0 1 10.348 12.399Z"
                  fill="currentColor"
                />
              </svg>
            </div>
            <span class="text-2xl leading-none font-bold tracking-tight text-pine-text">
              Agylity
            </span>
          </div>

          <nav class="flex flex-col gap-5">
            <div class="flex flex-col gap-1">
              <div class="flex items-center gap-2 px-2 py-0.5">
                <span class="text-[0.625rem] font-bold tracking-widest text-pine-muted uppercase">
                  Monitor
                </span>
                <span class="h-px flex-1 bg-pine-highlight/30" />
              </div>
              <div class="flex flex-col gap-0.5">
                {MONITOR.map((item) => (
                  <NavButton
                    key={item.route}
                    item={item}
                    active={route === item.route}
                    onClick={() => onNavigate(item.route)}
                  />
                ))}
              </div>
            </div>

            <div class="flex flex-col gap-1">
              <div class="flex items-center gap-2 px-2 py-0.5">
                <span class="text-[0.625rem] font-bold tracking-widest text-pine-muted uppercase">
                  Configuration
                </span>
                <span class="h-px flex-1 bg-pine-highlight/30" />
              </div>
              <div class="flex flex-col gap-0.5">
                {configurationItems.map((item) => (
                  <NavButton
                    key={item.route}
                    item={item}
                    active={route === item.route}
                    onClick={() => onNavigate(item.route)}
                  />
                ))}
              </div>
            </div>

            <div class="flex flex-col gap-1">
              <div class="flex items-center gap-2 px-2 py-0.5">
                <span class="text-[0.625rem] font-bold tracking-widest text-pine-muted uppercase">
                  System
                </span>
                <span class="h-px flex-1 bg-pine-highlight/30" />
              </div>
              <div class="flex flex-col gap-0.5">
                {SYSTEM.map((item) => (
                  <NavButton
                    key={item.route}
                    item={item}
                    active={route === item.route}
                    onClick={() => onNavigate(item.route)}
                  />
                ))}
              </div>
            </div>
          </nav>
        </div>

        {/* Desktop Homepage-style Telemetry & Version Footer */}
        <div class="p-4 pt-0">
          <div
            onClick={() => setInspectorOpen(true)}
            class="flex cursor-pointer flex-col gap-2 rounded-xl border border-pine-highlight bg-pine-base/40 p-3 shadow-xs transition-colors hover:border-pine-iris/60"
            title="Click to view detailed system telemetry"
          >
            <div class="flex items-center justify-between text-xs">
              <div class="flex min-w-0 items-center gap-2">
                <span class="relative flex size-2 shrink-0">
                  <span
                    class={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${probeColor}`}
                  />
                  <span class={`relative inline-flex size-2 rounded-full ${probeColor}`} />
                </span>
                <span class="truncate font-medium text-pine-text">{probeStatus}</span>
              </div>
              {lastProbeAt && (
                <span
                  class="shrink-0 font-mono text-[0.6875rem] text-pine-muted"
                  title={lastProbeAt}
                >
                  {new Date(lastProbeAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
              )}
            </div>

            <div
              class="flex items-center justify-between border-t border-pine-highlight pt-2 font-mono text-xs text-pine-muted"
              onClick={(e) => e.stopPropagation()}
            >
              <a
                href="https://github.com/OtterBoops/agylity/releases"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1 transition-colors hover:text-pine-text"
                title="Agylity Releases on GitHub"
              >
                <span>v{APP_VERSION}</span>
              </a>

              {updateInfo.hasUpdate ? (
                <a
                  href={
                    updateInfo.releaseUrl || 'https://github.com/OtterBoops/agylity/releases/latest'
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1 rounded bg-pine-iris/20 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-pine-iris transition-colors hover:bg-pine-iris/30"
                  title={`New version v${updateInfo.latestVersion} available`}
                >
                  <span>Update v{updateInfo.latestVersion}</span>
                  <Icon icon={faArrowUpRightFromSquare} class="size-2.5" />
                </a>
              ) : (
                <span class="text-[0.6875rem] text-pine-muted/70">Up to date</span>
              )}
            </div>
          </div>
        </div>
      </aside>

      <ConnectionInspectorModal
        isOpen={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        lastProbeSource={lastProbeSource}
        lastProbeAt={lastProbeAt}
        orchestratorEnabled={orchestratorEnabled}
        minHeadroomPercent={minHeadroomPercent}
      />
    </>
  );
};
