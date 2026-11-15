import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { faPlus, faSync } from '@fortawesome/free-solid-svg-icons';
import type {
  BacklogTaskRecord,
  ReasoningEffort,
  RepositoryConfig,
  RoutineTaskRecord,
  SwarmRunnerRecord,
  SwarmTask,
} from '../types';
import {
  cancelTask,
  deleteBacklogTask,
  deleteRoutine,
  dispatchBacklogTask,
  getBacklogTasks,
  getRoutines,
  getRunners,
  getTasks,
  retryTask,
  syncGithubBacklog,
  triggerRoutine,
  updateRoutine,
} from '../api';
import { Icon } from './Icon';
import { configStore, useStore } from '../state';
import { ACTIVE_TASK_STATUSES, type NotifyTone } from './tasks/badges';
import { ActiveRunCard } from './tasks/ActiveRunsBanner';
import { BacklogCard } from './tasks/BacklogCard';
import { BacklogFormModal } from './tasks/BacklogFormModal';
import { ExecutionInspectorModal } from './tasks/ExecutionInspectorModal';
import { ExecutionTable } from './tasks/ExecutionTable';
import { RoutineCard } from './tasks/RoutineCard';
import { RoutineFormModal } from './tasks/RoutineFormModal';
import { runnerCoversRepo } from './tasks/runners';
import { TaskOriginLabel, type TaskOriginLists } from './tasks/TaskOrigin';

interface TasksViewProps {
  onRefresh?: () => void;
  onOpenDispatch?: () => void;
}

type TaskTab = 'schedules' | 'executions';

const TAB_LABELS: Record<TaskTab, string> = {
  schedules: 'Schedules & Queue',
  executions: 'Execution History',
};

// Execution history is opt-in: only an explicit tab, or an id that addresses one run, opens it.
const normalizeTab = (raw: string | null, focusedId: string | null): TaskTab =>
  raw === 'executions' || (!raw && focusedId) ? 'executions' : 'schedules';

const STATUS_FILTERS = [
  'all',
  'queued',
  'claimed',
  'running',
  'executing',
  'completed',
  'no_changes',
  'failed',
  'aborted',
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number];

const CARD_GRID = 'grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3';

/** Section heading + its actions; the two schedule sections differ only in those. */
const SectionHeader = ({
  id,
  title,
  count,
  children,
}: {
  id: string;
  title: string;
  count: number;
  children?: ComponentChildren;
}) => (
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h2 id={id} class="font-mono text-xs font-bold tracking-wider text-pine-subtle uppercase">
      {title}
      <span class="ml-1 text-pine-muted">({count})</span>
    </h2>
    <div class="flex flex-wrap items-center gap-2">{children}</div>
  </div>
);

const EmptyCard = ({ children }: { children: ComponentChildren }) => (
  <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 text-center text-sm text-pine-subtle">
    {children}
  </div>
);

