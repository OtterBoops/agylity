import { useState, useEffect } from 'preact/hooks';
import { faCheck, faCopy } from '@fortawesome/free-solid-svg-icons';
import { Icon } from './components/Icon';
import { useHashRoute, type Route } from './router';
import { type ThemeChoice, normalizeStoredTheme, resolveEffectiveTheme } from './theme';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { QuotaGrid } from './components/QuotaGrid';
import { DispatchModal } from './components/DispatchModal';
import { ControlPlaneGate } from './components/ControlPlaneGate';
import { SessionModal } from './components/SessionModal';
import { CommandPalette } from './components/CommandPalette';
import { TasksView } from './components/TasksView';
import { ActivityView } from './views/ActivityView';
import { LogsView } from './views/LogsView';
import { SettingsView } from './views/SettingsView';
import { checkHealth, getAuthToken } from './api';
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
  tasks: ['Tasks', ''],
  logs: ['Logs', ''],
  'settings/notifications': ['Notifications', ''],
  'settings/orchestrator': ['Orchestrator', ''],
  'settings/remote': ['Orchestrator', ''],
  'settings/repositories': ['Repositories', ''],
  'settings/advanced': ['Advanced', ''],
};

export const App = () => {
  const [route, navigate] = useHashRoute();
  const [theme, setTheme] = useState<ThemeChoice>(() =>
    normalizeStoredTheme(localStorage.getItem('agylity-theme'))
  );
  const { quota, alerts, error: quotaError } = useStore(quotaStore);
  const { config } = useStore(configStore);
  const [authCopied, setAuthCopied] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshCooldown, setRefreshCooldown] = useState(0);
  const [dispatchModalOpen, setDispatchModalOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [sessionModalOpen, setSessionModalOpen] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  useEffect(() => {
    let mounted = true;
    checkHealth()
      .then((health) => {
        if (!mounted) return;
        if (health.authRequired && !getAuthToken()) {
          setIsLocked(true);
        } else {
          fetchAll();
        }
      })
      .catch(() => {
        if (!mounted) return;
        fetchAll();
      })
      .finally(() => {
        if (mounted) setIsCheckingAuth(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const handleUnauthorized = () => {
      setIsLocked(true);
      setSessionModalOpen(false);
    };
    window.addEventListener('agylity:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('agylity:unauthorized', handleUnauthorized);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
        return;
      }

      // Check if target is an interactive input
      const target = e.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (e.altKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        setDispatchModalOpen(true);
        return;
      }

      if (!isInput && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        handleManualRefresh();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [refreshCooldown, isRefreshing]);

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

  const checkIntervalMs =
    Math.max(30, Number(config.resolved?.quotaCheckIntervalSeconds) || 60) * 1000;

  useEffect(() => {
    if (isLocked || isCheckingAuth) return;
    const stopPolling = startQuotaPolling(checkIntervalMs);
    return () => stopPolling();
  }, [checkIntervalMs, isLocked, isCheckingAuth]);

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
  const isOrchestratorEnabled = Boolean(config.resolved?.orchestratorEnabled);
  const remainingCredits =
    quota.find((q) => typeof q.remainingCredits === 'number')?.remainingCredits ?? null;

  if (isCheckingAuth) {
    return (
      <div class="flex min-h-screen w-full items-center justify-center bg-pine-base text-pine-muted">
        <div class="flex items-center gap-3">
          <div class="size-4 animate-spin rounded-full border-2 border-pine-iris border-t-transparent" />
          <span class="font-mono text-xs">Connecting to Agylity...</span>
        </div>
      </div>
    );
  }

  if (isLocked) {
    return (
      <ControlPlaneGate
        onAuthenticated={() => {
          setIsLocked(false);
          fetchAll();
        }}
      />
    );
  }

  return (
    <div class="min-h-screen bg-pine-base text-sm text-pine-text md:flex md:h-screen md:overflow-hidden">
      <Sidebar
        route={route}
        onNavigate={navigate}
        orchestratorEnabled={isOrchestratorEnabled}
        lastProbeSource={alerts?.lastProbeSource}
        lastProbeAt={alerts?.lastProbeAt}
        minHeadroomPercent={config.resolved?.minDispatchHeadroomPercent ?? 10}
      />

      <div class="min-w-0 flex-1 p-4 sm:p-6 md:h-screen md:overflow-y-auto md:p-6 2xl:p-8">
        <div class="mx-auto max-w-7xl 2xl:max-w-[1920px]">
          <TopBar
            title={title}
            subtitle={subtitle}
            isRefreshing={isRefreshing}
            refreshCooldown={refreshCooldown}
            orchestratorEnabled={isOrchestratorEnabled}
            remainingCredits={remainingCredits}
            theme={theme}
            onThemeChange={setTheme}
            onRefresh={handleManualRefresh}
            onOpenCommandPalette={() => setCommandPaletteOpen(true)}
            onOpenAuthModal={() => setSessionModalOpen(true)}
          />

          {Boolean(
            alerts?.lastProbeSource === 'auth_required' ||
              alerts?.authRequired === true ||
              quotaError?.toLowerCase().includes('authentication required') ||
              quotaError?.toLowerCase().includes('sign in')
          ) && (
            <div class="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-pine-love/40 bg-pine-love/10 px-4 py-3 text-pine-love shadow-xs">
              <div class="flex min-w-0 items-center gap-2.5">
                <span class="rounded bg-pine-love/20 px-2 py-0.5 font-mono text-[11px] font-bold tracking-wider text-pine-love uppercase whitespace-nowrap">
                  [AUTH REQUIRED]
                </span>
                <span class="text-xs font-medium text-pine-text">
                  Antigravity CLI is not authenticated. Launch the CLI in container to sign in:
                </span>
                <code class="hidden rounded border border-pine-highlight bg-pine-base/80 px-2.5 py-1 font-mono text-xs text-pine-text select-all sm:inline">
                  docker exec -it agylity agy
                </code>
              </div>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText('docker exec -it agylity agy');
                    setAuthCopied(true);
                    setTimeout(() => setAuthCopied(false), 2000);
                  } catch {}
                }}
                class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-pine-love/30 bg-pine-love/20 px-3 py-1 text-xs font-semibold text-pine-love transition-colors hover:bg-pine-love/30"
              >
                <Icon icon={authCopied ? faCheck : faCopy} class="size-3" />
                <span>{authCopied ? 'Copied' : 'Copy Command'}</span>
              </button>
            </div>
          )}

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
            {route === 'tasks' && (
              <TasksView onRefresh={fetchAll} onOpenDispatch={() => setDispatchModalOpen(true)} />
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

      <SessionModal
        isOpen={sessionModalOpen}
        onClose={() => setSessionModalOpen(false)}
        onLock={() => {
          setIsLocked(true);
          setSessionModalOpen(false);
        }}
        onTokenUpdated={fetchAll}
      />

      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onNavigate={navigate}
        onRefresh={handleManualRefresh}
        onOpenDispatch={() => setDispatchModalOpen(true)}
        onToggleTheme={handleToggleTheme}
        orchestratorEnabled={isOrchestratorEnabled}
      />
    </div>
  );
};
