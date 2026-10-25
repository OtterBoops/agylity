import {
  faBell,
  faChartPie,
  faCodeBranch,
  faDove,
  faList,
  faNetworkWired,
  faSliders,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import type { Route } from '../router';
import { type ThemeChoice, THEME_OPTIONS, getThemeDisplayLabel } from '../theme';
import { Icon } from './Icon';

interface SidebarProps {
  route: Route;
  onNavigate: (route: Route) => void;
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
  lastProbeSource?: string;
  lastProbeAt?: string;
}

interface NavItem {
  route: Route;
  label: string;
  icon: IconDefinition;
}

const MONITOR: NavItem[] = [{ route: 'overview', label: 'Overview', icon: faChartPie }];

const CONFIGURATION: NavItem[] = [
  { route: 'settings/notifications', label: 'Notifications', icon: faBell },
  { route: 'settings/remote', label: 'Orchestrator', icon: faNetworkWired },
  { route: 'settings/repositories', label: 'Repositories', icon: faCodeBranch },
];

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
  theme,
  onThemeChange,
  lastProbeSource,
  lastProbeAt,
}: SidebarProps) => {
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
    <aside class="flex w-full shrink-0 flex-col justify-between border-r border-pine-highlight bg-pine-surface md:w-60">
      <div class="p-5 md:p-6">
        {/* Brand Header (Minimalist icon + name inspired by Arcane) */}
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
            {CONFIGURATION.map((item) => (
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

      <div class="flex flex-col gap-3 border-t border-pine-highlight/60 bg-pine-overlay/30 p-4">
        {/* 4-Stage Theme Toggle */}
        <div class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between px-0.5 text-[11px] font-medium text-pine-muted">
            <span>Theme</span>
            <span class="font-normal text-pine-subtle">{getThemeDisplayLabel(theme)}</span>
          </div>
          <div
            role="radiogroup"
            aria-label="Color theme"
            class="grid grid-cols-4 rounded-lg border border-pine-highlight/60 bg-pine-base/70 p-0.5 text-xs shadow-inner"
          >
            {THEME_OPTIONS.map((opt) => {
              const isSelected = theme === opt.id;
              return (
                <button
                  type="button"
                  key={opt.id}
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => onThemeChange(opt.id)}
                  title={opt.title}
                  class={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md py-1.5 transition-all ${
                    isSelected
                      ? 'bg-pine-surface font-semibold text-pine-iris shadow-xs'
                      : 'text-pine-muted hover:bg-pine-surface/50 hover:text-pine-text'
                  }`}
                >
                  <Icon icon={opt.icon} class="size-3.5" />
                  <span class="text-[10px] leading-tight font-medium">{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Live Probe Status Card */}
        <div class="flex items-center justify-between rounded-lg border border-pine-highlight/40 bg-pine-surface/50 px-3 py-2 text-xs">
          <div class="flex min-w-0 items-center gap-2">
            <span class={`inline-block size-2 shrink-0 rounded-full ${probeColor}`} />
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

        {/* Footer Version Indicator */}
        <div class="flex items-center justify-between px-1 font-mono text-[11px] text-pine-muted">
          <span>v0.1.0</span>
          <span>Node 24</span>
        </div>
      </div>
    </aside>
  );
};