export const TasksView = ({ onRefresh, onOpenDispatch }: TasksViewProps = {}) => {
  const [activeTab, setActiveTab] = useState<TaskTab>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return normalizeTab(params.get('tab'), params.get('id'));
    } catch {
      return 'schedules';
    }
  });

  const setTab = (tab: TaskTab, id?: string) => {
    setActiveTab(tab);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', tab);
      if (id) {
        url.searchParams.set('id', id);
        handledSearchId.current = null;
      } else {
        url.searchParams.delete('id');
      }
      window.history.replaceState({}, '', url.toString());
    } catch {}
  };

  // --- Execution history state ---
  const [tasks, setTasks] = useState<SwarmTask[]>([]);
  const [executionsInitialLoaded, setExecutionsInitialLoaded] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [selectedTask, setSelectedTask] = useState<SwarmTask | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // --- Schedules & queue state ---
  const [routines, setRoutines] = useState<RoutineTaskRecord[]>([]);
  const [routinesLoading, setRoutinesLoading] = useState(false);
  const [routinesInitialLoaded, setRoutinesInitialLoaded] = useState(false);
  const [routineActionId, setRoutineActionId] = useState<string | null>(null);
  const [routineForm, setRoutineForm] = useState<{ routine: RoutineTaskRecord | null } | null>(
    null
  );

  const [backlogTasks, setBacklogTasks] = useState<BacklogTaskRecord[]>([]);
  const [backlogLoading, setBacklogLoading] = useState(false);
  const [backlogInitialLoaded, setBacklogInitialLoaded] = useState(false);
  const [backlogActionId, setBacklogActionId] = useState<string | null>(null);
  const [backlogForm, setBacklogForm] = useState<{ item: BacklogTaskRecord | null } | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [runners, setRunners] = useState<SwarmRunnerRecord[]>([]);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // Deleting a work item loses a hand-written prompt, so the bin needs a second press.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [syncingGithub, setSyncingGithub] = useState(false);

  const [notification, setNotification] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const notificationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const config = useStore(configStore).config;
  const repos: RepositoryConfig[] = config.resolved?.repositories || [];
  // No invented fallback: with no repository configured the forms stay unsubmittable.
  const defaultRepoId = repos[0]?.id || '';
  const defaultModel = config.resolved?.defaultDispatchModel || 'gemini-3.8-flash';
  const defaultEffort = (config.resolved?.defaultDispatchEffort as ReasoningEffort) || 'high';
  const defaultMinHeadroom = Number(config.resolved?.minDispatchHeadroomPercent ?? 10);
  const routinesEnabled = config.resolved?.routinesEnabled !== false;

  const showNotification = useCallback((type: NotifyTone, message: string) => {
    setNotification({ type, message });
    if (notificationTimer.current) clearTimeout(notificationTimer.current);
    notificationTimer.current = setTimeout(() => setNotification(null), 4000);
  }, []);

  useEffect(
    () => () => {
      if (notificationTimer.current) clearTimeout(notificationTimer.current);
    },
    []
  );

  // --- Data loaders ---
  const loadExecutions = useCallback(() => {
    getTasks(100)
      .then((res) => {
        setTasks(res);
        setLoadError(null);
        setExecutionsInitialLoaded(true);
      })
      .catch((err) => {
        setLoadError(err?.message || String(err));
        setExecutionsInitialLoaded(true);
      });
  }, []);

  const loadBacklog = useCallback(async () => {
    setBacklogLoading(true);
    try {
      setBacklogTasks(await getBacklogTasks());
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err?.message || String(err));
    } finally {
      setBacklogLoading(false);
      setBacklogInitialLoaded(true);
    }
  }, []);

  const loadRoutines = useCallback(async () => {
    setRoutinesLoading(true);
    try {
      setRoutines(await getRoutines());
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err?.message || String(err));
    } finally {
      setRoutinesLoading(false);
      setRoutinesInitialLoaded(true);
    }
  }, []);

  const loadRunners = useCallback(async () => {
    setRunners(await getRunners());
  }, []);

  // The tab lives in a ref so switching tabs does not tear down the poll and refetch everything.
  const activeTabRef = useRef<TaskTab>(activeTab);
  activeTabRef.current = activeTab;

  useEffect(() => {
    loadExecutions();
    // Loaded once for the tab counters; the badge must not claim 0 while items exist.
    void loadBacklog();
    void loadRoutines();
    void loadRunners();
    const timer = setInterval(() => {
      loadExecutions();
      if (activeTabRef.current === 'schedules') {
        void loadBacklog();
        void loadRoutines();
      }
      // Runner liveness decides the queued-run notices, so it polls on both tabs.
      void loadRunners();
    }, 4000);

    return () => clearInterval(timer);
  }, [loadExecutions, loadBacklog, loadRoutines, loadRunners]);

  // Each list loads on first paint of its tab, and on every switch back to it.
  useEffect(() => {
    if (activeTab === 'schedules') {
      void loadBacklog();
      void loadRoutines();
    }
  }, [activeTab, loadBacklog, loadRoutines]);

  // ?id= is applied once per targeted id. Left in the URL it is re-matched on every poll,
  // which re-opens the inspector or re-scrolls cards the user moved away from.
  const handledSearchId = useRef<string | null>(null);
  useEffect(() => {
    let searchId: string | null = null;
    try {
      searchId = new URLSearchParams(window.location.search).get('id');
    } catch {
      searchId = null;
    }
    if (!searchId) {
      handledSearchId.current = null;
      return;
    }
    if (handledSearchId.current === searchId) return;

    const clearUrlId = () => {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('id');
        window.history.replaceState({}, '', url.toString());
      } catch {}
    };

    // A task id opens the inspector; a routine or backlog id scrolls its card into view.
    const task = executionsInitialLoaded
      ? tasks.find((t) => t.id === searchId || t.originId === searchId)
      : undefined;
    if (task) {
      handledSearchId.current = searchId;
      setSelectedTask(task);
      return;
    }

    if (!routinesInitialLoaded || !backlogInitialLoaded) return;
    handledSearchId.current = searchId;
    const card = document.getElementById(`task-row-${searchId}`);
    if (!card) {
      clearUrlId();
      showNotification('error', 'The requested task or schedule was deleted or not found.');
      return;
    }
    setActiveTab('schedules');
    card.scrollIntoView({ block: 'center' });
    setHighlightedId(searchId);
    const timer = setTimeout(() => setHighlightedId(null), 2500);
    return () => clearTimeout(timer);
  }, [
    tasks,
    backlogTasks,
    routines,
    executionsInitialLoaded,
    routinesInitialLoaded,
    backlogInitialLoaded,
    showNotification,
  ]);

  const closeInspector = () => {
    setSelectedTask(null);
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('id')) {
        url.searchParams.delete('id');
        window.history.replaceState({}, '', url.toString());
      }
    } catch {}
  };

  // The poll replaces every task object; without re-pinning, an open inspector freezes at open.
  useEffect(() => {
    if (!selectedTask) return;
    const fresh = tasks.find((t) => t.id === selectedTask.id);
    if (fresh && fresh.updatedAt !== selectedTask.updatedAt) setSelectedTask(fresh);
  }, [tasks, selectedTask]);

  // --- Handlers: executions ---
  const handleCancelTask = async (taskId: string) => {
    setActionLoading(true);
    try {
      await cancelTask(taskId);
      loadExecutions();
      onRefresh?.();
      closeInspector();
      const number = tasks.find((t) => t.id === taskId)?.taskNumber;
      showNotification('success', number ? `Task #${number} cancelled` : 'Task cancelled');
    } catch (err: any) {
      showNotification('error', `Cancel failed: ${err?.message || String(err)}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRetryTask = async (taskId: string) => {
    setActionLoading(true);
    try {
      await retryTask(taskId);
      loadExecutions();
      onRefresh?.();
      setSelectedTask(null);
      showNotification('success', `Task re-queued`);
    } catch (err: any) {
      showNotification('error', `Retry failed: ${err?.message || String(err)}`);
    } finally {
      setActionLoading(false);
    }
  };

  // --- Handlers: backlog ---
  const handleSyncGithub = async () => {
    setSyncingGithub(true);
    try {
      const res = await syncGithubBacklog();
      await loadBacklog();
      const canceled = res.canceledCount ? `, ${res.canceledCount} closed upstream` : '';
      const failed = res.failedRepos?.length ? ` — failed: ${res.failedRepos.join(', ')}` : '';
      showNotification(
        res.success ? 'success' : 'error',
        `GitHub sync: imported ${res.importedCount} new issue(s) matching label '${res.label}'${canceled}${failed}`
      );
    } catch (err: any) {
      showNotification('error', `GitHub sync failed: ${err?.message || String(err)}`);
    } finally {
      setSyncingGithub(false);
    }
  };

  const handleDispatchBacklog = async (item: BacklogTaskRecord) => {
    setBacklogActionId(item.id);
    try {
      const res = await dispatchBacklogTask(item.id);
      await loadBacklog();
      loadExecutions();
      if (!res.success || !res.taskId) {
        showNotification(
          'error',
          res.error || `Dispatch refused for backlog task #${item.taskNumber}`
        );
        return;
      }
      showNotification('success', `Dispatched backlog task #${item.taskNumber} to queue`);
    } catch (err: any) {
      showNotification('error', `Failed to dispatch backlog task: ${err?.message || String(err)}`);
    } finally {
      setBacklogActionId(null);
    }
  };

  const handleDeleteBacklog = async (id: string) => {
    setBacklogActionId(id);
    try {
      await deleteBacklogTask(id);
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.get('id') === id) {
          url.searchParams.delete('id');
          window.history.replaceState({}, '', url.toString());
        }
      } catch {}
      await loadBacklog();
      showNotification('success', `Deleted backlog task`);
    } catch (err: any) {
      showNotification('error', `Delete failed: ${err?.message || String(err)}`);
    } finally {
      setBacklogActionId(null);
    }
  };

  const handleBacklogSaved = async (message: string) => {
    await loadBacklog();
    showNotification('success', message);
  };

  // --- Handlers: routines ---
  const handleToggleRoutineItem = async (routine: RoutineTaskRecord) => {
    setRoutineActionId(routine.id);
    try {
      await updateRoutine(routine.id, { enabled: !routine.enabled });
      await loadRoutines();
    } catch (err: any) {
      showNotification('error', `Failed to toggle routine: ${err?.message || String(err)}`);
    } finally {
      setRoutineActionId(null);
    }
  };

  const handleTriggerRoutineNow = async (routine: RoutineTaskRecord) => {
    setRoutineActionId(routine.id);
    try {
      const res = await triggerRoutine(routine.id);
      await loadRoutines();
      loadExecutions();
      if (!res.success || !res.taskId) {
        showNotification('error', res.error || `Trigger refused for routine "${routine.title}"`);
        return;
      }
      showNotification('success', `Triggered routine "${routine.title}"`);
    } catch (err: any) {
      showNotification('error', `Failed to trigger routine: ${err?.message || String(err)}`);
    } finally {
      setRoutineActionId(null);
    }
  };

  const handleDeleteRoutine = async (id: string) => {
    setRoutineActionId(id);
    try {
      await deleteRoutine(id);
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.get('id') === id) {
          url.searchParams.delete('id');
          window.history.replaceState({}, '', url.toString());
        }
      } catch {}
      await loadRoutines();
      showNotification('success', `Deleted routine`);
    } catch (err: any) {
      showNotification('error', `Delete failed: ${err?.message || String(err)}`);
    } finally {
      setRoutineActionId(null);
    }
  };

  const handleRoutineSaved = async (message: string) => {
    await loadRoutines();
    showNotification('success', message);
  };

  const originLists: TaskOriginLists = {
    backlog: backlogInitialLoaded ? backlogTasks : null,
    routines: routinesInitialLoaded ? routines : null,
  };

  const renderOriginLink = (t: SwarmTask) => (
    <TaskOriginLabel
      task={t}
      lists={originLists}
      onOpen={(originId) => setTab('schedules', originId)}
    />
  );

  const repoLabel = (repositoryId: string): string =>
    repos.find((repo) => repo.id === repositoryId)?.name || repositoryId;

  // lastTaskId is the server's pointer; the tier scan covers cards written before it existed.
  const latestRoutineRun = (routine: RoutineTaskRecord): SwarmTask | undefined =>
    (routine.lastTaskId ? tasks.find((t) => t.id === routine.lastTaskId) : undefined) ??
    tasks.find((t) => t.originId === routine.id && t.tier === 'routine');

  const visibleTasks = tasks.filter((t) => filter === 'all' || t.status === filter);
  const activeRuns = tasks.filter((t) => ACTIVE_TASK_STATUSES.has(t.status));
  const scheduleCount = routines.length + backlogTasks.length;
  const tabCount = (tab: TaskTab): number => (tab === 'schedules' ? scheduleCount : tasks.length);

  return (
    <div class="flex flex-col gap-5 2xl:gap-7">
      {/* Toast Notification */}
      {notification && (
        <div
          class={`fixed right-5 bottom-5 z-50 flex items-center gap-2 rounded-lg px-4 py-3 text-xs font-medium shadow-lg backdrop-blur-md sm:text-sm ${
            notification.type === 'success'
              ? 'border border-pine-foam/30 bg-pine-surface/95 text-pine-foam'
              : 'border border-pine-love/30 bg-pine-surface/95 text-pine-love'
          }`}
        >
          <span>{notification.message}</span>
        </div>
      )}

      {/* Tabs row */}
      <div class="flex flex-wrap items-center gap-3 border-b border-pine-highlight pb-4">
        <div
          role="tablist"
          aria-label="Task management tabs"
          class="flex rounded-lg border border-pine-highlight bg-pine-overlay/40 p-1"
        >
          {(Object.keys(TAB_LABELS) as TaskTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => setTab(tab)}
              class={`cursor-pointer rounded-md px-3 py-1.5 text-xs font-bold whitespace-nowrap uppercase transition-all sm:px-4 sm:text-sm ${
                activeTab === tab
                  ? 'bg-pine-iris text-pine-base shadow-xs'
                  : 'text-pine-subtle hover:text-pine-text'
              }`}
            >
              {TAB_LABELS[tab]} ({tabCount(tab)})
            </button>
          ))}
        </div>

        {onOpenDispatch && (
          <button
            type="button"
            onClick={onOpenDispatch}
            class="ml-auto flex cursor-pointer items-center gap-1.5 rounded-lg bg-pine-iris px-3.5 py-1.5 text-xs font-semibold text-pine-base shadow-xs transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden sm:text-sm"
            title="Create a run, backlog item or routine"
          >
            <Icon icon={faPlus} class="size-3.5" />
            <span>New Task</span>
          </button>
        )}
      </div>

      {/* --- TAB 1: SCHEDULES & QUEUE --- */}
      {activeTab === 'schedules' && (
        <div class="flex flex-col gap-6">
          <section aria-labelledby="active-runs-heading" class="flex flex-col gap-3">
            <SectionHeader id="active-runs-heading" title="Active Runs" count={activeRuns.length} />

            {activeRuns.length === 0 ? (
              <EmptyCard>
                No tasks queued or executing. Use the &apos;New Task&apos; button above to start a
                run.
              </EmptyCard>
            ) : (
              <div class={CARD_GRID}>
                {activeRuns.map((run) => (
                  <ActiveRunCard
                    key={run.id}
                    run={run}
                    busy={actionLoading}
                    noRunnerOnline={!runnerCoversRepo(runners, run.repositoryId)}
                    onOpen={setSelectedTask}
                    onAbort={handleCancelTask}
                  />
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="backlog-heading" class="flex flex-col gap-3">
            <SectionHeader id="backlog-heading" title="Backlog Queue" count={backlogTasks.length}>
              <button
                type="button"
                onClick={handleSyncGithub}
                disabled={syncingGithub}
                class="flex cursor-pointer items-center gap-1.5 rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-semibold text-pine-text transition-colors hover:bg-pine-highlight disabled:opacity-50 sm:text-sm"
                title="Sync open GitHub issues tagged with backlog label"
              >
                <Icon icon={faSync} class={`size-3.5 ${syncingGithub ? 'animate-spin' : ''}`} />
                <span>{syncingGithub ? 'Syncing...' : 'Sync GitHub'}</span>
              </button>
            </SectionHeader>

            {backlogLoading && backlogTasks.length === 0 ? (
              <EmptyCard>Loading backlog tasks...</EmptyCard>
            ) : backlogTasks.length === 0 ? (
              <EmptyCard>
                {loadError
                  ? `Could not load backlog: ${loadError}`
                  : "No backlog work items queued. Create one with 'New Task' or click 'Sync GitHub'."}
              </EmptyCard>
            ) : (
              <div class={CARD_GRID}>
                {backlogTasks.map((item) => (
                  <BacklogCard
                    key={item.id}
                    item={item}
                    repositoryLabel={repoLabel(item.repositoryId)}
                    highlighted={highlightedId === item.id}
                    busy={backlogActionId === item.id}
                    confirmingDelete={pendingDelete === item.id}
                    onDispatch={() => handleDispatchBacklog(item)}
                    onEdit={() => setBacklogForm({ item })}
                    onAskDelete={() => setPendingDelete(item.id)}
                    onConfirmDelete={() => {
                      setPendingDelete(null);
                      void handleDeleteBacklog(item.id);
                    }}
                    onCancelDelete={() => setPendingDelete(null)}
                  />
                ))}
              </div>
            )}
          </section>

          {routinesEnabled && (
            <section aria-labelledby="routines-heading" class="flex flex-col gap-3">
              <SectionHeader
                id="routines-heading"
                title="Maintenance Routines"
                count={routines.length}
              />

              {routinesLoading && routines.length === 0 ? (
                <EmptyCard>Loading routine templates...</EmptyCard>
              ) : routines.length === 0 ? (
                <EmptyCard>
                  {loadError
                    ? `Could not load routines: ${loadError}`
                    : "No routines configured. Create one with 'New Task' to burn quota before weekly resets."}
                </EmptyCard>
              ) : (
                <div class={CARD_GRID}>
                  {routines.map((routine) => (
                    <RoutineCard
                      key={routine.id}
                      routine={routine}
                      repositoryLabel={repoLabel(routine.repositoryId)}
                      lastTask={latestRoutineRun(routine)}
                      highlighted={highlightedId === routine.id}
                      busy={routineActionId === routine.id}
                      confirmingDelete={pendingDelete === routine.id}
                      onOpenTask={setSelectedTask}
                      onToggle={() => handleToggleRoutineItem(routine)}
                      onTrigger={() => handleTriggerRoutineNow(routine)}
                      onEdit={() => setRoutineForm({ routine })}
                      onAskDelete={() => setPendingDelete(routine.id)}
                      onConfirmDelete={() => {
                        setPendingDelete(null);
                        void handleDeleteRoutine(routine.id);
                      }}
                      onCancelDelete={() => setPendingDelete(null)}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {/* --- TAB 2: EXECUTION HISTORY --- */}
      {activeTab === 'executions' && (
        <div class="flex flex-col gap-4">
          <div
            role="group"
            aria-label="Filter executions by status"
            class="flex max-w-full flex-wrap gap-1.5 rounded-lg border border-pine-highlight bg-pine-surface p-1"
          >
            {STATUS_FILTERS.map((statusFilter) => (
              <button
                key={statusFilter}
                type="button"
                aria-pressed={filter === statusFilter}
                onClick={() => setFilter(statusFilter)}
                class={`cursor-pointer rounded-md px-3 py-1 text-xs font-semibold whitespace-nowrap uppercase transition-colors ${
                  filter === statusFilter
                    ? 'bg-pine-iris text-pine-base shadow-xs'
                    : 'text-pine-subtle hover:bg-pine-overlay/60 hover:text-pine-text'
                }`}
              >
                {statusFilter}
              </button>
            ))}
          </div>

          <ExecutionTable
            tasks={visibleTasks}
            loadError={loadError}
            actionLoading={actionLoading}
            onOpen={setSelectedTask}
            onAbort={handleCancelTask}
            onRetry={handleRetryTask}
            renderOrigin={renderOriginLink}
          />
        </div>
      )}

      {/* --- MODAL: EXECUTION DETAIL INSPECTOR (mounted only while a task is selected) --- */}
      {selectedTask && (
        <ExecutionInspectorModal
          task={selectedTask}
          onClose={closeInspector}
          onAbort={handleCancelTask}
          onRetry={handleRetryTask}
          actionLoading={actionLoading}
          noRunnerOnline={!runnerCoversRepo(runners, selectedTask.repositoryId)}
          renderOrigin={renderOriginLink}
        />
      )}

      {/* --- MODAL: CREATE / EDIT ROUTINE --- */}
      {routineForm && (
        <RoutineFormModal
          routine={routineForm.routine}
          repositories={repos}
          defaultRepoId={defaultRepoId}
          defaultModel={defaultModel}
          defaultEffort={defaultEffort}
          defaultMinHeadroom={defaultMinHeadroom}
          onClose={() => setRoutineForm(null)}
          onSaved={handleRoutineSaved}
          notify={showNotification}
        />
      )}

      {/* --- MODAL: CREATE / EDIT BACKLOG WORK ITEM --- */}
      {backlogForm && (
        <BacklogFormModal
          item={backlogForm.item}
          repositories={repos}
          defaultRepoId={defaultRepoId}
          defaultModel={defaultModel}
          defaultEffort={defaultEffort}
          onClose={() => setBacklogForm(null)}
          onSaved={handleBacklogSaved}
          notify={showNotification}
        />
      )}
    </div>
  );
};
