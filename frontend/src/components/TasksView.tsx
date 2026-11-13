import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import { dialogBackdropClickHandler } from '../utils/dialog';
import { formatDuration, formatDateTime, useTimeFormat } from '../utils/time';
import { taskStatusBadgeClass } from '../utils/status';
import {
  faCheck,
  faCopy,
  faPencil,
  faPlay,
  faPlus,
  faSync,
  faTrash,
  faTimes,
  faExternalLinkAlt,
} from '@fortawesome/free-solid-svg-icons';
import type {
  BacklogTaskRecord,
  PrPolicy,
  ReasoningEffort,
  RoutineTaskRecord,
  SwarmTask,
} from '../types';
import { EFFORT_OPTIONS } from '../config/fields';
import {
  cancelTask,
  getTasks,
  retryTask,
  getBacklogTasks,
  createBacklogTask,
  deleteBacklogTask,
  dispatchBacklogTask,
  syncGithubBacklog,
  getRoutines,
  createRoutine,
  updateRoutine,
  deleteRoutine,
  triggerRoutine,
} from '../api';
import { Icon } from './Icon';
import { ToggleSwitch } from './ToggleSwitch';
import { configStore, saveConfigOverrides, useStore } from '../state';

interface TasksViewProps {
  onRefresh?: () => void;
  onOpenDispatch?: () => void;
}

type TaskTab = 'executions' | 'backlog' | 'routines';

const STATUS_FILTERS = [
  'all',
  'queued',
  'claimed',
  'executing',
  'completed',
  'no_changes',
  'failed',
  'aborted',
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number];

// An empty optional number means "use the server default". 0 is a real value here (it removes
// the floor), so `Number('') === 0` must never reach the create call.
const parseOptionalNumber = (
  raw: string,
  min: number,
  max: number
): number | undefined | 'invalid' => {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < min || value > max) return 'invalid';
  return value;
};

