import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { Link } from 'preact-router/match';
import {
  faAnglesLeft,
  faAnglesRight,
  faArrowUpRightFromSquare,
  faBars,
  faBell,
  faChartPie,
  faCheckToSlot,
  faBullhorn,
  faGear,
  faList,
  faNetworkWired,
  faSliders,
  faXmark,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import { Icon } from './Icon';
import { describeProbe } from '../utils/probe';
import { APP_VERSION, fetchLatestRelease, isNewerVersion } from '../utils/version';
import { formatTime, useTimeFormat } from '../utils/time';
import { ConnectionInspectorModal } from './ConnectionInspectorModal';

interface SidebarProps {
  coordinatorEnabled?: boolean;
  lastProbeSource?: string;
  lastProbeAt?: string;
  minHeadroomPercent?: number;
}

interface NavItem {
  href: string;
  label: string;
  icon: IconDefinition;
  badge?: string;
  /** Set for hash-routed items, where the router can only match the pathname. */
  active?: boolean;
}

export const Sidebar = ({
  coordinatorEnabled = false,
  lastProbeSource,
  lastProbeAt,
  minHeadroomPercent = 10,
}: SidebarProps) => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const mobileNavRef = useRef<HTMLDivElement>(null);
  const mobileToggleRef = useRef<HTMLButtonElement>(null);

  // Closing returns the caret to the control that opened the drawer.
  const closeMobileNav = useCallback(() => {
    setMobileOpen(false);
    mobileToggleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // A native dialog on top owns Escape; closing both would discard its work.
      if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      closeMobileNav();
    };
    document.addEventListener('keydown', onKeyDown);
    mobileNavRef.current?.querySelector<HTMLElement>('a[href]')?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen, closeMobileNav]);
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

  const monitorItems: NavItem[] = [
    { href: '/overview', label: 'Overview', icon: faChartPie },
    ...(coordinatorEnabled ? [{ href: '/tasks', label: 'Tasks', icon: faCheckToSlot }] : []),
    { href: '/alerts', label: 'Alerts', icon: faBell },
    { href: '/logs', label: 'Logs', icon: faList },
  ];

  // Settings is a group, not a destination: each section is its own sidebar entry, so the page no
  // longer needs a second, in-content tab strip.
  const [settingsHash, setSettingsHash] = useState(() =>
    typeof window === 'undefined' ? 'general' : window.location.hash.replace(/^#/, '') || 'general'
  );
  useEffect(() => {
    const sync = () => setSettingsHash(window.location.hash.replace(/^#/, '') || 'general');
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const onSettings = typeof window !== 'undefined' && window.location.pathname === '/settings';
  const settingsItems: NavItem[] = [
    { href: '/settings#general', label: 'General', icon: faGear },
    { href: '/settings#coordinator', label: 'Coordinator', icon: faNetworkWired },
    { href: '/settings#notifications', label: 'Notifications', icon: faBullhorn },
    { href: '/settings#advanced', label: 'Advanced', icon: faSliders },
  ].map((item) => ({ ...item, active: onSettings && settingsHash === item.href.split('#')[1] }));

  const [timeFormat] = useTimeFormat();

  const [isWide, setIsWide] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia('(min-width: 1280px)').matches
  );
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1280px)');
    const sync = () => setIsWide(query.matches);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  const { label: probeStatus, color: probeColor } = describeProbe(lastProbeSource);

  // The rail is forced below xl, so the footer keys off rendered width, not the preference.
  const railActive = isCollapsed || !isWide;
  const probeAtLabel = lastProbeAt
    ? formatTime(lastProbeAt, { includeSeconds: false, timeFormat })
    : null;
  const railTitle = `${probeStatus} · ${probeAtLabel ? `last probe ${probeAtLabel}` : 'no probe yet'} · v${APP_VERSION}${
    updateInfo.hasUpdate ? ` · update v${updateInfo.latestVersion} available` : ''
  }`;

  const renderNavSection = (
    title: string | null,
    items: NavItem[],
    collapsed = false,
    onLinkClick?: () => void
  ) => (
    <div class="flex flex-col gap-1">
      {!collapsed && title ? (
        <div class="flex items-center gap-2 px-2 py-0.5">
          <span class="text-xs font-bold tracking-widest text-pine-subtle uppercase">{title}</span>
          <span class="h-px flex-1 bg-pine-highlight/30" />
        </div>
      ) : (
        <div class="my-1 h-px w-full bg-pine-highlight/30" title={title ?? undefined} />
      )}
      <div class="flex flex-col gap-0.5">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={onLinkClick}
            activeClassName={
              item.active === undefined ? 'bg-pine-iris/15 font-semibold !text-pine-iris' : ''
            }
            title={collapsed ? item.label : undefined}
            class={`group relative flex w-full cursor-pointer items-center rounded-xl transition-all duration-150 ${
              item.active
                ? 'bg-pine-iris/15 font-semibold text-pine-iris'
                : 'text-pine-subtle hover:bg-pine-overlay/60 hover:text-pine-text'
            } ${
              collapsed
                ? 'justify-center px-1 py-2'
                : 'gap-3 px-3 py-2 text-left text-sm font-medium whitespace-nowrap'
            }`}
          >
            <div class="flex size-8 shrink-0 items-center justify-center rounded-lg border border-pine-highlight bg-pine-overlay/40 text-pine-subtle transition-colors group-hover:bg-pine-overlay group-hover:text-pine-text group-[.text-pine-iris]:border-pine-iris/30 group-[.text-pine-iris]:text-pine-iris">
              <Icon icon={item.icon} class="size-4" />
            </div>
            {!collapsed && (
              <>
                <span class="shrink-0 whitespace-nowrap group-[.text-pine-iris]:text-pine-iris">
                  {item.label}
                </span>
                {item.badge && (
                  <span class="ml-auto rounded-sm border border-pine-highlight bg-pine-overlay px-1.5 py-0.5 text-xs font-semibold tracking-wider whitespace-nowrap text-pine-subtle uppercase">
                    {item.badge}
                  </span>
                )}
              </>
            )}
          </Link>
        ))}
      </div>
    </div>
  );

  return (
    <>
      <div class="sticky top-0 z-40 flex h-14 w-full items-center justify-between border-b border-pine-highlight bg-pine-surface px-4 md:hidden">
        <Link href="/overview" class="flex items-center gap-2.5">
          <div class="flex size-8 shrink-0 items-center justify-center rounded-lg border border-pine-highlight bg-pine-overlay">
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
              class={`absolute inline-flex size-full rounded-full opacity-75 motion-reduce:animate-none ${probeColor}`}
            />
            <span class={`relative inline-flex size-2 rounded-full ${probeColor}`} />
          </span>
        </Link>
        <button
          ref={mobileToggleRef}
          type="button"
          onClick={() => (mobileOpen ? closeMobileNav() : setMobileOpen(true))}
          class="flex size-11 cursor-pointer items-center justify-center rounded-lg border border-pine-highlight bg-pine-overlay/60 text-pine-text transition-colors hover:bg-pine-highlight focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
          aria-label="Toggle navigation menu"
          aria-expanded={mobileOpen}
          aria-controls="mobile-nav"
        >
          <Icon icon={mobileOpen ? faXmark : faBars} class="size-4" />
        </button>
      </div>

      {mobileOpen && (
        <>
          <div
            class="fixed inset-0 z-50 bg-black/60 md:hidden"
            aria-hidden="true"
            onClick={closeMobileNav}
          />
          <div
            id="mobile-nav"
            ref={mobileNavRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            class="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col gap-4 overflow-y-auto border-r border-pine-highlight bg-pine-surface p-4 md:hidden"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs font-bold tracking-widest text-pine-subtle uppercase">
                Navigation
              </span>
              <button
                type="button"
                onClick={closeMobileNav}
                aria-label="Close navigation menu"
                class="flex size-11 cursor-pointer items-center justify-center rounded-lg text-pine-muted transition-colors hover:bg-pine-overlay hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
              >
                <Icon icon={faXmark} class="size-4" />
              </button>
            </div>
            <nav class="flex flex-col gap-3">
              {renderNavSection('Monitor', monitorItems, false, closeMobileNav)}
              {renderNavSection('Settings', settingsItems, false, closeMobileNav)}
            </nav>

            <div class="mt-4 flex flex-col gap-2 rounded-xl border border-pine-highlight bg-pine-surface p-3 text-xs">
              <button
                type="button"
                onClick={() => setInspectorOpen(true)}
                aria-label="Connection telemetry"
                class="flex cursor-pointer items-center justify-between gap-2 text-left transition-colors hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
              >
                <span class="flex items-center gap-2">
                  <span class="relative flex size-2 shrink-0">
                    <span
                      class={`absolute inline-flex size-full rounded-full opacity-75 motion-reduce:animate-none ${probeColor}`}
                    />
                    <span class={`relative inline-flex size-2 rounded-full ${probeColor}`} />
                  </span>
                  <span class="font-medium text-pine-text">{probeStatus}</span>
                </span>
                {lastProbeAt && (
                  <span class="shrink-0 font-mono text-xs text-pine-subtle" title={lastProbeAt}>
                    {formatTime(lastProbeAt, { includeSeconds: false, timeFormat })}
                  </span>
                )}
              </button>

              <div class="flex items-center justify-between border-t border-pine-highlight/60 pt-2 font-mono text-xs text-pine-muted">
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
                      updateInfo.releaseUrl ||
                      'https://github.com/OtterBoops/agylity/releases/latest'
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    class="flex items-center gap-1 rounded-sm bg-pine-iris/20 px-1.5 py-0.5 text-xs font-semibold text-pine-iris hover:bg-pine-iris/30"
                  >
                    <span>Update v{updateInfo.latestVersion}</span>
                    <Icon icon={faArrowUpRightFromSquare} class="size-2.5" />
                  </a>
                ) : (
                  <span class="text-xs text-pine-muted/70">Up to date</span>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      <aside
        class={`hidden md:flex md:h-full md:shrink-0 md:flex-col md:justify-between md:overflow-y-auto md:border-r md:border-pine-highlight md:bg-pine-surface/95 ${
          isCollapsed ? 'md:w-16' : 'md:w-16 xl:w-60 2xl:w-64'
        }`}
      >
        <div class={railActive ? 'px-2 py-4' : 'px-3 py-4 md:px-3.5 md:py-4'}>
          <div
            class={`mb-6 flex items-center transition-all ${
              railActive ? 'flex-col justify-center gap-2 px-0' : 'justify-between px-1'
            }`}
          >
            <Link
              href="/overview"
              class="flex cursor-pointer items-center gap-2.5"
              title="Agylity Dashboard"
            >
              <div class="flex size-9 shrink-0 items-center justify-center rounded-lg border border-pine-highlight bg-pine-overlay">
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
              {!railActive && (
                <span class="text-xl leading-none font-bold tracking-tight text-pine-text">
                  Agylity
                </span>
              )}
            </Link>

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

          <nav class="flex flex-col gap-3">
            {renderNavSection('Monitor', monitorItems, railActive)}
            {renderNavSection('Settings', settingsItems, railActive)}
          </nav>
        </div>

        <div class={railActive ? 'p-2' : 'p-3 pt-0'}>
          {!railActive ? (
            <div
              role="button"
              tabIndex={0}
              aria-label="Connection telemetry"
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setInspectorOpen(true);
                }
              }}
              onClick={() => setInspectorOpen(true)}
              class="flex cursor-pointer flex-col gap-2 rounded-xl border border-pine-highlight bg-pine-surface p-3 transition-colors hover:border-pine-iris/60"
              title="Click to view detailed system telemetry"
            >
              <div class="flex items-center justify-between text-xs">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="relative flex size-2 shrink-0">
                    <span
                      class={`absolute inline-flex size-full rounded-full opacity-75 motion-reduce:animate-none ${probeColor}`}
                    />
                    <span class={`relative inline-flex size-2 rounded-full ${probeColor}`} />
                  </span>
                  <span class="truncate font-medium text-pine-text">{probeStatus}</span>
                </div>
                {lastProbeAt && (
                  <span class="shrink-0 font-mono text-xs text-pine-subtle" title={lastProbeAt}>
                    {formatTime(lastProbeAt, { includeSeconds: false, timeFormat })}
                  </span>
                )}
              </div>

              <div
                class="flex items-center justify-between border-t border-pine-highlight pt-2 font-mono text-xs text-pine-subtle"
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
                  <span class="text-xs text-pine-subtle">Up to date</span>
                )}
              </div>
            </div>
          ) : (
            <div
              role="button"
              tabIndex={0}
              aria-label={`Connection status: ${railTitle}. Activate to inspect telemetry.`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setInspectorOpen(true);
                }
              }}
              onClick={() => setInspectorOpen(true)}
              class="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-pine-highlight bg-pine-surface px-0 py-2 text-center transition-colors hover:border-pine-iris/60"
              title={railTitle}
            >
              <span class="relative flex size-2.5 shrink-0">
                <span
                  class={`absolute inline-flex size-full rounded-full opacity-75 motion-reduce:animate-none ${probeColor}`}
                />
                <span class={`relative inline-flex size-2.5 rounded-full ${probeColor}`} />
              </span>
              <span class="max-w-full truncate font-mono text-xs leading-none text-pine-subtle">
                v{APP_VERSION}
              </span>
            </div>
          )}
        </div>
      </aside>

      <ConnectionInspectorModal
        isOpen={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        lastProbeSource={lastProbeSource}
        lastProbeAt={lastProbeAt}
        coordinatorEnabled={coordinatorEnabled}
        minHeadroomPercent={minHeadroomPercent}
      />
    </>
  );
};
