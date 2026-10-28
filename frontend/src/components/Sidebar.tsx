import { useState, useEffect } from 'preact/hooks';
import {
  faArrowUpRightFromSquare,
  faBars,
  faBell,
  faChartPie,
  faCodeBranch,
  faDove,
  faList,
  faNetworkWired,
  faSliders,
  faXmark,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import type { Route } from '../router';
import { Icon } from './Icon';
import { APP_VERSION, fetchLatestRelease, isNewerVersion } from '../utils/version';

interface SidebarProps {
  route: Route;
  onNavigate: (route: Route) => void;
  orchestratorEnabled?: boolean;
  lastProbeSource?: string;
  lastProbeAt?: string;
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
    class={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium whitespace-nowrap transition-colors ${
      active
        ? 'bg-pine-iris/15 font-semibold text-pine-iris'
        : 'text-pine-subtle hover:bg-pine-overlay/60 hover:text-pine-text'
    }`}
  >
    <Icon icon={item.icon} class="size-4 shrink-0" />
    <span>{item.label}</span>
  </button>
);

export const Sidebar = ({
  route,
  onNavigate,
  orchestratorEnabled = false,
  lastProbeSource,
  lastProbeAt,
}: SidebarProps) => {
  const [mobileOpen, setMobileOpen] = useState(false);
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
          <Icon icon={faDove} class="size-5 text-pine-iris" />
          <span class="text-lg font-bold tracking-tight text-pine-text">agylity</span>
          <span class={`size-2 rounded-full ${probeColor}`} title={probeStatus} />
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
              <span class="mb-0.5 px-3 text-[10px] font-bold tracking-wider text-pine-muted uppercase">
                Monitor
              </span>
              {MONITOR.map((item) => (
                <NavButton
                  key={item.route}
                  item={item}
                  active={route === item.route}
                  onClick={() => handleNav(item.route)}
                />
              ))}
            </div>

            <div class="flex flex-col gap-1">
              <span class="mb-0.5 px-3 text-[10px] font-bold tracking-wider text-pine-muted uppercase">
                Configuration
              </span>
              {configurationItems.map((item) => (
                <NavButton
                  key={item.route}
                  item={item}
                  active={route === item.route}
                  onClick={() => handleNav(item.route)}
                />
              ))}
            </div>

            <div class="flex flex-col gap-1">
              <span class="mb-0.5 px-3 text-[10px] font-bold tracking-wider text-pine-muted uppercase">
                System
              </span>
              {SYSTEM.map((item) => (
                <NavButton
                  key={item.route}
                  item={item}
                  active={route === item.route}
                  onClick={() => handleNav(item.route)}
                />
              ))}
            </div>
          </nav>

          {/* Mobile Telemetry & Version Footer */}
          <div class="mt-4 flex flex-col gap-2 border-t border-pine-highlight/60 pt-3 text-xs">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class={`size-2 rounded-full ${probeColor}`} />
                <span class="font-medium text-pine-text">{probeStatus}</span>
              </div>
              {lastProbeAt && (
                <span class="font-mono text-[10px] text-pine-muted" title={lastProbeAt}>
                  {new Date(lastProbeAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
              )}
            </div>
            <div class="flex items-center justify-between font-mono text-[11px] text-pine-muted">
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

      {/* Desktop Sticky Sidebar */}
      <aside class="hidden md:sticky md:top-0 md:flex md:min-h-screen md:w-60 md:shrink-0 md:flex-col md:justify-between md:border-r md:border-pine-highlight md:bg-pine-surface">
        <div class="p-5 md:p-6">
          {/* Brand Header */}
          <div class="mb-8 flex items-center gap-3 px-1">
            <Icon icon={faDove} class="size-6 shrink-0 text-pine-iris" />
            <span class="text-xl font-bold tracking-tight text-pine-text">agylity</span>
          </div>

          <nav class="flex flex-col gap-6">
            <div class="flex flex-col gap-1">
              <span class="mb-1 px-3 text-[10px] font-bold tracking-wider text-pine-muted uppercase">
                Monitor
              </span>
              {MONITOR.map((item) => (
                <NavButton
                  key={item.route}
                  item={item}
                  active={route === item.route}
                  onClick={() => onNavigate(item.route)}
                />
              ))}
            </div>

            <div class="flex flex-col gap-1">
              <span class="mb-1 px-3 text-[10px] font-bold tracking-wider text-pine-muted uppercase">
                Configuration
              </span>
              {configurationItems.map((item) => (
                <NavButton
                  key={item.route}
                  item={item}
                  active={route === item.route}
                  onClick={() => onNavigate(item.route)}
                />
              ))}
            </div>

            <div class="flex flex-col gap-1">
              <span class="mb-1 px-3 text-[10px] font-bold tracking-wider text-pine-muted uppercase">
                System
              </span>
              {SYSTEM.map((item) => (
                <NavButton
                  key={item.route}
                  item={item}
                  active={route === item.route}
                  onClick={() => onNavigate(item.route)}
                />
              ))}
            </div>
          </nav>
        </div>

        {/* Desktop Homepage-style Telemetry & Version Footer */}
        <div class="flex flex-col gap-2.5 border-t border-pine-highlight/60 bg-pine-overlay/20 px-4 py-3.5 text-xs">
          <div class="flex items-center justify-between text-xs">
            <div class="flex min-w-0 items-center gap-2">
              <span class={`size-2 shrink-0 rounded-full ${probeColor}`} />
              <span class="truncate font-medium text-pine-text">{probeStatus}</span>
            </div>
            {lastProbeAt && (
              <span class="shrink-0 font-mono text-[10px] text-pine-muted" title={lastProbeAt}>
                {new Date(lastProbeAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </span>
            )}
          </div>

          <div class="flex items-center justify-between pt-0.5 font-mono text-[11px] text-pine-muted">
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
                class="inline-flex items-center gap-1 rounded bg-pine-iris/20 px-1.5 py-0.5 text-[10px] font-semibold text-pine-iris transition-colors hover:bg-pine-iris/30"
                title={`New version v${updateInfo.latestVersion} available`}
              >
                <span>Update v{updateInfo.latestVersion}</span>
                <Icon icon={faArrowUpRightFromSquare} class="size-2.5" />
              </a>
            ) : (
              <span class="text-[10px] text-pine-muted/70">Up to date</span>
            )}
          </div>
        </div>
      </aside>
    </>
  );
};