export const TasksView = ({ onRefresh, onOpenDispatch }: TasksViewProps = {}) => {
  const [timeFormat] = useTimeFormat();

  // Tab state synced with URL ?tab=...
  const getTabFromUrl = (): TaskTab => {
    try {
      const p = new URLSearchParams(window.location.search).get('tab');
      if (p === 'backlog' || p === 'routines') return p;
    } catch {}
    return 'executions';
  };

  const [activeTab, setActiveTab] = useState<TaskTab>(getTabFromUrl);

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

  // --- Tier 1: Executions state ---
  const [tasks, setTasks] = useState<SwarmTask[]>([]);
  const [executionsInitialLoaded, setExecutionsInitialLoaded] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [selectedTask, setSelectedTask] = useState<SwarmTask | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const executionDialogRef = useRef<HTMLDialogElement>(null);
  const backlogDialogRef = useRef<HTMLDialogElement>(null);
  const routineDialogRef = useRef<HTMLDialogElement>(null);

  // --- Tier 2: Backlog state ---
  const [backlogTasks, setBacklogTasks] = useState<BacklogTaskRecord[]>([]);
  const [backlogLoading, setBacklogLoading] = useState(false);
  const [backlogInitialLoaded, setBacklogInitialLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // Deleting a work item loses a hand-written prompt, so the bin needs a second press.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [syncingGithub, setSyncingGithub] = useState(false);
  const [showCreateBacklog, setShowCreateBacklog] = useState(false);
  const [backlogActionId, setBacklogActionId] = useState<string | null>(null);
  const [backlogTitle, setBacklogTitle] = useState('');
  const [backlogPrompt, setBacklogPrompt] = useState('');
  const [backlogRepo, setBacklogRepo] = useState('');
  const [backlogModels, setBacklogModels] = useState('gemini-3.8-flash');
  const [backlogEffort, setBacklogEffort] = useState<ReasoningEffort>('high');

  // --- Tier 3: Routines state ---
  const [routines, setRoutines] = useState<RoutineTaskRecord[]>([]);
  const [routinesLoading, setRoutinesLoading] = useState(false);
  const [routinesInitialLoaded, setRoutinesInitialLoaded] = useState(false);
  const [showCreateRoutine, setShowCreateRoutine] = useState(false);
  const [editingRoutineId, setEditingRoutineId] = useState<string | null>(null);
  const [routineActionId, setRoutineActionId] = useState<string | null>(null);
  const [routineTitle, setRoutineTitle] = useState('');
  const [routinePrompt, setRoutinePrompt] = useState('');
  const [routineRepo, setRoutineRepo] = useState('');
  const [routineModels, setRoutineModels] = useState('gemini-3.8-flash');
  const [routineEffort, setRoutineEffort] = useState<ReasoningEffort>('high');
  const [routineTriggerHours, setRoutineTriggerHours] = useState('2');
  const [routineMinHeadroom, setRoutineMinHeadroom] = useState('10');
  const [routineVerifyCommand, setRoutineVerifyCommand] = useState('');
  const [routinePrPolicy, setRoutinePrPolicy] = useState<PrPolicy | ''>('');

  const [notification, setNotification] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const config = useStore(configStore).config;
  const repos = config.resolved?.repositories || [];
  // No invented fallback: with no repository configured the forms stay unsubmittable.
  const defaultRepoId = repos[0]?.id || '';
  const defaultModel = config.resolved?.defaultDispatchModel || 'gemini-3.8-flash';
  const routinesEnabled = config.resolved?.routinesEnabled !== false;

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  };

  // --- Data Loaders ---
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
      const list = await getBacklogTasks();
      setBacklogTasks(list);
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
      const list = await getRoutines();
      setRoutines(list);
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err?.message || String(err));
    } finally {
      setRoutinesLoading(false);
      setRoutinesInitialLoaded(true);
    }
  }, []);

  // The tab lives in a ref so switching tabs does not tear down the poll and refetch everything.
  const activeTabRef = useRef<TaskTab>(activeTab);
  activeTabRef.current = activeTab;

  useEffect(() => {
    loadExecutions();
    // Loaded once for the tab counters; the badge must not claim 0 while items exist.
    void loadBacklog();
    void loadRoutines();
    const timer = setInterval(() => {
      loadExecutions();
      if (activeTabRef.current === 'backlog') void loadBacklog();
      if (activeTabRef.current === 'routines') void loadRoutines();
    }, 4000);

    return () => clearInterval(timer);
  }, [loadExecutions, loadBacklog, loadRoutines]);

  // Each list loads on first paint of its tab, and on every tab switch.
  useEffect(() => {
    if (activeTab === 'backlog') void loadBacklog();
    if (activeTab === 'routines') void loadRoutines();
  }, [activeTab, loadBacklog, loadRoutines]);

  // ?id= is applied once per targeted id. Left in the URL it is re-matched on every poll,
  // which re-opens the inspector or re-scrolls rows the user moved away from.
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

    if (activeTab === 'executions') {
      if (!executionsInitialLoaded) return;
      const found = tasks.find((t) => t.id === searchId || t.originId === searchId);
      handledSearchId.current = searchId;
      if (found) {
        setSelectedTask(found);
      } else {
        clearUrlId();
        showNotification('error', 'The requested task was not found.');
      }
      return;
    }

    if (activeTab === 'routines') {
      if (!routinesInitialLoaded) return;
      const found = routines.some((r) => r.id === searchId);
      handledSearchId.current = searchId;
      if (found) {
        const row = document.getElementById(`task-row-${searchId}`);
        if (row) {
          row.scrollIntoView({ block: 'center' });
          setHighlightedId(searchId);
          const timer = setTimeout(() => setHighlightedId(null), 2500);
          return () => clearTimeout(timer);
        }
      } else {
        clearUrlId();
        showNotification('error', 'The requested routine was deleted or not found.');
      }
      return;
    }

    if (activeTab === 'backlog') {
      if (!backlogInitialLoaded) return;
      const found = backlogTasks.some((b) => b.id === searchId);
      handledSearchId.current = searchId;
      if (found) {
        const row = document.getElementById(`task-row-${searchId}`);
        if (row) {
          row.scrollIntoView({ block: 'center' });
          setHighlightedId(searchId);
          const timer = setTimeout(() => setHighlightedId(null), 2500);
          return () => clearTimeout(timer);
        }
      } else {
        clearUrlId();
        showNotification('error', 'The requested backlog task was deleted or not found.');
      }
      return;
    }
  }, [
    tasks,
    activeTab,
    backlogTasks,
    routines,
    executionsInitialLoaded,
    routinesInitialLoaded,
    backlogInitialLoaded,
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

  useEffect(() => {
    const dialog = executionDialogRef.current;
    if (!dialog) return;
    if (selectedTask) {
      if (!dialog.open) dialog.showModal();
    } else {
      if (dialog.open) dialog.close();
    }
  }, [selectedTask]);

  // `open` renders the form outside the top layer: no backdrop, no Escape, no focus trap.
  useEffect(() => {
    for (const [ref, shown] of [
      [backlogDialogRef, showCreateBacklog],
      [routineDialogRef, showCreateRoutine],
    ] as const) {
      const dialog = ref.current;
      if (shown && dialog && !dialog.open) dialog.showModal();
    }
  }, [showCreateBacklog, showCreateRoutine]);

  // --- Handlers: Executions ---
  const handleCancelTask = async (taskId: string) => {
    setActionLoading(true);
    try {
      await cancelTask(taskId);
      loadExecutions();
      onRefresh?.();
      closeInspector();
      showNotification('success', `Task ${taskId} cancelled`);
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

  // --- Handlers: Backlog ---
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

  const handleCreateBacklog = async (e: Event) => {
    e.preventDefault();
    if (!backlogTitle.trim() || !backlogPrompt.trim()) return;
    if (!(backlogRepo || defaultRepoId)) {
      showNotification('error', 'Add a repository in Settings before creating work items.');
      return;
    }

    const modelsList = backlogModels
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      await createBacklogTask({
        title: backlogTitle.trim(),
        prompt: backlogPrompt.trim(),
        repositoryId: backlogRepo || defaultRepoId,
        models: modelsList.length > 0 ? modelsList : [defaultModel],
        effort: backlogEffort,
        autoCreatePr: true,
      });
      setBacklogTitle('');
      setBacklogPrompt('');
      setShowCreateBacklog(false);
      await loadBacklog();
      showNotification('success', `Created backlog task`);
    } catch (err: any) {
      showNotification('error', `Failed to create backlog task: ${err?.message || String(err)}`);
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
      showNotification(
        'success',
        `Dispatched backlog task #${item.taskNumber} to queue (${res.taskId})`
      );
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

  // --- Handlers: Routines ---
  const handleToggleRoutinesMaster = async (enabled: boolean) => {
    try {
      await saveConfigOverrides({ routinesEnabled: enabled });
      showNotification('success', `Routines ${enabled ? 'activated' : 'paused'}`);
    } catch (err: any) {
      showNotification('error', `Failed to update routines state: ${err?.message || String(err)}`);
    }
  };

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
      showNotification('success', `Triggered routine "${routine.title}" (${res.taskId})`);
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

  const openCreateRoutineModal = () => {
    setEditingRoutineId(null);
    setRoutineTitle('');
    setRoutinePrompt('');
    setRoutineRepo(defaultRepoId);
    setRoutineModels(defaultModel);
    setRoutineEffort('medium');
    setRoutineTriggerHours('4');
    setRoutineMinHeadroom('15');
    setRoutineVerifyCommand('');
    setRoutinePrPolicy('');
    setShowCreateRoutine(true);
  };

  const openEditRoutineModal = (routine: RoutineTaskRecord) => {
    setEditingRoutineId(routine.id);
    setRoutineTitle(routine.title);
    setRoutinePrompt(routine.prompt);
    setRoutineRepo(routine.repositoryId);
    setRoutineModels(routine.models.join(', '));
    setRoutineEffort(routine.effort);
    setRoutineTriggerHours(
      routine.triggerBeforeResetHours !== undefined ? String(routine.triggerBeforeResetHours) : ''
    );
    setRoutineMinHeadroom(
      routine.minHeadroomPercent !== undefined ? String(routine.minHeadroomPercent) : ''
    );
    setRoutineVerifyCommand(routine.verifyCommand || '');
    setRoutinePrPolicy(routine.prPolicy || '');
    setShowCreateRoutine(true);
  };

  const handleSaveRoutine = async (e: Event) => {
    e.preventDefault();
    if (!routineTitle.trim() || !routinePrompt.trim()) return;
    if (!(routineRepo || defaultRepoId)) {
      showNotification('error', 'Add a repository in Settings before creating routines.');
      return;
    }

    const triggerHours = parseOptionalNumber(routineTriggerHours, 1, 24);
    const minHeadroom = parseOptionalNumber(routineMinHeadroom, 1, 90);
    if (triggerHours === 'invalid' || minHeadroom === 'invalid') {
      showNotification('error', 'Trigger window must be 1-24h and headroom floor 1-90%.');
      return;
    }

    const modelsList = routineModels
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      const title = routineTitle.trim();
      if (editingRoutineId) {
        await updateRoutine(editingRoutineId, {
          title,
          prompt: routinePrompt.trim(),
          repositoryId: routineRepo || defaultRepoId,
          models: modelsList.length > 0 ? modelsList : [defaultModel],
          effort: routineEffort,
          triggerBeforeResetHours: triggerHours,
          minHeadroomPercent: minHeadroom,
          verifyCommand: routineVerifyCommand.trim() || null,
          prPolicy: routinePrPolicy || null,
        });
      } else {
        await createRoutine({
          title,
          prompt: routinePrompt.trim(),
          repositoryId: routineRepo || defaultRepoId,
          models: modelsList.length > 0 ? modelsList : [defaultModel],
          effort: routineEffort,
          triggerBeforeResetHours: triggerHours,
          minHeadroomPercent: minHeadroom,
          verifyCommand: routineVerifyCommand.trim() || undefined,
          prPolicy: routinePrPolicy || undefined,
          enabled: true,
          autoCreatePr: true,
        });
      }
      const wasEditing = Boolean(editingRoutineId);
      setEditingRoutineId(null);
      setRoutineTitle('');
      setRoutinePrompt('');
      setRoutineVerifyCommand('');
      setRoutinePrPolicy('');
      setShowCreateRoutine(false);
      await loadRoutines();
      showNotification('success', `${wasEditing ? 'Updated' : 'Created'} routine "${title}"`);
    } catch (err: any) {
      showNotification(
        'error',
        `Failed to ${editingRoutineId ? 'update' : 'create'} routine: ${err?.message || String(err)}`
      );
    }
  };

  // One width cap for origin labels: an untruncated title here widens the whole table
  const originLabelClass = 'inline-block max-w-36 truncate align-bottom';

  const renderOriginLink = (t: SwarmTask) => {
    if (t.tier === 'backlog' || (t.requestedBy && t.requestedBy.startsWith('backlog:'))) {
      const originId = t.originId || t.requestedBy?.replace(/^backlog:/, '');
      const exists =
        !backlogInitialLoaded || (originId ? backlogTasks.some((b) => b.id === originId) : false);
      const label = t.originNumber
        ? `Backlog: Task #${t.originNumber}`
        : t.originTitle
          ? `Backlog: ${t.originTitle}`
          : 'Backlog: Task';

      if (backlogInitialLoaded && !exists) {
        return (
          <span
            class={`${originLabelClass} font-medium text-pine-subtle`}
            title="Origin backlog task was deleted"
          >
            {label} <span class="text-xs font-normal text-pine-muted">(deleted)</span>
          </span>
        );
      }

      return (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setTab('backlog', originId);
          }}
          class={`${originLabelClass} cursor-pointer text-left font-medium text-pine-iris hover:underline`}
          title={label}
        >
          {label}
        </button>
      );
    }
    if (
      t.tier === 'routine' ||
      (t.requestedBy &&
        (t.requestedBy.startsWith('routine:') || t.requestedBy.startsWith('standing-task:')))
    ) {
      const originId = t.originId || t.requestedBy?.replace(/^routine:|^standing-task:/, '');
      const exists =
        !routinesInitialLoaded || (originId ? routines.some((r) => r.id === originId) : false);
      const label = t.originTitle
        ? `Routine: ${t.originTitle}`
        : t.originNumber
          ? `Routine #${t.originNumber}`
          : 'Routine';

      if (routinesInitialLoaded && !exists) {
        return (
          <span
            class={`${originLabelClass} font-medium text-pine-subtle`}
            title="Origin routine was deleted"
          >
            {label} <span class="text-xs font-normal text-pine-muted">(deleted)</span>
          </span>
        );
      }

      return (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setTab('routines', originId);
          }}
          class={`${originLabelClass} cursor-pointer text-left font-medium text-pine-iris hover:underline`}
          title={label}
        >
          {label}
        </button>
      );
    }
    return (
      <span class={`${originLabelClass} text-pine-subtle`} title={t.requestedBy || 'web-ui'}>
        {t.requestedBy || 'web-ui'}
      </span>
    );
  };

  const visibleTasks = tasks.filter((t) => {
    if (filter === 'all') return true;
    return t.status === filter;
  });

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

      {/* Top Segmented Sub-view Switcher & Actions */}
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-pine-highlight pb-4">
        {/* Segmented Switcher */}
        <div
          role="tablist"
          aria-label="Task management tabs"
          class="flex rounded-lg border border-pine-highlight bg-pine-overlay/40 p-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'executions'}
            onClick={() => setTab('executions')}
            class={`cursor-pointer rounded-md px-4 py-1.5 text-xs font-bold uppercase transition-all sm:text-sm ${
              activeTab === 'executions'
                ? 'bg-pine-iris text-pine-base shadow-xs'
                : 'text-pine-subtle hover:text-pine-text'
            }`}
          >
            Executions ({tasks.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'backlog'}
            onClick={() => setTab('backlog')}
            class={`cursor-pointer rounded-md px-4 py-1.5 text-xs font-bold uppercase transition-all sm:text-sm ${
              activeTab === 'backlog'
                ? 'bg-pine-iris text-pine-base shadow-xs'
                : 'text-pine-subtle hover:text-pine-text'
            }`}
          >
            Backlog ({backlogTasks.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'routines'}
            onClick={() => setTab('routines')}
            class={`cursor-pointer rounded-md px-4 py-1.5 text-xs font-bold uppercase transition-all sm:text-sm ${
              activeTab === 'routines'
                ? 'bg-pine-iris text-pine-base shadow-xs'
                : 'text-pine-subtle hover:text-pine-text'
            }`}
          >
            Routines ({routines.length})
          </button>
        </div>

        {/* Tab-specific top controls */}
        <div class="flex flex-wrap items-center gap-2">
          {activeTab === 'executions' && onOpenDispatch && (
            <button
              type="button"
              onClick={onOpenDispatch}
              class="flex cursor-pointer items-center gap-1.5 rounded-lg bg-pine-iris px-3.5 py-1.5 text-xs font-semibold text-pine-base shadow-xs transition-opacity hover:opacity-90 sm:text-sm"
              title="Dispatch manual execution to runner"
            >
              <Icon icon={faPlus} class="size-3.5" />
              <span>New Execution</span>
            </button>
          )}

          {activeTab === 'backlog' && (
            <>
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
              <button
                type="button"
                onClick={() => setShowCreateBacklog(true)}
                class="flex cursor-pointer items-center gap-1.5 rounded-lg bg-pine-iris px-3.5 py-1.5 text-xs font-semibold text-pine-base shadow-xs transition-opacity hover:opacity-90 sm:text-sm"
              >
                <Icon icon={faPlus} class="size-3.5" />
                <span>Add Work Item</span>
              </button>
            </>
          )}

          {activeTab === 'routines' && (
            <>
              <div class="flex items-center gap-2 rounded-lg border border-pine-highlight bg-pine-overlay/40 px-3 py-1.5 text-xs sm:text-sm">
                <span class="font-medium text-pine-subtle">Routines Master:</span>
                <ToggleSwitch
                  checked={routinesEnabled}
                  label="Toggle Routines master switch"
                  onChange={handleToggleRoutinesMaster}
                />
                <span
                  class={`text-xs font-bold uppercase ${routinesEnabled ? 'text-pine-foam' : 'text-pine-love'}`}
                >
                  {routinesEnabled ? 'Active' : 'Paused'}
                </span>
              </div>
              <button
                type="button"
                onClick={openCreateRoutineModal}
                class="flex cursor-pointer items-center gap-1.5 rounded-lg bg-pine-iris px-3.5 py-1.5 text-xs font-semibold text-pine-base shadow-xs transition-opacity hover:opacity-90 sm:text-sm"
              >
                <Icon icon={faPlus} class="size-3.5" />
                <span>New Routine</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* --- TAB 1: EXECUTIONS --- */}
      {activeTab === 'executions' && (
        <div class="flex flex-col gap-4">
          {/* Status filter bar */}
          <div
            role="group"
            aria-label="Filter executions by status"
            class="flex max-w-full flex-wrap gap-1.5 rounded-lg border border-pine-highlight bg-pine-surface p-1"
          >
            {STATUS_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                class={`cursor-pointer rounded-md px-3 py-1 text-xs font-semibold whitespace-nowrap uppercase transition-colors ${
                  filter === f
                    ? 'bg-pine-iris text-pine-base shadow-xs'
                    : 'text-pine-subtle hover:bg-pine-overlay/60 hover:text-pine-text'
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          {/* Table */}
          <div class="overflow-x-auto rounded-xl border border-pine-highlight bg-pine-surface shadow-sm">
            <table class="w-full min-w-[858px] text-left text-sm">
              <thead>
                <tr class="border-b border-pine-highlight bg-pine-overlay/40 font-mono text-xs tracking-wider text-pine-subtle uppercase sm:text-[14.3px]">
                  <th class="p-3.5 whitespace-nowrap">Task</th>
                  <th class="p-3.5 whitespace-nowrap">When</th>
                  <th class="p-3.5 whitespace-nowrap">Repository</th>
                  <th class="p-3.5 whitespace-nowrap">Model / Effort</th>
                  <th class="p-3.5 whitespace-nowrap">By</th>
                  <th class="p-3.5 whitespace-nowrap">Branch / PR</th>
                  <th class="p-3.5 whitespace-nowrap">Duration</th>
                  <th class="p-3.5 whitespace-nowrap">Status</th>
                  <th class="p-3.5 text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-pine-highlight/40">
                {visibleTasks.length === 0 ? (
                  <tr>
                    <td colSpan={9} class="p-8 text-center text-sm text-pine-subtle">
                      {loadError
                        ? `Could not load executions: ${loadError}`
                        : 'No executions matching the selected filter.'}
                    </td>
                  </tr>
                ) : (
                  visibleTasks.map((t) => (
                    <tr
                      key={t.id}
                      onClick={() => setSelectedTask(t)}
                      class="cursor-pointer transition-colors hover:bg-pine-overlay/30"
                    >
                      <td class="max-w-xs min-w-[220px] p-3.5 md:max-w-sm xl:max-w-md">
                        <div class="flex items-center gap-1.5">
                          <span class="shrink-0 rounded-sm bg-pine-overlay px-1.5 py-0.5 font-mono text-xs font-bold whitespace-nowrap text-pine-iris">
                            #{t.taskNumber || 0}
                          </span>
                          <span
                            class="truncate text-sm font-medium text-pine-text"
                            title={t.title || t.prompt}
                          >
                            {t.title || 'Task'}
                          </span>
                        </div>
                      </td>
                      <td class="p-3.5 text-sm whitespace-nowrap text-pine-subtle">
                        {formatDateTime(t.createdAt, { timeFormat })}
                      </td>
                      <td class="p-3.5 font-mono text-sm text-pine-text">{t.repositoryName}</td>
                      <td class="p-3.5 font-mono text-sm whitespace-nowrap text-pine-iris">
                        {t.model}
                        <span class="text-pine-subtle"> · {t.effort}</span>
                      </td>
                      <td class="p-3.5 text-sm whitespace-nowrap">{renderOriginLink(t)}</td>
                      <td class="p-3.5 font-mono text-sm text-pine-subtle">
                        {t.prUrl ? (
                          <a
                            href={t.prUrl}
                            target="_blank"
                            rel="noreferrer"
                            class="inline-flex items-center gap-1 text-pine-iris hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span>PR</span>
                            <Icon icon={faExternalLinkAlt} class="size-2.5" />
                          </a>
                        ) : t.branchName ? (
                          <span class="inline-block max-w-[143px] truncate" title={t.branchName}>
                            {t.branchName}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td class="p-3.5 font-mono text-sm whitespace-nowrap text-pine-subtle">
                        {formatDuration(t.durationMs)}
                      </td>
                      <td class="p-3.5 whitespace-nowrap">
                        <span
                          class={`inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold tracking-wide whitespace-nowrap uppercase ${taskStatusBadgeClass(t.status)}`}
                        >
                          {t.status}
                        </span>
                      </td>
                      <td
                        class="p-3.5 text-right whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {t.status === 'queued' ||
                        t.status === 'claimed' ||
                        t.status === 'executing' ? (
                          <button
                            type="button"
                            onClick={() => handleCancelTask(t.id)}
                            disabled={actionLoading}
                            class="cursor-pointer rounded-sm border border-pine-love/30 bg-pine-love/10 px-2.5 py-1 text-xs font-semibold text-pine-love hover:bg-pine-love hover:text-white"
                          >
                            Abort
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleRetryTask(t.id)}
                            disabled={actionLoading}
                            class="cursor-pointer rounded-sm border border-pine-highlight bg-pine-overlay px-2.5 py-1 text-xs font-semibold text-pine-text hover:bg-pine-highlight"
                          >
                            Retry
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* --- TAB 2: BACKLOG --- */}
      {activeTab === 'backlog' && (
        <div class="flex flex-col gap-4">
          <div class="overflow-x-auto rounded-xl border border-pine-highlight bg-pine-surface shadow-sm">
            <table class="w-full min-w-[858px] text-left text-sm">
              <thead>
                <tr class="border-b border-pine-highlight bg-pine-overlay/40 font-mono text-xs tracking-wider text-pine-subtle uppercase sm:text-[14.3px]">
                  <th class="p-3.5 whitespace-nowrap">#</th>
                  <th class="p-3.5 whitespace-nowrap">Work Item</th>
                  <th class="p-3.5 whitespace-nowrap">Repository</th>
                  <th class="p-3.5 whitespace-nowrap">Model Preference Chain</th>
                  <th class="p-3.5 whitespace-nowrap">Priority</th>
                  <th class="p-3.5 whitespace-nowrap">Attempts</th>
                  <th class="p-3.5 whitespace-nowrap">Status</th>
                  <th class="p-3.5 whitespace-nowrap">Issue</th>
                  <th class="p-3.5 text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-pine-highlight/40">
                {backlogLoading && backlogTasks.length === 0 ? (
                  <tr>
                    <td colSpan={9} class="p-8 text-center text-sm text-pine-muted">
                      Loading backlog tasks...
                    </td>
                  </tr>
                ) : backlogTasks.length === 0 ? (
                  <tr>
                    <td colSpan={9} class="p-8 text-center text-sm text-pine-muted">
                      {loadError
                        ? `Could not load backlog: ${loadError}`
                        : "No backlog work items queued. Add one manually or click 'Sync GitHub'."}
                    </td>
                  </tr>
                ) : (
                  backlogTasks.map((item) => (
                    <tr
                      key={item.id}
                      id={`task-row-${item.id}`}
                      class={`align-top transition-colors hover:bg-pine-overlay/20 ${
                        highlightedId === item.id ? 'ring-2 ring-pine-iris/60 ring-inset' : ''
                      }`}
                    >
                      <td class="p-3.5 font-mono text-sm font-bold whitespace-nowrap text-pine-iris">
                        #{item.taskNumber}
                      </td>
                      <td class="max-w-sm p-3.5">
                        <div class="text-sm font-semibold text-pine-text">{item.title}</div>
                        <div
                          class="mt-0.5 line-clamp-2 text-xs text-pine-subtle sm:text-[14.3px]"
                          title={item.prompt}
                        >
                          {item.prompt}
                        </div>
                        {item.lastError && (
                          <div
                            class="mt-1 line-clamp-1 font-mono text-xs text-pine-love"
                            title={item.lastError}
                          >
                            Last error: {item.lastError}
                          </div>
                        )}
                      </td>
                      <td class="p-3.5 font-mono text-sm whitespace-nowrap text-pine-subtle">
                        {item.repositoryId}
                      </td>
                      <td class="p-3.5 text-sm">
                        <div class="flex flex-wrap gap-1">
                          {item.models.map((m) => (
                            <span
                              key={m}
                              class="rounded-sm bg-pine-overlay px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-pine-iris"
                            >
                              {m}
                            </span>
                          ))}
                        </div>
                        <div class="mt-0.5 text-xs text-pine-subtle">Effort: {item.effort}</div>
                      </td>
                      <td class="p-3.5 font-mono text-sm whitespace-nowrap text-pine-subtle">
                        P{item.priorityOrder}
                      </td>
                      <td class="p-3.5 font-mono text-sm whitespace-nowrap">
                        <span
                          title="Autonomous retry budget. A manual dispatch is always allowed."
                          class={
                            item.attemptCount >= item.maxAttempts
                              ? 'font-bold text-pine-love'
                              : 'text-pine-subtle'
                          }
                        >
                          {item.attemptCount} / {item.maxAttempts}
                        </span>
                      </td>
                      <td class="p-3.5 whitespace-nowrap">
                        <span
                          class={`inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold tracking-wide whitespace-nowrap uppercase ${
                            item.status === 'completed'
                              ? 'border-pine-pine/40 bg-pine-pine/15 text-pine-foam'
                              : item.status === 'failed'
                                ? 'border-pine-love/40 bg-pine-love/15 text-pine-love'
                                : item.status === 'dispatched'
                                  ? 'animate-pulse border-pine-gold/40 bg-pine-gold/15 text-pine-gold'
                                  : 'border-pine-highlight bg-pine-overlay/60 text-pine-subtle'
                          }`}
                        >
                          {item.status}
                        </span>
                      </td>
                      <td class="p-3.5 whitespace-nowrap">
                        {item.githubIssueUrl ? (
                          <a
                            href={item.githubIssueUrl}
                            target="_blank"
                            rel="noreferrer"
                            class="inline-flex items-center gap-1 font-mono text-xs text-pine-iris hover:underline"
                          >
                            <span>#{item.githubIssueNumber}</span>
                            <Icon icon={faExternalLinkAlt} class="size-2.5" />
                          </a>
                        ) : (
                          <span class="text-xs text-pine-subtle">—</span>
                        )}
                      </td>
                      <td class="p-3.5 text-right whitespace-nowrap">
                        <div class="flex items-center justify-end gap-1.5">
                          {item.status === 'pending' || item.status === 'failed' ? (
                            <button
                              type="button"
                              onClick={() => handleDispatchBacklog(item)}
                              disabled={backlogActionId === item.id}
                              class="cursor-pointer rounded-sm border border-pine-iris/30 bg-pine-iris/10 px-2.5 py-1 text-xs font-semibold text-pine-iris transition-colors hover:bg-pine-iris hover:text-pine-base"
                              title="Dispatch immediately to swarm queue"
                            >
                              Dispatch
                            </button>
                          ) : null}
                          {pendingDelete === item.id ? (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setPendingDelete(null);
                                  void handleDeleteBacklog(item.id);
                                }}
                                disabled={backlogActionId === item.id}
                                class="cursor-pointer rounded-sm border border-pine-love/50 bg-pine-love/15 px-2 py-1 text-xs font-bold whitespace-nowrap text-pine-love"
                              >
                                Delete?
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingDelete(null)}
                                class="cursor-pointer rounded-sm border border-pine-highlight p-1 text-pine-muted hover:text-pine-text"
                                aria-label="Cancel delete"
                              >
                                <Icon icon={faTimes} class="size-3.5" />
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setPendingDelete(item.id)}
                              disabled={backlogActionId === item.id}
                              class="cursor-pointer rounded-sm border border-pine-highlight p-1 text-pine-muted transition-colors hover:text-pine-love"
                              title="Delete work item"
                            >
                              <Icon icon={faTrash} class="size-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* --- TAB 3: ROUTINES --- */}
      {activeTab === 'routines' && (
        <div class="flex flex-col gap-4">
          <div class="overflow-x-auto rounded-xl border border-pine-highlight bg-pine-surface shadow-sm">
            <table class="w-full min-w-[858px] text-left text-sm">
              <thead>
                <tr class="border-b border-pine-highlight bg-pine-overlay/40 font-mono text-xs tracking-wider text-pine-subtle uppercase sm:text-[14.3px]">
                  <th class="p-3.5 whitespace-nowrap">#</th>
                  <th class="p-3.5 whitespace-nowrap">Routine Template</th>
                  <th class="p-3.5 whitespace-nowrap">Repository</th>
                  <th class="p-3.5 whitespace-nowrap">Model Preference Chain</th>
                  <th class="p-3.5 whitespace-nowrap">Trigger Pre-Reset</th>
                  <th class="p-3.5 whitespace-nowrap">Floor</th>
                  <th class="p-3.5 whitespace-nowrap">Last Cycle Run</th>
                  <th class="p-3.5 whitespace-nowrap">Active</th>
                  <th class="p-3.5 text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-pine-highlight/40">
                {routinesLoading && routines.length === 0 ? (
                  <tr>
                    <td colSpan={9} class="p-8 text-center text-sm text-pine-muted">
                      Loading routine templates...
                    </td>
                  </tr>
                ) : routines.length === 0 ? (
                  <tr>
                    <td colSpan={9} class="p-8 text-center text-sm text-pine-muted">
                      {loadError
                        ? `Could not load routines: ${loadError}`
                        : 'No routines configured. Create one to automatically burn quota before weekly resets.'}
                    </td>
                  </tr>
                ) : (
                  routines.map((routine) => (
                    <tr
                      key={routine.id}
                      id={`task-row-${routine.id}`}
                      class={`align-top transition-colors hover:bg-pine-overlay/20 ${
                        highlightedId === routine.id ? 'ring-2 ring-pine-iris/60 ring-inset' : ''
                      }`}
                    >
                      <td class="p-3.5 font-mono text-sm font-bold whitespace-nowrap text-pine-iris">
                        #{routine.taskNumber}
                      </td>
                      <td class="max-w-sm p-3.5">
                        <div class="text-sm font-semibold text-pine-text">{routine.title}</div>
                        <div
                          class="mt-0.5 line-clamp-2 text-xs text-pine-subtle sm:text-[14.3px]"
                          title={routine.prompt}
                        >
                          {routine.prompt}
                        </div>
                        {routine.verifyCommand && (
                          <div class="mt-1 font-mono text-xs text-pine-foam">
                            verify: {routine.verifyCommand}
                          </div>
                        )}
                      </td>
                      <td class="p-3.5 font-mono text-sm whitespace-nowrap text-pine-subtle">
                        {routine.repositoryId}
                      </td>
                      <td class="p-3.5 text-sm">
                        <div class="flex flex-wrap gap-1">
                          {routine.models.map((m) => (
                            <span
                              key={m}
                              class="rounded-sm bg-pine-overlay px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-pine-iris"
                            >
                              {m}
                            </span>
                          ))}
                        </div>
                        <div class="mt-0.5 text-xs text-pine-subtle">Effort: {routine.effort}</div>
                      </td>
                      <td class="p-3.5 font-mono text-sm whitespace-nowrap text-pine-gold">
                        &le; {routine.triggerBeforeResetHours}h
                      </td>
                      <td class="p-3.5 font-mono text-sm whitespace-nowrap text-pine-subtle">
                        &ge; {routine.minHeadroomPercent}%
                      </td>
                      <td class="p-3.5 font-mono text-sm whitespace-nowrap text-pine-subtle">
                        {routine.lastTriggeredResetTime ? (
                          <span title={routine.lastTriggeredResetTime}>
                            {formatDateTime(routine.lastTriggeredResetTime, { timeFormat })}
                          </span>
                        ) : (
                          'Never'
                        )}
                      </td>
                      <td class="p-3.5 whitespace-nowrap">
                        <ToggleSwitch
                          checked={routine.enabled}
                          label={`Toggle ${routine.title}`}
                          onChange={() => handleToggleRoutineItem(routine)}
                          disabled={routineActionId === routine.id}
                        />
                      </td>
                      <td class="p-3.5 text-right whitespace-nowrap">
                        <div class="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleTriggerRoutineNow(routine)}
                            disabled={routineActionId === routine.id}
                            class="inline-flex size-7 cursor-pointer items-center justify-center rounded-sm border border-pine-iris/30 bg-pine-iris/10 text-pine-iris transition-colors hover:bg-pine-iris hover:text-pine-base"
                            title="Trigger immediate execution with preference chain"
                            aria-label={`Trigger ${routine.title}`}
                          >
                            <Icon icon={faPlay} class="size-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditRoutineModal(routine)}
                            disabled={routineActionId === routine.id}
                            class="inline-flex size-7 cursor-pointer items-center justify-center rounded-sm border border-pine-highlight bg-pine-overlay/50 text-pine-subtle transition-colors hover:border-pine-foam/40 hover:text-pine-foam"
                            title="Edit routine"
                            aria-label={`Edit ${routine.title}`}
                          >
                            <Icon icon={faPencil} class="size-3" />
                          </button>
                          {pendingDelete === routine.id ? (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setPendingDelete(null);
                                  void handleDeleteRoutine(routine.id);
                                }}
                                disabled={routineActionId === routine.id}
                                class="cursor-pointer rounded-sm border border-pine-love/50 bg-pine-love/15 px-2 py-1 text-xs font-bold whitespace-nowrap text-pine-love"
                              >
                                Delete?
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingDelete(null)}
                                class="inline-flex size-7 cursor-pointer items-center justify-center rounded-sm border border-pine-highlight text-pine-muted hover:text-pine-text"
                                aria-label="Cancel delete"
                              >
                                <Icon icon={faTimes} class="size-3.5" />
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setPendingDelete(routine.id)}
                              disabled={routineActionId === routine.id}
                              class="inline-flex size-7 cursor-pointer items-center justify-center rounded-sm border border-pine-love/30 bg-pine-love/10 text-pine-love transition-colors hover:bg-pine-love hover:text-pine-base"
                              title="Delete routine"
                              aria-label={`Delete ${routine.title}`}
                            >
                              <Icon icon={faTrash} class="size-3" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* --- MODAL: EXECUTION DETAIL INSPECTOR --- */}
      {selectedTask && (
        <dialog
          id="execution-dialog"
          aria-labelledby="execution-dialog-title"
          aria-modal="true"
          ref={executionDialogRef}
          onClose={closeInspector}
          onClick={dialogBackdropClickHandler(executionDialogRef, closeInspector)}
          class="fixed inset-0 m-auto max-h-[85vh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-xl border border-pine-highlight bg-pine-surface p-4 text-pine-text shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-xs sm:p-6"
        >
          <div class="flex items-start justify-between border-b border-pine-highlight pb-3">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <h2
                  id="execution-dialog-title"
                  class="text-base font-bold wrap-break-word text-pine-text"
                >
                  {selectedTask.title
                    ? selectedTask.title
                    : `Task #${selectedTask.taskNumber || selectedTask.id}`}
                </h2>
                <span
                  class={`rounded-sm border px-2 py-0.5 text-xs font-bold whitespace-nowrap uppercase ${taskStatusBadgeClass(selectedTask.status)}`}
                >
                  {selectedTask.status}
                </span>
              </div>
              <p class="mt-1 font-mono text-xs text-pine-subtle">
                ID: {selectedTask.id} &bull; {selectedTask.repositoryName} &bull;{' '}
                {selectedTask.model} ({selectedTask.effort})
              </p>
            </div>
            <button
              type="button"
              onClick={closeInspector}
              aria-label="Close task details"
              class="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-lg border border-pine-highlight text-pine-subtle hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
            >
              <Icon icon={faTimes} class="size-4" />
            </button>
          </div>

          <div class="mt-4 flex flex-col gap-4 text-xs">
            {/* Metadata Grid */}
            <div class="grid grid-cols-1 gap-3 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <span class="text-pine-subtle">Initiated By</span>
                <div class="mt-0.5 font-medium text-pine-text">
                  {renderOriginLink(selectedTask)}
                </div>
              </div>
              <div>
                <span class="text-pine-subtle">Timestamp</span>
                <div class="mt-0.5 font-mono text-xs whitespace-nowrap text-pine-text">
                  {formatDateTime(selectedTask.createdAt, { timeFormat })}
                </div>
              </div>
              <div>
                <span class="text-pine-subtle">Duration</span>
                <div class="mt-0.5 font-medium text-pine-text">
                  {formatDuration(selectedTask.durationMs)}
                </div>
              </div>
              <div>
                <span class="text-pine-subtle">Branch / PR</span>
                <div class="mt-0.5 truncate font-mono text-xs text-pine-foam">
                  {selectedTask.prUrl ? (
                    <a
                      href={selectedTask.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      class="text-pine-iris hover:underline"
                    >
                      View PR
                    </a>
                  ) : (
                    selectedTask.branchName || '—'
                  )}
                </div>
              </div>
            </div>

            {/* Prompt Block */}
            <div>
              <div class="mb-1 flex items-center justify-between">
                <h3 class="text-xs font-semibold text-pine-subtle uppercase">Prompt</h3>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(selectedTask.prompt);
                    setCopiedPrompt(true);
                    setTimeout(() => setCopiedPrompt(false), 2000);
                  }}
                  class="cursor-pointer rounded-sm bg-pine-overlay px-1.5 py-0.5 text-xs text-pine-subtle hover:text-pine-text"
                >
                  <Icon icon={copiedPrompt ? faCheck : faCopy} class="mr-1 inline size-2.5" />
                  {copiedPrompt ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div class="max-h-40 overflow-y-auto rounded-lg border border-pine-highlight bg-pine-overlay p-3 font-mono wrap-break-word break-all whitespace-pre-wrap">
                {selectedTask.prompt}
              </div>
            </div>

            {/* Model Output Block (Rendered even on failure!) */}
            {selectedTask.output && (
              <div>
                <h3 class="mb-1 text-xs font-semibold text-pine-subtle uppercase">
                  Model Output Log
                </h3>
                <div class="max-h-48 overflow-y-auto rounded-lg border border-pine-highlight bg-pine-base p-3 font-mono text-xs wrap-break-word break-all whitespace-pre-wrap text-pine-foam">
                  {selectedTask.output}
                </div>
              </div>
            )}

            {/* Error Block */}
            {selectedTask.error && (
              <div>
                <h4 class="mb-1 text-xs font-semibold text-pine-love uppercase">
                  Failure Diagnostic
                </h4>
                <div class="max-h-36 min-w-0 overflow-x-hidden overflow-y-auto rounded-lg border border-pine-love/40 bg-pine-love/15 p-3 font-mono text-xs wrap-break-word break-all whitespace-pre-wrap text-pine-love">
                  {selectedTask.error}
                </div>
              </div>
            )}
          </div>
        </dialog>
      )}

      {/* --- MODAL: CREATE BACKLOG TASK --- */}
      {showCreateBacklog && (
        <dialog
          id="backlog-dialog"
          aria-labelledby="backlog-dialog-title"
          aria-modal="true"
          ref={backlogDialogRef}
          onClose={() => setShowCreateBacklog(false)}
          onClick={dialogBackdropClickHandler(backlogDialogRef, () => setShowCreateBacklog(false))}
          class="fixed inset-0 m-auto max-h-[85vh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl border border-pine-highlight bg-pine-surface p-5 text-pine-text shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-xs"
        >
          <div class="flex items-center justify-between border-b border-pine-highlight pb-3">
            <h2 id="backlog-dialog-title" class="text-base font-bold text-pine-text">
              New Backlog Work Item
            </h2>
            <button
              type="button"
              onClick={() => setShowCreateBacklog(false)}
              aria-label="Close create backlog work item dialog"
              class="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-lg border border-pine-highlight text-pine-subtle hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
            >
              <Icon icon={faTimes} class="size-4" />
            </button>
          </div>
          <form onSubmit={handleCreateBacklog} class="mt-4 flex flex-col gap-3.5 text-xs">
            <div>
              <label class="mb-1 block font-medium text-pine-subtle">Title</label>
              <input
                type="text"
                required
                value={backlogTitle}
                onInput={(e) => setBacklogTitle((e.target as HTMLInputElement).value)}
                placeholder="e.g. Migrate database schema for payments"
                class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-pine-text focus:border-pine-iris focus:outline-hidden"
              />
            </div>
            <div>
              <label class="mb-1 block font-medium text-pine-subtle">Target Repository</label>
              <select
                value={backlogRepo || defaultRepoId}
                onChange={(e) => setBacklogRepo((e.target as HTMLSelectElement).value)}
                class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-pine-text focus:border-pine-iris focus:outline-hidden"
              >
                {repos.map((r: any) => (
                  <option key={r.id} value={r.id}>
                    {r.name || r.id}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label class="mb-1 block font-medium text-pine-subtle">
                Model Preference Chain (comma-separated, evaluated in order)
              </label>
              <input
                type="text"
                required
                value={backlogModels}
                onInput={(e) => setBacklogModels((e.target as HTMLInputElement).value)}
                placeholder="gemini-3.8-flash, gemini-4-argon, claude-sonnet-5-5"
                class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 font-mono text-pine-text focus:border-pine-iris focus:outline-hidden"
              />
            </div>
            <div>
              <label class="mb-1 block font-medium text-pine-subtle">Reasoning Effort</label>
              <select
                value={backlogEffort}
                onChange={(e) =>
                  setBacklogEffort((e.target as HTMLSelectElement).value as ReasoningEffort)
                }
                class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-pine-text focus:border-pine-iris focus:outline-hidden"
              >
                {EFFORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label class="mb-1 block font-medium text-pine-subtle">Task Prompt</label>
              <textarea
                required
                rows={5}
                value={backlogPrompt}
                onInput={(e) => setBacklogPrompt((e.target as HTMLTextAreaElement).value)}
                placeholder="Detailed instructions for the autonomous coding agent..."
                class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 font-mono text-pine-text focus:border-pine-iris focus:outline-hidden"
              />
            </div>
            <div class="mt-2 flex items-center justify-end gap-2 border-t border-pine-highlight pt-3">
              <button
                type="button"
                onClick={() => setShowCreateBacklog(false)}
                class="cursor-pointer rounded-lg border border-pine-highlight px-3.5 py-1.5 font-medium text-pine-subtle hover:bg-pine-overlay"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="cursor-pointer rounded-lg bg-pine-iris px-4 py-1.5 font-bold text-pine-base shadow-xs hover:opacity-90"
              >
                Create Work Item
              </button>
            </div>
          </form>
        </dialog>
      )}

      {/* --- MODAL: CREATE / EDIT ROUTINE --- */}
      {showCreateRoutine && (
        <dialog
          id="routine-dialog"
          ref={routineDialogRef}
          aria-labelledby="routineDialogTitle"
          aria-modal="true"
          onClose={() => {
            setShowCreateRoutine(false);
            setEditingRoutineId(null);
          }}
          onClick={dialogBackdropClickHandler(routineDialogRef, () => {
            setShowCreateRoutine(false);
            setEditingRoutineId(null);
          })}
          class="fixed inset-0 m-auto max-h-[85vh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl border border-pine-highlight bg-pine-surface p-5 text-pine-text shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-xs"
        >
          <div class="flex items-center justify-between border-b border-pine-highlight pb-3">
            <h2 id="routineDialogTitle" class="text-base font-bold text-pine-text">
              {editingRoutineId ? 'Edit Maintenance Routine' : 'New Maintenance Routine'}
            </h2>
            <button
              type="button"
              aria-label="Close dialog"
              onClick={() => {
                setShowCreateRoutine(false);
                setEditingRoutineId(null);
              }}
              class="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-lg border border-pine-highlight text-pine-subtle transition-colors hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
            >
              <Icon icon={faTimes} class="size-4" />
            </button>
          </div>
          <form onSubmit={handleSaveRoutine} class="mt-4 flex flex-col gap-3.5 text-xs">
            <div>
              <label class="mb-1 block font-medium text-pine-subtle">Routine Title</label>
              <input
                type="text"
                required
                value={routineTitle}
                onInput={(e) => setRoutineTitle((e.target as HTMLInputElement).value)}
                placeholder="e.g. Audit dependencies and latent race conditions"
                class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-pine-text focus:border-pine-iris focus:outline-hidden"
              />
            </div>
            <div>
              <label class="mb-1 block font-medium text-pine-subtle">Target Repository</label>
              <select
                value={routineRepo || defaultRepoId}
                onChange={(e) => setRoutineRepo((e.target as HTMLSelectElement).value)}
                class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-pine-text focus:border-pine-iris focus:outline-hidden"
              >
                {repos.map((r: any) => (
                  <option key={r.id} value={r.id}>
                    {r.name || r.id}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label class="mb-1 block font-medium text-pine-subtle">
                Model Preference Chain (comma-separated)
              </label>
              <input
                type="text"
                required
                value={routineModels}
                onInput={(e) => setRoutineModels((e.target as HTMLInputElement).value)}
                placeholder="claude-sonnet-5-5, gemini-3.8-flash"
                class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 font-mono text-pine-text focus:border-pine-iris focus:outline-hidden"
              />
            </div>
            <div>
              <label class="mb-1 block font-medium text-pine-subtle">Reasoning Effort</label>
              <select
                value={routineEffort}
                onChange={(e) =>
                  setRoutineEffort((e.target as HTMLSelectElement).value as ReasoningEffort)
                }
                class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-pine-text focus:border-pine-iris focus:outline-hidden"
              >
                {EFFORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label class="mb-1 block font-medium text-pine-subtle">Trigger Before Reset</label>
                <div class="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={1}
                    max={24}
                    value={routineTriggerHours}
                    onInput={(e) => setRoutineTriggerHours((e.target as HTMLInputElement).value)}
                    class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 font-mono text-pine-text focus:border-pine-iris focus:outline-hidden"
                  />
                  <span class="font-medium text-pine-subtle">hours</span>
                </div>
              </div>
              <div>
                <label class="mb-1 block font-medium text-pine-subtle">Min Headroom Floor</label>
                <div class="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={1}
                    max={90}
                    value={routineMinHeadroom}
                    onInput={(e) => setRoutineMinHeadroom((e.target as HTMLInputElement).value)}
                    class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 font-mono text-pine-text focus:border-pine-iris focus:outline-hidden"
                  />
                  <span class="font-medium text-pine-subtle">%</span>
                </div>
              </div>
            </div>
            <div>
              <label class="mb-1 block font-medium text-pine-subtle">
                Verify Command (optional)
              </label>
              <input
                type="text"
                value={routineVerifyCommand}
                onInput={(e) => setRoutineVerifyCommand((e.target as HTMLInputElement).value)}
                placeholder="npm test"
                class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 font-mono text-pine-text focus:border-pine-iris focus:outline-hidden"
              />
            </div>
            <div>
              <label class="mb-1 block font-medium text-pine-subtle">
                PR Policy Override (optional)
              </label>
              <select
                value={routinePrPolicy}
                onChange={(e) =>
                  setRoutinePrPolicy((e.target as HTMLSelectElement).value as PrPolicy | '')
                }
                class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-pine-text focus:border-pine-iris focus:outline-hidden"
              >
                <option value="">Inherit global policy</option>
                <option value="docs_only">Documentation only (*.md, docs/)</option>
                <option value="all">All files (Allow code & doc PRs)</option>
                <option value="none">None (Disable PRs & branch pushes)</option>
              </select>
            </div>
            <div>
              <label class="mb-1 block font-medium text-pine-subtle">Prompt Template</label>
              <textarea
                required
                rows={4}
                value={routinePrompt}
                onInput={(e) => setRoutinePrompt((e.target as HTMLTextAreaElement).value)}
                placeholder="Audit the codebase for errors, format reproduction tests, and submit a PR..."
                class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 font-mono text-pine-text focus:border-pine-iris focus:outline-hidden"
              />
            </div>
            <div class="mt-2 flex items-center justify-end gap-2 border-t border-pine-highlight pt-3">
              <button
                type="button"
                onClick={() => setShowCreateRoutine(false)}
                class="cursor-pointer rounded-lg border border-pine-highlight px-3.5 py-1.5 font-medium text-pine-subtle hover:bg-pine-overlay"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="cursor-pointer rounded-lg bg-pine-iris px-4 py-1.5 font-bold text-pine-base shadow-xs hover:opacity-90"
              >
                {editingRoutineId ? 'Save Changes' : 'Create Routine'}
              </button>
            </div>
          </form>
        </dialog>
      )}
    </div>
  );
};
