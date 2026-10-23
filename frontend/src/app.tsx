import { useState, useEffect } from 'preact/hooks';
import type { QuotaSnapshot, SentryAlertState, ConfigData } from './types';
import { useHashRoute, type Route } from './router';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { QuotaGrid } from './components/QuotaGrid';
import { DispatchModal } from './components/DispatchModal';
import { ActivityView } from './views/ActivityView';
import { LogsView } from './views/LogsView';
import { SettingsView } from './views/SettingsView';
import { getQuota, getAlerts, getConfig } from './api';

const TITLES: Record<Route, [string, string]> = {
  overview: ['Overview', 'Live quota, dispatched tasks, and sentry milestone state'],
  logs: ['Logs', 'Live daemon output'],
  'settings/notifications': ['Notifications', 'Where alerts and dispatch updates go'],
  'settings/remote': [
    'Orchestrator & Swarm',
    'Optional task continuation, swarm worker network, and dispatch routing',
  ],
  'settings/repositories': ['Repositories', 'Dispatch targets'],
  'settings/advanced': ['Advanced', 'Sentry tuning, Language Server RPC, and SQLite overrides'],
};

export const App = () => {
  const [route, navigate] = useHashRoute();
  const [theme, setTheme] = useState(() => localStorage.getItem('agylity-theme') || 'rose-pine');
  const [quota, setQuota] = useState<QuotaSnapshot[]>([]);
  const [alerts, setAlerts] = useState<SentryAlertState | null>(null);
  const [config, setConfig] = useState<ConfigData>({ resolved: {}, overrides: {} });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshCooldown, setRefreshCooldown] = useState(0);
  const [dispatchModalOpen, setDispatchModalOpen] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('agylity-theme', theme);
  }, [theme]);

  const fetchAll = () =>
    Promise.all([getQuota(), getAlerts(), getConfig()])
      .then(([qRes, aRes, cRes]) => {
        setQuota(qRes);
        setAlerts(aRes);
        setConfig(cRes);
      })
      .catch((err) => {
        console.error('[agylity] Fetch error:', err);
      });

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 15000);
    return () => clearInterval(interval);
  }, []);

  const handleManualRefresh = () => {
    if (refreshCooldown > 0 || isRefreshing) return;
    setIsRefreshing(true);
    fetchAll().finally(() => {
      setIsRefreshing(false);
      setRefreshCooldown(5);
    });
  };

  useEffect(() => {
    if (refreshCooldown <= 0) return;
    const timer = setInterval(() => setRefreshCooldown((c) => c - 1), 1000);
    return () => clearInterval(timer);
  }, [refreshCooldown]);

  const [title, subtitle] = TITLES[route];

  return (
    <div class="min-h-screen bg-pine-base text-pine-text md:flex">
      <Sidebar
        route={route}
        onNavigate={navigate}
        theme={theme}
        onThemeChange={setTheme}
        lastProbeSource={alerts?.lastProbeSource}
        lastProbeAt={alerts?.lastProbeAt}
      />

      <div class="min-w-0 flex-1 p-6 md:p-8">
        <div class="mx-auto max-w-6xl">
          <TopBar
            title={title}
            subtitle={subtitle}
            isRefreshing={isRefreshing}
            refreshCooldown={refreshCooldown}
            orchestratorEnabled={Boolean(config.resolved?.orchestratorEnabled)}
            onRefresh={handleManualRefresh}
            onOpenDispatch={() => setDispatchModalOpen(true)}
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
    </div>
  );
};
