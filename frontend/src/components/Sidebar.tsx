import type { Route } from '../router';

interface SidebarProps {
  route: Route;
  onNavigate: (route: Route) => void;
  theme: string;
  onThemeChange: (theme: string) => void;
  lastProbeSource?: string;
  lastProbeAt?: string;
}

interface NavItem {
  route: Route;
  label: string;
  icon: string;
}

const MAIN: NavItem[] = [
  { route: 'overview', label: 'Overview', icon: '◉' },
  { route: 'logs', label: 'Logs', icon: '☰' },
];

const SETTINGS: NavItem[] = [
  { route: 'settings/notifications', label: 'Notifications', icon: '✉' },
  { route: 'settings/remote', label: 'Orchestrator', icon: '🐝' },
  { route: 'settings/repositories', label: 'Repositories', icon: '⌥' },
  { route: 'settings/advanced', label: 'Advanced', icon: '⚙' },
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
        ? 'border-l-2 border-pine-iris bg-pine-iris/20 pl-2.5 font-semibold text-pine-iris'
        : 'text-pine-subtle hover:bg-pine-overlay/60 hover:text-pine-text'
    }`}
  >
    <span class="text-base leading-none">{item.icon}</span>
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
      <div class="p-4 md:p-6">
        <div class="mb-6 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <span class="text-xl">🕊️</span>
            <div>
              <span class="block text-base font-bold tracking-tight text-pine-text">agylity</span>
              <span class="block font-mono text-[10px] text-pine-muted">Node 24 Sentry</span>
            </div>
          </div>
          <select
            value={theme}
            onChange={(e) => onThemeChange((e.target as HTMLSelectElement).value)}
            class="cursor-pointer rounded border border-pine-highlight bg-pine-overlay px-2 py-1 text-[11px] text-pine-subtle outline-none"
            title="Change theme"
          >
            <option value="rose-pine">Rosé Pine</option>
            <option value="rose-pine-moon">Moon</option>
            <option value="rose-pine-dawn">Dawn (Light)</option>
          </select>
        </div>

        <nav class="flex flex-col gap-6">
          <div class="flex flex-col gap-1">
            <span class="mb-1 px-3 text-[10px] font-bold tracking-wider text-pine-muted uppercase">
              Monitor
            </span>
            {MAIN.map((item) => (
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
            {SETTINGS.map((item) => (
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

      <div class="border-t border-pine-highlight/60 bg-pine-overlay/30 p-4">
        <div class="flex items-center gap-2 text-xs text-pine-subtle">
          <span class={`inline-block h-2 w-2 rounded-full ${probeColor}`} />
          <span class="font-medium text-pine-text">{probeStatus}</span>
        </div>
        {lastProbeAt && (
          <div class="mt-1 truncate text-[10px] text-pine-muted" title={lastProbeAt}>
            Probe: {new Date(lastProbeAt).toLocaleTimeString()}
          </div>
        )}
      </div>
    </aside>
  );
};
