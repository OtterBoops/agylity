import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { faCloudArrowDown, faPlus } from '@fortawesome/free-solid-svg-icons';
import type {
  BacklogTaskRecord,
  RepositoryConfig,
  RoutineTaskRecord,
  SwarmRunnerRecord,
  SwarmTask,
} from '../types';
import { FINISHED_BACKLOG_STATUS_VALUES } from '../../../src/shared/contracts.ts';
import {
  bulkUpdateBacklog,
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
import { BulkActionBar } from './BulkActionBar';
import { Icon } from './Icon';
import { configStore, useStore } from '../state';
import { pushErrorToast, pushToast, type ToastTone } from '../state/toastStore';
import { ACTIVE_TASK_STATUSES } from './tasks/badges';
import { ActiveRunCard } from './tasks/ActiveRunsBanner';
import { BacklogCard } from './tasks/BacklogCard';
import { ExecutionInspectorContent } from './tasks/ExecutionInspectorModal';
import { ExecutionTable } from './tasks/ExecutionTable';
import { MobileTaskCard } from './tasks/MobileTaskCard';
import { STATUS_BUCKETS, statusMatchesBucket, type StatusBucketId } from './tasks/statusLabels';
import { SlideOverDrawer } from './SlideOverDrawer';
import { RoutineCard } from './tasks/RoutineCard';
import { runnerCoversRepo } from './tasks/runners';
import { TaskOriginLabel, type TaskOriginLists } from './tasks/TaskOrigin';

interface TasksViewProps {
  onRefresh?: () => void;
  onOpenComposer?: (initial?: { backlog?: any; routine?: any }) => void;
}

/** Abort is destructive and one keypress away from the arrow keys, so it needs a second press. */
const ABORT_CONFIRM_WINDOW_MS = 3000;

const CARD_GRID = 'grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3';

const TASK_PAGE_SIZE = 100;

const taskFilterParams = (raw: string): { q?: string; taskNumber?: number } => {
  const term = raw.trim().replace(/^#/, '');
  if (!term) return {};
  const taskNumber = /^\d+$/.test(term) ? Number(term) : 0;
  return taskNumber > 0 ? { taskNumber } : { q: term };
};

const SECTION = 'mt-6 flex flex-col first:mt-0';

const FINISHED_BACKLOG_STATUSES: ReadonlySet<string> = new Set(FINISHED_BACKLOG_STATUS_VALUES);

const GITHUB_SYNC_UNCONFIGURED_HINT = 'No repository has GitHub issue sync configured.';

/** Drops `?id=` once its target is gone, so the next poll does not re-open or re-scroll it. */
const clearSearchId = (expectedId?: string): void => {
  try {
    const url = new URL(window.location.href);
    const current = url.searchParams.get('id');
    if (current === null || (expectedId !== undefined && current !== expectedId)) return;
    url.searchParams.delete('id');
    window.history.replaceState({}, '', url.toString());
  } catch {}
};

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
  <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
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

export const TasksView = ({ onRefresh, onOpenComposer }: TasksViewProps = {}) => {
  const [tasks, setTasks] = useState<SwarmTask[]>([]);
  const [executionsInitialLoaded, setExecutionsInitialLoaded] = useState(false);
  const [bucket, setBucket] = useState<StatusBucketId>('all');
  const [query, setQuery] = useState('');
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [pendingAbortId, setPendingAbortId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<SwarmTask | null>(null);
  const [actionLoading, setActionLoading] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [totalTasks, setTotalTasks] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const [routines, setRoutines] = useState<RoutineTaskRecord[]>([]);
  const [routinesInitialLoaded, setRoutinesInitialLoaded] = useState(false);
  const [routineActionId, setRoutineActionId] = useState<string | null>(null);

  const [backlogTasks, setBacklogTasks] = useState<BacklogTaskRecord[]>([]);
  const [backlogInitialLoaded, setBacklogInitialLoaded] = useState(false);
  const [backlogActionId, setBacklogActionId] = useState<string | null>(null);
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [showFinishedBacklog, setShowFinishedBacklog] = useState(false);

  // One slot per fetch: a success must only ever clear its own failure.
  const [executionsError, setExecutionsError] = useState<string | null>(null);
  const [backlogError, setBacklogError] = useState<string | null>(null);
  const [routinesError, setRoutinesError] = useState<string | null>(null);
  const [runners, setRunners] = useState<SwarmRunnerRecord[]>([]);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [syncingGithub, setSyncingGithub] = useState(false);

  const abortConfirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedTasksLimit = useRef(TASK_PAGE_SIZE);
  const executionsRequest = useRef(0);
  const searchTermRef = useRef('');
  // Tracks in-flight routine toggle requests so 4s polls never flicker the switch back.
  const pendingRoutineToggles = useRef<Map<string, boolean>>(new Map());

  const searchTerm = query.trim();
  searchTermRef.current = searchTerm;

  const config = useStore(configStore).config;
  const repos: RepositoryConfig[] = config.resolved?.repositories || [];
  const githubSyncConfigured = repos.length > 0;
  const routinesEnabled = config.resolved?.routinesEnabled !== false;

  const showNotification = useCallback((tone: ToastTone, title: string, message?: string) => {
    pushToast({ tone, title, message });
  }, []);

  const markLoading = useCallback((taskId: string) => {
    setActionLoading((prev) => new Set(prev).add(taskId));
  }, []);

  const clearLoading = useCallback((taskId: string) => {
    setActionLoading((prev) => {
      const next = new Set(prev);
      next.delete(taskId);
      return next;
    });
  }, []);

  useEffect(
    () => () => {
      if (abortConfirmTimer.current) clearTimeout(abortConfirmTimer.current);
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    },
    []
  );

  const loadExecutions = useCallback(() => {
    const request = ++executionsRequest.current;
    const limit = Math.max(TASK_PAGE_SIZE, loadedTasksLimit.current);
    getTasks({ ...taskFilterParams(searchTermRef.current), limit, offset: 0 })
      .then((res) => {
        if (request !== executionsRequest.current) return;
        loadedTasksLimit.current = Math.max(TASK_PAGE_SIZE, res.tasks.length);
        setTasks(res.tasks);
        setTotalTasks(res.total);
        setExecutionsError(null);
        setExecutionsInitialLoaded(true);
      })
      .catch((err) => {
        if (request !== executionsRequest.current) return;
        console.error('[agylity] could not load executions', err);
        setExecutionsError(err?.message || String(err));
        setExecutionsInitialLoaded(true);
      });
  }, []);

  const handleLoadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    const request = executionsRequest.current;
    const offset = tasks.length;
    try {
      const res = await getTasks({
        ...taskFilterParams(searchTermRef.current),
        limit: TASK_PAGE_SIZE,
        offset,
      });
      if (request !== executionsRequest.current) return;
      loadedTasksLimit.current = offset + res.tasks.length;
      setTasks((prev) => {
        const seen = new Set(prev.map((task) => task.id));
        return [...prev, ...res.tasks.filter((task) => !seen.has(task.id))];
      });
      setTotalTasks(res.total);
    } catch (err: any) {
      showNotification('error', `Could not load more executions: ${err?.message || String(err)}`);
    } finally {
      setLoadingMore(false);
    }
  };

  const loadBacklog = useCallback(async () => {
    try {
      setBacklogTasks(await getBacklogTasks());
      setBacklogError(null);
    } catch (err: any) {
      console.error('[agylity] could not load backlog', err);
      setBacklogError(err?.message || String(err));
    } finally {
      setBacklogInitialLoaded(true);
    }
  }, []);

  const loadRoutines = useCallback(async () => {
    try {
      const next = await getRoutines();
      const pending = pendingRoutineToggles.current;
      setRoutines(
        pending.size === 0
          ? next
          : next.map((r) => (pending.has(r.id) ? { ...r, enabled: pending.get(r.id)! } : r))
      );
      setRoutinesError(null);
    } catch (err: any) {
      console.error('[agylity] could not load routines', err);
      setRoutinesError(err?.message || String(err));
    } finally {
      setRoutinesInitialLoaded(true);
    }
  }, []);

  const loadRunners = useCallback(async () => {
    try {
      const response = await getRunners();
      setRunners(response.runners);
    } catch {
      // Keep the last known fleet: a failed poll is not an empty one.
    }
  }, []);

  useEffect(() => {
    const refreshAll = () => {
      // A background tab has nobody reading it: skip the tick rather than refetch four endpoints.
      if (document.hidden) return;
      loadExecutions();
      void loadBacklog();
      void loadRoutines();
      void loadRunners();
    };
    refreshAll();
    const timer = setInterval(refreshAll, 4000);
    document.addEventListener('visibilitychange', refreshAll);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshAll);
    };
  }, [loadExecutions, loadBacklog, loadRoutines, loadRunners]);

  const appliedSearchTerm = useRef(searchTerm);
  useEffect(() => {
    if (appliedSearchTerm.current === searchTerm) return;
    appliedSearchTerm.current = searchTerm;
    loadedTasksLimit.current = TASK_PAGE_SIZE;
    loadExecutions();
  }, [searchTerm, loadExecutions]);

  const handledTabScroll = useRef(false);
  useEffect(() => {
    if (handledTabScroll.current) return;
    handledTabScroll.current = true;
    let tab: string | null = null;
    try {
      tab = new URLSearchParams(window.location.search).get('tab');
    } catch {
      tab = null;
    }
    if (!tab) return;
    document.getElementById('executions-heading')?.scrollIntoView({ block: 'start' });
  }, []);

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

    const task = executionsInitialLoaded
      ? tasks.find((t) => t.id === searchId || t.originId === searchId)
      : undefined;
    if (task) {
      handledSearchId.current = searchId;
      setSelectedTask(task);
      return;
    }

    // Executions are the authority for a task id; a card lookup before they land would strip the
    // id and report a live run as deleted.
    if (!executionsInitialLoaded) return;
    if (!routinesInitialLoaded || !backlogInitialLoaded) return;
    // A finished backlog row is hidden by default; revealing it beats reporting it deleted. The
    // flag guard is what lets the re-run scroll the card it just revealed.
    if (!showFinishedBacklog && finishedBacklog.some((item) => item.id === searchId)) {
      setShowFinishedBacklog(true);
      return;
    }

    // A dispatched row hands its card to ACTIVE RUNS, so that run card is what the link names.
    const linkedRun = backlogTasks.find((item) => item.id === searchId);
    const run = linkedRun ? linkedRunFor(linkedRun) : undefined;
    if (run) {
      handledSearchId.current = searchId;
      document.getElementById(`task-row-${run.id}`)?.scrollIntoView({ block: 'center' });
      setHighlightedId(run.id);
      const timer = setTimeout(() => setHighlightedId(null), 2500);
      return () => clearTimeout(timer);
    }

    handledSearchId.current = searchId;
    const card = document.getElementById(`task-row-${searchId}`);
    if (!card) {
      clearSearchId();
      showNotification('error', 'The requested task or schedule was deleted or not found.');
      return;
    }
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
    showFinishedBacklog,
    showNotification,
  ]);

  const closeInspector = () => {
    setSelectedTask(null);
    clearSearchId();
  };

  const focusCard = (originId: string) => {
    const origin = backlogTasks.find((item) => item.id === originId);
    const run = origin ? linkedRunFor(origin) : undefined;
    const target = run?.id ?? originId;
    const card = document.getElementById(`task-row-${target}`);
    if (!card) return;
    card.scrollIntoView({ block: 'center' });
    setHighlightedId(target);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightedId(null), 2500);
  };

  // The poll replaces every task object; without re-pinning, an open inspector freezes at open.
  useEffect(() => {
    if (!selectedTask) return;
    const fresh = tasks.find((t) => t.id === selectedTask.id);
    if (fresh && fresh.updatedAt !== selectedTask.updatedAt) setSelectedTask(fresh);
  }, [tasks, selectedTask]);

  const handleCancelTask = async (taskId: string) => {
    markLoading(taskId);
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
      clearLoading(taskId);
    }
  };

  const requestAbort = (taskId: string) => {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task || !ACTIVE_TASK_STATUSES.has(task.status)) return;
    if (abortConfirmTimer.current) clearTimeout(abortConfirmTimer.current);
    if (pendingAbortId === taskId) {
      setPendingAbortId(null);
      void handleCancelTask(taskId);
      return;
    }
    setPendingAbortId(taskId);
    abortConfirmTimer.current = setTimeout(() => setPendingAbortId(null), ABORT_CONFIRM_WINDOW_MS);
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    const ids = visibleTasks.map((task) => task.id);
    setSelectedIds((prev) => (ids.every((id) => prev.has(id)) ? new Set() : new Set(ids)));
  };

  const handleRetryFailed = async () => {
    const targets = tasks.filter(
      (task) => selectedIds.has(task.id) && (task.status === 'failed' || task.status === 'aborted')
    );
    if (targets.length === 0) return;
    setBulkBusy(true);
    let ok = 0;
    let refused = 0;
    let gone = 0;
    const queue = [...targets];
    const worker = async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        try {
          await retryTask(next.id);
          ok += 1;
        } catch (err: any) {
          const status = err?.response?.status;
          if (status === 404) gone += 1;
          else refused += 1;
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    setBulkNote(`${ok} retried · ${refused} refused · ${gone} gone`);
    setBulkBusy(false);
    setSelectedIds(new Set());
    await loadExecutions();
    onRefresh?.();
  };

  // Stop must pause the backlog origins before aborting live runs, or the evaluator re-queues
  // every aborted item on its next probe.
  const handleStopAndPause = async () => {
    const live = tasks.filter(
      (task) => selectedIds.has(task.id) && ACTIVE_TASK_STATUSES.has(task.status)
    );
    if (live.length === 0) return;
    setBulkBusy(true);
    const originIds = Array.from(
      new Set(live.map((task) => task.originId).filter((id): id is string => Boolean(id)))
    );
    let paused = 0;
    if (originIds.length > 0) {
      try {
        const res = await bulkUpdateBacklog(originIds, 'pause');
        paused = res.updated;
      } catch {}
    }
    let aborted = 0;
    for (const task of live) {
      try {
        await cancelTask(task.id);
        aborted += 1;
      } catch {}
    }
    setBulkNote(`${aborted} aborted · ${paused} backlog paused`);
    setBulkBusy(false);
    setSelectedIds(new Set());
    await loadExecutions();
    await loadBacklog();
    onRefresh?.();
  };

  const handleRetryTask = async (taskId: string) => {
    markLoading(taskId);
    try {
      await retryTask(taskId);
      loadExecutions();
      onRefresh?.();
      setSelectedTask(null);
      showNotification('success', `Task re-queued`);
    } catch (err: any) {
      showNotification('error', `Retry failed: ${err?.message || String(err)}`);
    } finally {
      clearLoading(taskId);
    }
  };

  const handleSyncGithub = async () => {
    setSyncingGithub(true);
    try {
      const res = await syncGithubBacklog();
      await loadBacklog();
      const canceled = res.canceledCount ? `, ${res.canceledCount} closed upstream` : '';
      if (res.success) {
        pushToast({
          tone: 'success',
          title: `GitHub sync imported ${res.importedCount} issue(s)`,
          message: `Label '${res.label}'${canceled}`,
        });
      } else {
        const failureLines = res.failures?.length
          ? res.failures.map((failure) => `${failure.repositoryId}: ${failure.reason}`)
          : res.failedRepos?.length
            ? [`Failed: ${res.failedRepos.join(', ')}`]
            : [];
        pushErrorToast(
          `GitHub sync failed (${res.importedCount} imported${canceled})`,
          failureLines.join('\n') || `Label '${res.label}'`
        );
      }
    } catch (err: any) {
      pushErrorToast('GitHub sync failed', err?.message || String(err));
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
      clearSearchId(id);
      await loadBacklog();
      showNotification('success', `Deleted backlog task`);
    } catch (err: any) {
      showNotification('error', `Delete failed: ${err?.message || String(err)}`);
    } finally {
      setBacklogActionId(null);
    }
  };

  const handleToggleRoutineItem = async (routine: RoutineTaskRecord) => {
    const nextEnabled = !routine.enabled;
    pendingRoutineToggles.current.set(routine.id, nextEnabled);
    setRoutines((prev) =>
      prev.map((r) => (r.id === routine.id ? { ...r, enabled: nextEnabled } : r))
    );
    try {
      const updated = await updateRoutine(routine.id, { enabled: nextEnabled });
      pendingRoutineToggles.current.delete(routine.id);
      setRoutines((prev) => prev.map((r) => (r.id === routine.id ? updated : r)));
    } catch (err: any) {
      pendingRoutineToggles.current.delete(routine.id);
      setRoutines((prev) =>
        prev.map((r) => (r.id === routine.id ? { ...r, enabled: routine.enabled } : r))
      );
      showNotification('error', `Failed to toggle routine: ${err?.message || String(err)}`);
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
      clearSearchId(id);
      await loadRoutines();
      showNotification('success', `Deleted routine`);
    } catch (err: any) {
      showNotification('error', `Delete failed: ${err?.message || String(err)}`);
    } finally {
      setRoutineActionId(null);
    }
  };

  const originLists: TaskOriginLists = {
    backlog: backlogInitialLoaded ? backlogTasks : null,
    routines: routinesInitialLoaded ? routines : null,
  };

  const renderOriginLink = (t: SwarmTask) => (
    <TaskOriginLabel task={t} lists={originLists} onOpen={focusCard} />
  );

  const repoLabel = (repositoryId: string): string =>
    repos.find((repo) => repo.id === repositoryId)?.name || repositoryId;

  const latestRoutineRun = (routine: RoutineTaskRecord): SwarmTask | undefined =>
    (routine.lastTaskId ? tasks.find((t) => t.id === routine.lastTaskId) : undefined) ??
    tasks.find((t) => t.originId === routine.id && t.tier === 'routine');

  const bucketLabel = STATUS_BUCKETS.find((entry) => entry.id === bucket)?.label ?? 'All';
  const visibleTasks = tasks.filter((task) => statusMatchesBucket(task.status, bucket));
  const activeFilterLabel = searchTerm ? `${bucketLabel} \u00b7 "${searchTerm}"` : bucketLabel;
  const executionRange =
    tasks.length === 0 ? `0 of ${totalTasks}` : `1\u2013${tasks.length} of ${totalTasks}`;
  const hasMoreTasks = tasks.length < totalTasks;
  const clearFilters = () => {
    setBucket('all');
    setQuery('');
  };

  const activeRuns = tasks.filter((t) => ACTIVE_TASK_STATUSES.has(t.status));

  // A dispatched row whose run is already on screen would render twice, so the run card owns it.
  const linkedRunFor = (item: BacklogTaskRecord): SwarmTask | undefined =>
    item.status === 'dispatched'
      ? activeRuns.find((run) => run.originId === item.id || run.id === item.swarmTaskId)
      : undefined;
  const runningBacklog = backlogTasks.filter((item) => linkedRunFor(item) !== undefined);
  // A dispatched row with no run on screen is drifted state, so it stays in the grid.
  const shownBacklog = backlogTasks.filter((item) => linkedRunFor(item) === undefined);
  const finishedBacklog = shownBacklog.filter((item) => FINISHED_BACKLOG_STATUSES.has(item.status));
  const activeBacklog = shownBacklog.filter((item) => !FINISHED_BACKLOG_STATUSES.has(item.status));
  const visibleBacklog = showFinishedBacklog ? shownBacklog : activeBacklog;

  const finishedCountLabel = finishedBacklog.length > 99 ? '99+' : String(finishedBacklog.length);
  const backlogEmptyCopy =
    backlogTasks.length === 0
      ? "No backlog work items queued. Create one with 'New Task' or pull them with 'Pull Issues'."
      : runningBacklog.length > 0
        ? 'No backlog items waiting — active runs are shown above.'
        : 'No active backlog items.';

  return (
    <div class="flex flex-col gap-5 2xl:gap-7">
      <div class="flex flex-wrap items-center gap-2 border-b border-pine-highlight pb-4">
        <button
          type="button"
          onClick={handleSyncGithub}
          disabled={!githubSyncConfigured || syncingGithub}
          class="flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-pine-highlight bg-pine-overlay px-3.5 text-xs font-semibold text-pine-text transition-colors hover:bg-pine-highlight focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9 sm:text-sm"
          title={
            githubSyncConfigured
              ? 'Pull open GitHub issues labelled for the backlog'
              : GITHUB_SYNC_UNCONFIGURED_HINT
          }
        >
          <Icon
            icon={faCloudArrowDown}
            class={`size-3.5 ${syncingGithub ? 'animate-pulse' : ''}`}
          />
          <span>{syncingGithub ? 'Pulling...' : 'Pull Issues'}</span>
        </button>
        <button
          type="button"
          onClick={() => onOpenComposer?.({})}
          class="flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-pine-iris px-3.5 text-xs font-semibold text-pine-base transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden sm:min-h-9 sm:text-sm"
          title="Create a run, backlog item or routine"
        >
          <Icon icon={faPlus} class="size-3.5" />
          <span>New Task</span>
        </button>
        {!githubSyncConfigured && (
          <span class="order-first w-full text-xs text-pine-subtle sm:w-auto">
            {GITHUB_SYNC_UNCONFIGURED_HINT}
          </span>
        )}
      </div>

      <div class="flex flex-col">
        <section aria-labelledby="active-runs-heading" class={SECTION}>
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
                  highlighted={highlightedId === run.id}
                  busy={actionLoading.has(run.id)}
                  noRunnerOnline={!runnerCoversRepo(runners, run.repositoryId)}
                  onOpen={setSelectedTask}
                  onAbort={handleCancelTask}
                />
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="backlog-heading" class={SECTION}>
          <SectionHeader id="backlog-heading" title="Backlog" count={activeBacklog.length}>
            {finishedBacklog.length > 0 && (
              <button
                type="button"
                aria-expanded={showFinishedBacklog}
                aria-controls="backlog-grid"
                onClick={() => setShowFinishedBacklog((prev) => !prev)}
                class="min-h-11 cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-2.5 text-xs font-semibold whitespace-nowrap text-pine-subtle transition-colors hover:bg-pine-highlight hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden sm:min-h-8"
              >
                {showFinishedBacklog
                  ? `Hide finished (${finishedCountLabel})`
                  : `Show finished (${finishedCountLabel})`}
              </button>
            )}
          </SectionHeader>

          {!backlogInitialLoaded ? (
            <EmptyCard>Loading backlog tasks...</EmptyCard>
          ) : visibleBacklog.length === 0 ? (
            <EmptyCard>
              {backlogError ? `Could not load backlog: ${backlogError}` : backlogEmptyCopy}
            </EmptyCard>
          ) : (
            <div id="backlog-grid" class={CARD_GRID}>
              {visibleBacklog.map((item) => (
                <BacklogCard
                  key={item.id}
                  item={item}
                  repositoryLabel={repoLabel(item.repositoryId)}
                  highlighted={highlightedId === item.id}
                  busy={backlogActionId === item.id}
                  confirmingDelete={pendingDelete === item.id}
                  onDispatch={() => handleDispatchBacklog(item)}
                  onEdit={() => onOpenComposer?.({ backlog: item })}
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
          <section aria-labelledby="routines-heading" class={SECTION}>
            <SectionHeader id="routines-heading" title="Routines" count={routines.length} />

            {!routinesInitialLoaded ? (
              <EmptyCard>Loading routine templates...</EmptyCard>
            ) : routines.length === 0 ? (
              <EmptyCard>
                {routinesError
                  ? `Could not load routines: ${routinesError}`
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
                    onEdit={() => onOpenComposer?.({ routine })}
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

        <section aria-labelledby="executions-heading" class={SECTION}>
          <SectionHeader
            id="executions-heading"
            title="Execution History"
            count={totalTasks || tasks.length}
          />

          <div class="flex flex-col gap-4">
            <div class="flex flex-wrap items-center gap-2">
              <div
                role="group"
                aria-label="Filter executions by status"
                class="flex max-w-full flex-wrap gap-1 rounded-lg border border-pine-highlight bg-pine-surface p-1"
              >
                {STATUS_BUCKETS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    aria-pressed={bucket === entry.id}
                    onClick={() => setBucket(entry.id)}
                    class={`cursor-pointer rounded-md px-3 py-1 text-xs font-semibold whitespace-nowrap uppercase transition-colors ${
                      bucket === entry.id
                        ? 'bg-pine-iris text-pine-base'
                        : 'text-pine-subtle hover:bg-pine-overlay/60 hover:text-pine-text'
                    }`}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>

              <input
                id="task-filter-input"
                type="search"
                value={query}
                onInput={(event) => setQuery(event.currentTarget.value)}
                placeholder="Filter by title, repo, model or #"
                aria-label="Filter executions"
                class="h-9 min-w-0 flex-1 rounded-lg border border-pine-highlight bg-pine-surface px-3 text-xs text-pine-text placeholder:text-pine-muted focus-visible:border-pine-iris focus-visible:ring-1 focus-visible:ring-pine-iris focus-visible:outline-hidden sm:max-w-xs"
              />

              <span class="ml-auto font-mono text-xs text-pine-subtle tabular-nums">
                {executionRange}
              </span>
            </div>

            <div class="hidden lg:block">
              <BulkActionBar
                selectedCount={selectedIds.size}
                busy={bulkBusy}
                note={bulkNote}
                onStopAndPause={handleStopAndPause}
                onRetryFailed={handleRetryFailed}
                onClear={() => {
                  setBulkNote(null);
                  setSelectedIds(new Set());
                }}
              />

              <ExecutionTable
                tasks={visibleTasks}
                loadError={executionsError}
                activeTaskId={activeTaskId}
                onActiveTaskId={setActiveTaskId}
                onOpen={setSelectedTask}
                onAbort={requestAbort}
                activeFilterLabel={activeFilterLabel}
                onClearFilters={clearFilters}
                pendingAbortId={pendingAbortId}
                selectable
                selectedIds={selectedIds}
                onToggleSelected={toggleSelected}
                onToggleAll={toggleAllVisible}
                allSelected={
                  visibleTasks.length > 0 && visibleTasks.every((task) => selectedIds.has(task.id))
                }
              />
            </div>

            <div class="flex flex-col gap-2 lg:hidden">
              {visibleTasks.map((task) => (
                <MobileTaskCard
                  key={task.id}
                  task={task}
                  busy={actionLoading.has(task.id)}
                  abortArmed={pendingAbortId === task.id}
                  onOpen={setSelectedTask}
                  onAbort={requestAbort}
                  onRetry={handleRetryTask}
                  selectable
                  selectedIds={selectedIds}
                  onToggleSelected={toggleSelected}
                />
              ))}

              {visibleTasks.length === 0 && (
                <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 text-center text-xs text-pine-subtle">
                  <p>
                    {executionsError
                      ? `Could not load executions: ${executionsError}`
                      : `No executions match ${activeFilterLabel}.`}
                  </p>
                  {!executionsError && (
                    <button
                      type="button"
                      onClick={clearFilters}
                      class="mt-2 min-h-11 cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 text-xs font-semibold text-pine-text hover:bg-pine-highlight"
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              )}
            </div>

            {hasMoreTasks && (
              <button
                type="button"
                onClick={() => void handleLoadMore()}
                disabled={loadingMore}
                class="min-h-11 cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text enabled:hover:bg-pine-highlight disabled:opacity-50"
              >
                {loadingMore ? 'Loading...' : `Load more (${tasks.length} of ${totalTasks})`}
              </button>
            )}
          </div>
        </section>
      </div>

      {selectedTask && (
        <SlideOverDrawer
          token={selectedTask.id}
          label="Execution"
          ariaLabel={
            selectedTask.title || `Task #${selectedTask.taskNumber ?? 0} execution details`
          }
          width="inspector"
          onClosed={closeInspector}
        >
          <ExecutionInspectorContent
            task={selectedTask}
            onAbort={handleCancelTask}
            onRetry={handleRetryTask}
            actionLoading={actionLoading.has(selectedTask.id)}
            noRunnerOnline={!runnerCoversRepo(runners, selectedTask.repositoryId)}
            renderOrigin={renderOriginLink}
          />
        </SlideOverDrawer>
      )}
    </div>
  );
};
