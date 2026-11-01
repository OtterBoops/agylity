import { useState, useEffect } from 'preact/hooks';
import {
  faAnglesLeft,
  faAnglesRight,
  faArrowUpRightFromSquare,
  faBars,
  faBell,
  faChartPie,
  faCheckToSlot,
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
  badge?: string;
}

const MONITOR: NavItem[] = [{ route: 'overview', label: 'Overview', icon: faChartPie }];

const SYSTEM: NavItem[] = [
  { route: 'logs', label: 'Logs', icon: faList },
  { route: 'settings/advanced', label: 'Advanced', icon: faSliders },
];

const NavButton = ({
  item,
  active,
  collapsed = false,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  collapsed?: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-current={active ? 'page' : undefined}
    title={collapsed ? item.label : undefined}
    class={`group relative flex w-full cursor-pointer items-center rounded-xl transition-all duration-150 ${
      collapsed
        ? 'justify-center px-1 py-2'
        : 'gap-3 px-3 py-2 text-left text-sm font-medium whitespace-nowrap'
    } ${
      active
        ? 'bg-pine-iris/15 font-semibold text-pine-iris'
        : 'text-pine-subtle hover:bg-pine-overlay/60 hover:text-pine-text'
    }`}
  >
    {active && (
      <span
        class={`absolute rounded-full bg-pine-iris transition-all ${
          collapsed ? 'left-0.5 h-5 w-1' : '-left-1 h-5 w-1.5'
        }`}
      />
    )}
    <div
      class={`flex size-8 shrink-0 items-center justify-center rounded-lg border transition-colors ${
        active
          ? 'border-pine-iris/30 bg-pine-iris/20 text-pine-iris shadow-xs'
          : 'border-pine-highlight bg-pine-overlay/40 text-pine-subtle group-hover:bg-pine-overlay group-hover:text-pine-text'
      }`}
    >
      <Icon icon={item.icon} class="size-4" />
    </div>
    {!collapsed && (
      <>
        <span class="shrink-0 whitespace-nowrap">{item.label}</span>
        {item.badge && (
          <span class="ml-auto rounded-sm border border-pine-highlight bg-pine-overlay px-1.5 py-0.5 text-[11px] font-semibold tracking-wider whitespace-nowrap text-pine-muted uppercase">
            {item.badge}
          </span>
        )}
      </>
    )}
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
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      try {
        return localStorage.getItem('agylity_sidebar_collapsed') === 'true';
      } catch {
        return false;
      }
    }
    return false;
  });

  const toggleCollapse = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('agylity_sidebar_collapsed', String(next));
      } catch {}
      return next;
    });
  };

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

  const configurationItems: NavItem[] = [
    { route: 'settings/notifications' as Route, label: 'Notifications', icon: faBell },
    {
      route: 'settings/orchestrator' as Route,
      label: 'Orchestrator',
      icon: faNetworkWired,
      badge: orchestratorEnabled ? 'Active' : undefined,
    },
    ...(orchestratorEnabled
      ? [
          { route: 'tasks' as Route, label: 'Tasks', icon: faCheckToSlot },
          { route: 'settings/repositories' as Route, label: 'Repositories', icon: faCodeBranch },
        ]
      : []),
  ];

  const handleNav = (r: Route) => {
    onNavigate(r);
    setMobileOpen(false);
  };

  const probeStatus =
    lastProbeSource === 'connect_rpc'
      ? 'Live Connect-RPC'
      : lastProbeSource === 'cli' || lastProbeSource === 'cli_fallback'
        ? 'CLI Fallback'
        : 'Offline';
  const probeColor =
    lastProbeSource === 'connect_rpc'
      ? 'bg-pine-pine'
      : lastProbeSource === 'cli' || lastProbeSource === 'cli_fallback'
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
              class={`absolute inline-flex size-full animate-ping rounded-full opacity-75 ${probeColor}`}
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
          <div
            onClick={() => setInspectorOpen(true)}
            class="mt-4 flex cursor-pointer flex-col gap-2 rounded-xl border border-pine-highlight bg-pine-base/40 p-3 text-xs transition-colors hover:border-pine-iris/50"
          >
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="relative flex size-2 shrink-0">
                  <span
                    class={`absolute inline-flex size-full animate-ping rounded-full opacity-75 ${probeColor}`}
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
                  class="inline-flex items-center gap-1 rounded-sm bg-pine-iris/20 px-1.5 py-0.5 text-[10px] font-semibold text-pine-iris hover:bg-pine-iris/30"
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

      {/* Desktop Collapsible Sidebar */}
      <aside
        class={`hidden transition-[width] duration-200 ease-in-out md:flex md:h-screen md:shrink-0 md:flex-col md:justify-between md:overflow-y-auto md:border-r md:border-pine-highlight md:bg-pine-surface/95 md:backdrop-blur-md ${
          isCollapsed ? 'md:w-16' : 'md:w-60 2xl:w-64'
        }`}
      >
        <div class={isCollapsed ? 'px-2 py-4' : 'px-3 py-4 md:px-3.5 md:py-4'}>
          {/* Brand Header & Pin/Collapse Button */}
          <div
            class={`mb-6 flex items-center transition-all ${
              isCollapsed ? 'flex-col justify-center gap-2 px-0' : 'justify-between px-1'
            }`}
          >
            <div
              class="flex cursor-pointer items-center gap-2.5"
              onClick={() => handleNav('overview')}
              title="Agylity Dashboard"
            >
              <div class="flex size-9 shrink-0 items-center justify-center rounded-lg border border-pine-highlight bg-pine-overlay shadow-xs">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  class="size-5 text-pine-iris"
                  aria-hidden="true"
                >
                  <path
                    fill-rule="evenodd"
                    clip-rule="evenodd"
                    d="M10.882 1.441A1.25 1.25 0 0 1 13.118 1.441L22.118 19.441A1.25 1.25 0 0 1 21 21.25H17A1.25 1.25 0 0 1 15.882 20.559L13.727 16.25H10.273L8.118 20.559A1.25 1.25 0 0 1 7 21.25H3A1.25 1.25 0 0 1 1.882 19.441ZM11.598 9.899A0.45 0.45 0 0 1 12.402 9.899L13.652 12.399A0.45 0.45 0 0 1 13.25 13.05H10.75A0.45 0.45 0 0 1 10.348 12.399Z"
                    fill="currentColor"
                  />
                </svg>
              </div>
              {!isCollapsed && (
                <span class="text-xl leading-none font-bold tracking-tight text-pine-text">
                  Agylity
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={toggleCollapse}
              class="flex size-7 cursor-pointer items-center justify-center rounded-lg border border-transparent text-pine-muted transition-colors hover:border-pine-highlight hover:bg-pine-overlay hover:text-pine-text"
              title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <Icon icon={isCollapsed ? faAnglesRight : faAnglesLeft} class="size-3.5" />
            </button>
          </div>

          <nav class="flex flex-col gap-4">
            <div class="flex flex-col gap-1">
              {!isCollapsed ? (
                <div class="flex items-center gap-2 px-2 py-0.5">
                  <span class="text-[11px] font-bold tracking-widest text-pine-muted uppercase">
                    Monitor
                  </span>
                  <span class="h-px flex-1 bg-pine-highlight/30" />
                </div>
              ) : (
                <div class="my-1 h-px w-full bg-pine-highlight/30" title="Monitor" />
              )}
              <div class="flex flex-col gap-0.5">
                {MONITOR.map((item) => (
                  <NavButton
                    key={item.route}
                    item={item}
                    active={route === item.route}
                    collapsed={isCollapsed}
                    onClick={() => onNavigate(item.route)}
                  />
                ))}
              </div>
            </div>

            <div class="flex flex-col gap-1">
              {!isCollapsed ? (
                <div class="flex items-center gap-2 px-2 py-0.5">
                  <span class="text-[11px] font-bold tracking-widest text-pine-muted uppercase">
                    Configuration
                  </span>
                  <span class="h-px flex-1 bg-pine-highlight/30" />
                </div>
              ) : (
                <div class="my-1 h-px w-full bg-pine-highlight/30" title="Configuration" />
              )}
              <div class="flex flex-col gap-0.5">
                {configurationItems.map((item) => (
                  <NavButton
                    key={item.route}
                    item={item}
                    active={route === item.route}
                    collapsed={isCollapsed}
                    onClick={() => onNavigate(item.route)}
                  />
                ))}
              </div>
            </div>

            <div class="flex flex-col gap-1">
              {!isCollapsed ? (
                <div class="flex items-center gap-2 px-2 py-0.5">
                  <span class="text-[11px] font-bold tracking-widest text-pine-muted uppercase">
                    System
                  </span>
                  <span class="h-px flex-1 bg-pine-highlight/30" />
                </div>
              ) : (
                <div class="my-1 h-px w-full bg-pine-highlight/30" title="System" />
              )}
              <div class="flex flex-col gap-0.5">
                {SYSTEM.map((item) => (
                  <NavButton
                    key={item.route}
                    item={item}
                    active={route === item.route}
                    collapsed={isCollapsed}
                    onClick={() => onNavigate(item.route)}
                  />
                ))}
              </div>
            </div>
          </nav>
        </div>

        {/* Desktop Homepage-style Telemetry & Version Footer */}
        <div class={isCollapsed ? 'p-2' : 'p-3 pt-0'}>
          {!isCollapsed ? (
            <div
              onClick={() => setInspectorOpen(true)}
              class="flex cursor-pointer flex-col gap-2 rounded-xl border border-pine-highlight bg-pine-base/40 p-3 shadow-xs transition-colors hover:border-pine-iris/60"
              title="Click to view detailed system telemetry"
            >
              <div class="flex items-center justify-between text-xs">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="relative flex size-2 shrink-0">
                    <span
                      class={`absolute inline-flex size-full animate-ping rounded-full opacity-75 ${probeColor}`}
                    />
                    <span class={`relative inline-flex size-2 rounded-full ${probeColor}`} />
                  </span>
                  <span class="truncate font-medium text-pine-text">{probeStatus}</span>
                </div>
                {lastProbeAt && (
                  <span class="shrink-0 font-mono text-[11px] text-pine-muted" title={lastProbeAt}>
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
                      updateInfo.releaseUrl ||
                      'https://github.com/OtterBoops/agylity/releases/latest'
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-1 rounded-sm bg-pine-iris/20 px-1.5 py-0.5 text-xs font-semibold text-pine-iris transition-colors hover:bg-pine-iris/30"
                    title={`New version v${updateInfo.latestVersion} available`}
                  >
                    <span>Update v{updateInfo.latestVersion}</span>
                    <Icon icon={faArrowUpRightFromSquare} class="size-2.5" />
                  </a>
                ) : (
                  <span class="text-xs text-pine-muted/70">Up to date</span>
                )}
              </div>
            </div>
          ) : (
            <div
              onClick={() => setInspectorOpen(true)}
              class="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-pine-highlight bg-pine-base/40 p-2 text-center shadow-xs transition-colors hover:border-pine-iris/60"
              title={`${probeStatus} - Click to inspect telemetry (v${APP_VERSION})`}
            >
              <span class="relative flex size-2.5 shrink-0">
                <span
                  class={`absolute inline-flex size-full animate-ping rounded-full opacity-75 ${probeColor}`}
                />
                <span class={`relative inline-flex size-2.5 rounded-full ${probeColor}`} />
              </span>
              <span class="font-mono text-[10px] text-pine-muted">v{APP_VERSION}</span>
            </div>
          )}
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
