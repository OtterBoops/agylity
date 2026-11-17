import { useState, useEffect, useRef } from 'preact/hooks';
import Router, { type RouterOnChangeArgs } from 'preact-router';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { ControlPlaneGate } from './components/ControlPlaneGate';
import { SessionModal } from './components/SessionModal';
import { CommandPalette } from './components/CommandPalette';
import { TasksView } from './components/TasksView';
import { AlertsView } from './views/AlertsView';
import { OverviewView } from './views/OverviewView';
import { LogsView } from './views/LogsView';
import { UnifiedSettingsView } from './views/settings/UnifiedSettingsView';
import { SlideOverDrawer } from './components/SlideOverDrawer';
import { UnifiedTaskComposer, type ComposerPayload } from './components/tasks/UnifiedTaskComposer';
import {
  createBacklogTask,
  createRoutine,
  updateBacklogTask,
  updateRoutine,
  triggerDispatch,
} from './api';
import {
  loadedSettingsSection,
  readSettingsSection,
  settingsSectionLabel,
  type SettingsSectionId,
} from './utils/settingsHash';
import { NotFoundView } from './views/NotFoundView';
import { checkHealth, getAuthToken } from './api';
import {
  useStore,
  quotaStore,
  configStore,
  refreshQuota,
  refreshAlerts,
  refreshConfig,
  startQuotaPolling,
  loadModelCatalog,
} from './state';

// Every legacy /settings/* path renders the same page; the hash picks the section.
const SETTINGS_PATHS = [
  '/settings',
  '/settings/general',
  '/settings/coordinator',
  '/settings/repositories',
  '/settings/notifications',
  '/settings/advanced',
];

const SECTION_BY_PATH: Record<string, SettingsSectionId> = {
  '/settings': 'general',
  '/settings/general': 'general',
  '/settings/coordinator': 'coordinator',
  '/settings/repositories': 'repositories',
  '/settings/notifications': 'notifications',
  '/settings/advanced': 'advanced',
};

const TITLES: Record<string, string> = {
  '/': 'Overview',
  '/overview': 'Overview',
  '/tasks': 'Tasks',
  '/logs': 'Logs',
  '/alerts': 'Alerts',
  '/settings': 'General',
  '/settings/general': 'General',
  '/settings/coordinator': 'Coordinator',
  '/settings/notifications': 'Notifications',
  '/settings/repositories': 'Repositories',
  '/settings/advanced': 'Advanced',
};

