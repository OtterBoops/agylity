import { useState, useEffect } from 'preact/hooks';
import { useHashRoute, type Route } from './router';
import { type ThemeChoice, normalizeStoredTheme, resolveEffectiveTheme } from './theme';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { QuotaGrid } from './components/QuotaGrid';
import { DispatchModal } from './components/DispatchModal';
import { CommandPalette } from './components/CommandPalette';
import { ActivityView } from './views/ActivityView';
import { LogsView } from './views/LogsView';
import { SettingsView } from './views/SettingsView';
import {
  useStore,
  quotaStore,
  configStore,
  refreshQuota,
  refreshConfig,
  startQuotaPolling,
} from './state';

const TITLES: Record<Route, [string, string]> = {
  overview: ['Overview', ''],
  logs: ['Logs', ''],
  'settings/notifications': ['Notifications', ''],
  'settings/remote': ['Orchestrator', ''],
  'settings/repositories': ['Repositories', ''],
  'settings/advanced': ['Advanced', ''],
};

export const App = () => {
  const [route, navigate] = useHashRoute();
  const [theme, setTheme] = useState<ThemeChoice>(() =>
    normalizeStoredTheme(localStorage.getItem('agylity-theme'))
  );
  const { quota, alerts } = useStore(quotaStore);
  const { config } = useStore(configStore);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshCooldown, setRefreshCooldown] = useState(0);
  const [dispatchModalOpen, setDispatchModalOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleToggleTheme = () => {
    const sequence: ThemeChoice[] = ['regular', 'moon', 'dawn', 'system'];
    const nextIdx = (sequence.indexOf(theme) + 1) % sequence.length;
    setTheme(sequence[nextIdx]!);
  };

  useEffect(() => {
    const apply = () => {
      const effective = resolveEffectiveTheme(theme);
      document.documentElement.setAttribute('data-theme', effective);
    };

    apply();
    localStorage.setItem('agylity-theme', theme);

    if (theme === 'system' && typeof window !== 'undefined' && window.matchMedia) {
      const media = window.matchMedia('(prefers-color-scheme: light)');
      const listener = () => apply();
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    }
  }, [theme]);

  const fetchAll = () =>
    Promise.all([refreshQuota(), refreshConfig()]).catch((err) => {
      console.error('[agylity] Fetch error:', err);
    });

  useEffect(() => {
    refreshConfig();
    const stopPolling = startQuotaPolling(60000);
    return () => stopPolling();
  }, []);

  const handleManualRefresh = () => {
    if (refreshCooldown > 0 || isRefreshing) return;
    setIsRefreshing(true);
    fetchAll().finally(() => {
      setIsRefreshing(false);
      setRefreshCooldown(2);
    });
  };

  useEffect(() => {
    if (refreshCooldown <= 0) return;
    const timer = setInterval(() => setRefreshCooldown((c) => c - 1), 1000);
    return () => clearInterval(timer);
  }, [refreshCooldown]);

  const [title, subtitle] = TITLES[route];

  return (
    <div class="min-h-screen bg-pine-base text-pine-text md:flex md:h-screen md:overflow-hidden">
      <Sidebar
        route={route}
        onNavigate={navigate}
        orchestratorEnabled={Boolean(config.resolved?.orchestratorEnabled)}
        lastProbeSource={alerts?.lastProbeSource}
        lastProbeAt={alerts?.lastProbeAt}
        minHeadroomPercent={config.resolved?.minDispatchHeadroomPercent ?? 10}
      />

      <div class="min-w-0 flex-1 p-4 sm:p-6 md:h-screen md:overflow-y-auto md:p-8 2xl:p-10">
        <div class="mx-auto max-w-7xl 2xl:max-w-[1760px]">
          <TopBar
            title={title}
            subtitle={subtitle}
            isRefreshing={isRefreshing}
            refreshCooldown={refreshCooldown}
            orchestratorEnabled={Boolean(config.resolved?.orchestratorEnabled)}
            theme={theme}
            onThemeChange={setTheme}
            onRefresh={handleManualRefresh}
            onOpenDispatch={() => setDispatchModalOpen(true)}
            onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          />

          <main>
            {route === 'overview' && (
              <>
                <QuotaGrid
                  quota={quota}
                  minHeadroomPercent={config.resolved?.minDispatchHeadroomPercent ?? 10}
                />
                <ActivityView alerts={alerts} />
              </>
            )}
            {route === 'logs' && <LogsView />}
            {route.startsWith('settings/') && (
              <SettingsView route={route} config={config} onChanged={fetchAll} />
            )}
          </main>
        </div>
      </div>

      <DispatchModal
        isOpen={dispatchModalOpen}
        onClose={() => setDispatchModalOpen(false)}
        config={config}
        quota={quota}
      />

      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onNavigate={navigate}
        onRefresh={handleManualRefresh}
        onOpenDispatch={() => setDispatchModalOpen(true)}
        onToggleTheme={handleToggleTheme}
        orchestratorEnabled={Boolean(config.resolved?.orchestratorEnabled)}
      />
    </div>
  );
};