export const App = () => {
  const [section, setSection] = useState<SettingsSectionId | null>(() => {
    if (typeof window === 'undefined') return null;
    return readSettingsSection() ?? SECTION_BY_PATH[window.location.pathname] ?? null;
  });
  const [currentUrl, setCurrentUrl] = useState(() => {
    if (typeof window === 'undefined') return '/';
    if (window.location.pathname === '/settings') {
      window.history.replaceState(null, '', '/settings/general');
      return '/settings/general';
    }
    return window.location.pathname;
  });

  useEffect(() => {
    const sync = () => setSection(readSettingsSection());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  const handleRouteChange = (e: RouterOnChangeArgs) => {
    const path = e.url.split(/[?#]/)[0] || '/';
    setCurrentUrl(path);
    const fromPath = SECTION_BY_PATH[path];
    if (!fromPath) return;
    const hashInUrl = /#([a-z-]+)$/.exec(e.url)?.[1] as SettingsSectionId | undefined;
    const next = hashInUrl ?? readSettingsSection() ?? loadedSettingsSection() ?? fromPath;
    setSection(next);
    window.history.replaceState(null, '', `/settings#${next}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };
  const { quota, alerts, lastUpdated: quotaUpdatedAt, error: quotaError } = useStore(quotaStore);
  const { config } = useStore(configStore);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshCooldown, setRefreshCooldown] = useState(0);
  // One composer for every create/edit entry point: TopBar, Alt+D, the palette and TasksView.
  const [composer, setComposer] = useState<{ backlog?: any; routine?: any } | null>(null);
  const [composerBusy, setComposerBusy] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [sessionModalOpen, setSessionModalOpen] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  // The keymap reads the refresh handler through a ref; depending on cooldown re-bound the listener per refresh.
  const manualRefreshRef = useRef<() => void>(() => {});

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
      const anyDialogOpen = document.querySelector('dialog[open]') !== null;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (commandPaletteOpen || !anyDialogOpen) setCommandPaletteOpen((prev) => !prev);
        return;
      }

      const target = e.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (e.altKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (!anyDialogOpen) setComposer({});
        return;
      }

      if (
        !isInput &&
        !anyDialogOpen &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.key.toLowerCase() === 'r'
      ) {
        e.preventDefault();
        manualRefreshRef.current();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [commandPaletteOpen, sessionModalOpen]);

  const fetchAll = (force = false) =>
    Promise.all([
      refreshQuota({ force }),
      refreshConfig(),
      loadModelCatalog().catch(() => []),
    ]).catch((err) => {
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
    fetchAll(true).finally(() => {
      setIsRefreshing(false);
      setRefreshCooldown(2);
    });
  };
  manualRefreshRef.current = handleManualRefresh;

  useEffect(() => {
    if (refreshCooldown <= 0) return;
    const timer = setInterval(() => setRefreshCooldown((c) => c - 1), 1000);
    return () => clearInterval(timer);
  }, [refreshCooldown]);

  const onSettings = currentUrl.startsWith('/settings');
  const openComposer = (initial: { backlog?: any; routine?: any } = {}) => {
    setComposerError(null);
    setComposer(initial);
  };

  const submitComposer = async (payload: ComposerPayload) => {
    setComposerBusy(true);
    setComposerError(null);
    try {
      if (payload.mode === 'run') {
        const res = await triggerDispatch({
          repositoryId: payload.repositoryId,
          repositoryName: payload.repositoryName,
          title: payload.title,
          prompt: payload.prompt,
          cascade: payload.cascade,
          prPolicy: payload.prPolicy,
          autoCreatePr: payload.autoCreatePr,
          verifyCommand: payload.verifyCommand,
          scheduleMode: payload.scheduleMode,
        });
        if (!res.success) throw new Error(res.error || 'Dispatch refused');
      } else if (payload.mode === 'backlog') {
        const body = {
          title: payload.title,
          prompt: payload.prompt,
          repositoryId: payload.repositoryId,
          cascade: payload.cascade,
          autoCreatePr: payload.autoCreatePr,
          verifyCommand: payload.verifyCommand,
          priorityOrder: payload.priorityOrder,
        };
        if (payload.id) await updateBacklogTask(payload.id, body as any);
        else await createBacklogTask(body as any);
      } else {
        const body = {
          title: payload.title,
          prompt: payload.prompt,
          repositoryId: payload.repositoryId,
          cascade: payload.cascade,
          prPolicy: payload.prPolicy,
          autoCreatePr: payload.autoCreatePr,
          verifyCommand: payload.verifyCommand,
          triggerBeforeResetHours: payload.triggerBeforeResetHours,
          minHeadroomPercent: payload.minHeadroomPercent,
        };
        if (payload.id) await updateRoutine(payload.id, body as any);
        else await createRoutine(body as any);
      }
      setComposer(null);
      await fetchAll(true);
    } catch (err: any) {
      setComposerError(err?.message || 'Could not save');
    } finally {
      setComposerBusy(false);
    }
  };

  const title =
    (onSettings ? settingsSectionLabel(section) : null) ?? (TITLES[currentUrl] || 'Not Found');
  const isCoordinatorEnabled = Boolean(config.resolved?.coordinatorEnabled);
  const remainingCredits =
    quota.find((q) => typeof q.remainingCredits === 'number')?.remainingCredits ?? null;

  if (isCheckingAuth) {
    return (
      <div class="flex size-full min-h-full items-center justify-center bg-pine-base text-pine-muted">
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
    <div class="min-h-full bg-pine-base text-sm text-pine-text md:flex md:h-full md:overflow-hidden">
      <Sidebar
        coordinatorEnabled={isCoordinatorEnabled}
        lastProbeSource={alerts?.lastProbeSource}
        lastProbeAt={alerts?.lastProbeAt}
        minHeadroomPercent={config.resolved?.minDispatchHeadroomPercent ?? 10}
      />

      <div class="min-w-0 flex-1 md:flex md:h-full md:flex-col md:overflow-hidden">
        <header class="shrink-0 border-b border-pine-highlight bg-pine-base/95 px-4 py-2.5 sm:px-6 md:px-6 2xl:px-8">
          <div class="mx-auto max-w-7xl 2xl:max-w-none">
            <TopBar
              title={title}
              isRefreshing={isRefreshing}
              refreshCooldown={refreshCooldown}
              remainingCredits={remainingCredits}
              onRefresh={handleManualRefresh}
              onOpenCommandPalette={() => setCommandPaletteOpen(true)}
              onOpenAuthModal={() => setSessionModalOpen(true)}
            />
          </div>
        </header>

        <div class="flex min-h-0 min-w-0 flex-1 scrollbar-gutter-stable flex-col p-4 sm:p-6 md:overflow-y-auto md:p-6 2xl:p-8">
          <div class="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col 2xl:max-w-none">
            <main class="flex min-h-0 flex-1 flex-col">
              <Router onChange={handleRouteChange}>
                <OverviewView
                  path="/"
                  quota={quota}
                  quotaUpdatedAt={quotaUpdatedAt}
                  alerts={alerts}
                  minHeadroomPercent={config.resolved?.minDispatchHeadroomPercent ?? 10}
                  error={quotaError}
                  onRetry={() => fetchAll(true)}
                  onAlertsChanged={refreshAlerts}
                  coordinatorEnabled={Boolean(config.resolved?.coordinatorEnabled)}
                />
                <OverviewView
                  path="/overview"
                  quota={quota}
                  quotaUpdatedAt={quotaUpdatedAt}
                  alerts={alerts}
                  minHeadroomPercent={config.resolved?.minDispatchHeadroomPercent ?? 10}
                  error={quotaError}
                  onRetry={() => fetchAll(true)}
                  onAlertsChanged={refreshAlerts}
                  coordinatorEnabled={Boolean(config.resolved?.coordinatorEnabled)}
                />
                <TasksView path="/tasks" onRefresh={fetchAll} onOpenComposer={openComposer} />
                <LogsView path="/logs" />
                <AlertsView path="/alerts" alerts={alerts} />
                {SETTINGS_PATHS.map((path) => (
                  <UnifiedSettingsView
                    key={path}
                    path={path}
                    config={config}
                    onChanged={fetchAll}
                  />
                ))}
                <NotFoundView default />
              </Router>
            </main>
          </div>
        </div>
      </div>

      {composer && (
        <SlideOverDrawer
          token={`composer-${composer.backlog?.id ?? composer.routine?.id ?? 'new'}`}
          label="Task"
          ariaLabel="Task composer"
          width="composer"
          onClosed={() => {
            setComposer(null);
            setComposerError(null);
          }}
        >
          <UnifiedTaskComposer
            initial={
              composer.backlog
                ? { mode: 'backlog', backlog: composer.backlog }
                : composer.routine
                  ? { mode: 'routine', routine: composer.routine }
                  : { mode: 'run' }
            }
            repositories={(config.resolved?.repositories ?? []).map((repo: any) => ({
              id: repo.id,
              name: repo.name,
            }))}
            defaultModel={config.resolved?.defaultDispatchModel || 'gemini-4-hydrogen'}
            headroomPercent={null}
            submitting={composerBusy}
            error={composerError}
            onSubmit={submitComposer}
            onCancel={() => setComposer(null)}
          />
        </SlideOverDrawer>
      )}

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
        onRefresh={handleManualRefresh}
        onOpenDispatch={() => setComposer({})}
        coordinatorEnabled={isCoordinatorEnabled}
      />
    </div>
  );
};
