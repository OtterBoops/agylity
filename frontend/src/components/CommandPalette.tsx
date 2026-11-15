import { useEffect, useRef, useState } from 'preact/hooks';
import { route } from 'preact-router';
import { getBacklogTasks, getRoutines, getTasks } from '../api';
import type { BacklogTaskRecord, RoutineTaskRecord, SwarmTask } from '../types';
import { dialogBackdropClickHandler } from '../utils/dialog';
import {
  faBell,
  faChartPie,
  faCheckToSlot,
  faCodeBranch,
  faNetworkWired,
  faPlus,
  faRotate,
  faSearch,
  faSliders,
  faTerminal,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import { Icon } from './Icon';
import { isActiveTaskStatus } from './tasks/badges';

type CommandCategory = 'Navigation' | 'Action' | 'Tasks & Routines';

interface CommandItem {
  id: string;
  title: string;
  category: CommandCategory;
  shortcut?: string;
  icon: IconDefinition;
  action: () => void;
}

interface LiveTasks {
  routines: RoutineTaskRecord[];
  backlog: BacklogTaskRecord[];
  executions: SwarmTask[];
}

const NO_LIVE_TASKS: LiveTasks = { routines: [], backlog: [], executions: [] };

const LABEL_MAX = 72;

// Rows are labelled from human fields only: a raw UUID is unreadable in a scannable result list.
const taskLabel = (taskNumber: number | undefined, title?: string, prompt?: string): string => {
  const raw = title?.trim() || prompt?.trim() || 'Untitled task';
  const oneLine = raw.replace(/\s+/g, ' ');
  const clipped = oneLine.length > LABEL_MAX ? `${oneLine.slice(0, LABEL_MAX - 1)}...` : oneLine;
  return taskNumber ? `#${taskNumber} ${clipped}` : clipped;
};

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onOpenDispatch: () => void;
  coordinatorEnabled: boolean;
}

export const CommandPalette = ({
  isOpen,
  onClose,
  onRefresh,
  onOpenDispatch,
  coordinatorEnabled,
}: CommandPaletteProps) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [liveTasks, setLiveTasks] = useState<LiveTasks>(NO_LIVE_TASKS);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const liveRequested = useRef(false);

  const commands: CommandItem[] = [
    {
      id: 'nav-overview',
      title: 'Go to Overview & Quotas',
      category: 'Navigation',
      icon: faChartPie,
      action: () => {
        route('/overview');
        onClose();
      },
    },
    {
      id: 'nav-logs',
      title: 'Go to Live Logs',
      category: 'Navigation',
      icon: faTerminal,
      action: () => {
        route('/logs');
        onClose();
      },
    },
    {
      id: 'nav-settings-general',
      title: 'Go to General Settings',
      category: 'Navigation',
      icon: faSliders,
      action: () => {
        route('/settings/general');
        onClose();
      },
    },
    {
      id: 'nav-schedules',
      title: 'Go to Schedules & Queue',
      category: 'Navigation',
      icon: faCheckToSlot,
      action: () => {
        route('/tasks?tab=schedules');
        onClose();
      },
    },
    {
      id: 'nav-executions',
      title: 'Go to Execution History',
      category: 'Navigation',
      icon: faTerminal,
      action: () => {
        route('/tasks?tab=executions');
        onClose();
      },
    },
    {
      id: 'nav-notifications',
      title: 'Configure Notifications & Discord',
      category: 'Navigation',
      icon: faBell,
      action: () => {
        route('/settings/notifications');
        onClose();
      },
    },
    {
      id: 'nav-coordinator',
      title: 'Configure Task Coordinator',
      category: 'Navigation',
      icon: faNetworkWired,
      action: () => {
        route('/settings/coordinator');
        onClose();
      },
    },
    ...(coordinatorEnabled
      ? [
          {
            id: 'nav-tasks',
            title: 'Go to Tasks Queue & Runner Jobs',
            category: 'Navigation' as const,
            icon: faCheckToSlot,
            action: () => {
              route('/tasks');
              onClose();
            },
          },
          {
            id: 'nav-repositories',
            title: 'Configure Target Repositories',
            category: 'Navigation' as const,
            icon: faCodeBranch,
            action: () => {
              route('/settings/repositories');
              onClose();
            },
          },
        ]
      : []),
    {
      id: 'act-new-task',
      title: 'Create New Task...',
      category: 'Action',
      shortcut: 'Alt D',
      icon: faPlus,
      action: () => {
        onClose();
        onOpenDispatch();
      },
    },
    {
      id: 'nav-advanced',
      title: 'Advanced Daemon Settings',
      category: 'Navigation',
      icon: faSliders,
      action: () => {
        route('/settings/advanced');
        onClose();
      },
    },
    {
      id: 'act-refresh',
      title: 'Refresh Quotas & Sentry Probe Now',
      category: 'Action',
      shortcut: 'R',
      icon: faRotate,
      action: () => {
        onClose();
        onRefresh();
      },
    },
  ];

  const liveCommands: CommandItem[] = [
    ...liveTasks.routines.map((routine) => ({
      id: `routine-${routine.id}`,
      title: taskLabel(routine.taskNumber, routine.title, routine.prompt),
      category: 'Tasks & Routines' as const,
      icon: faCheckToSlot,
      action: () => {
        route(`/tasks?tab=schedules&id=${encodeURIComponent(routine.id)}`);
        onClose();
      },
    })),
    ...liveTasks.backlog.map((item) => ({
      id: `backlog-${item.id}`,
      title: taskLabel(item.taskNumber, item.title, item.prompt),
      category: 'Tasks & Routines' as const,
      icon: faCheckToSlot,
      action: () => {
        route(`/tasks?tab=schedules&id=${encodeURIComponent(item.id)}`);
        onClose();
      },
    })),
    ...liveTasks.executions.map((task) => ({
      id: `execution-${task.id}`,
      title: taskLabel(task.taskNumber, task.title, task.prompt),
      category: 'Tasks & Routines' as const,
      icon: faTerminal,
      action: () => {
        const tab = isActiveTaskStatus(task.status) ? 'schedules' : 'executions';
        route(`/tasks?tab=${tab}&id=${encodeURIComponent(task.id)}`);
        onClose();
      },
    })),
  ];

  const allCommands = [...commands, ...liveCommands];

  const q = query.trim().toLowerCase();
  const filtered = allCommands.filter(
    (c) => !q || c.title.toLowerCase().includes(q) || c.category.toLowerCase().includes(q)
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen) {
      if (!dialog.open) dialog.showModal();
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      if (dialog.open) dialog.close();
    }
  }, [isOpen]);

  // One fetch per open: refetching as the user types would hammer the control plane per keystroke.
  useEffect(() => {
    if (!isOpen || !coordinatorEnabled) {
      liveRequested.current = false;
      setLiveTasks(NO_LIVE_TASKS);
      return;
    }
    if (liveRequested.current) return;
    liveRequested.current = true;
    let cancelled = false;
    Promise.all([getTasks(20), getRoutines(), getBacklogTasks()])
      .then(([executions, routines, backlog]) => {
        if (cancelled) return;
        setLiveTasks({ executions, routines, backlog });
      })
      .catch(() => {
        // Offline control plane: static commands must still work, so failures are swallowed.
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, coordinatorEnabled]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Live results land while the list is open; a stale index would make Enter a no-op.
  useEffect(() => {
    setSelectedIndex((prev) => (prev < filtered.length ? prev : 0));
  }, [filtered.length]);

  useEffect(() => {
    if (!isOpen) return;
    const onWindowKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % Math.max(1, filtered.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filtered.length) % Math.max(1, filtered.length));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          filtered[selectedIndex]!.action();
        }
      }
    };
    window.addEventListener('keydown', onWindowKey);
    return () => window.removeEventListener('keydown', onWindowKey);
  }, [isOpen, filtered, selectedIndex]);

  if (!isOpen) return null;

  const handleDialogClick = dialogBackdropClickHandler(dialogRef, onClose);

  return (
    <dialog
      id="command-palette-dialog"
      aria-label="Command palette"
      aria-modal="true"
      ref={dialogRef}
      onClose={onClose}
      onCancel={onClose}
      onClick={handleDialogClick}
      class="fixed inset-0 m-auto mt-20 flex w-full max-w-xl flex-col overflow-hidden rounded-xl border border-pine-highlight bg-pine-surface p-0 text-pine-text shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-xs"
    >
      {/* Search Input Bar */}
      <div class="flex items-center gap-3 border-b border-pine-highlight px-4 py-3">
        <Icon icon={faSearch} class="size-4 text-pine-muted" />
        <input
          ref={inputRef}
          type="text"
          aria-label="Search commands or navigate views"
          autoComplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          class="flex-1 bg-transparent text-sm text-pine-text outline-none placeholder:text-pine-subtle"
          placeholder="Type a command or navigate views..."
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        <kbd class="rounded-sm border border-pine-highlight bg-pine-overlay px-1.5 py-0.5 font-mono text-xs text-pine-muted">
          Esc
        </kbd>
      </div>

      {/* Command list */}
      <div class="max-h-80 overflow-y-auto p-2">
        {filtered.length === 0 ? (
          <div class="px-4 py-8 text-center text-xs text-pine-muted">
            No commands matching &quot;{query}&quot;
          </div>
        ) : (
          filtered.map((cmd, idx) => {
            const isSelected = idx === selectedIndex;
            return (
              <button
                key={cmd.id}
                type="button"
                onClick={() => cmd.action()}
                onMouseEnter={() => setSelectedIndex(idx)}
                class={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                  isSelected
                    ? 'bg-pine-iris/15 font-medium text-pine-iris'
                    : 'text-pine-text hover:bg-pine-overlay'
                }`}
              >
                <div class="flex min-w-0 items-center gap-3">
                  <div
                    class={`flex size-6 shrink-0 items-center justify-center rounded-md border ${
                      isSelected
                        ? 'border-pine-iris/40 bg-pine-iris/20 text-pine-iris'
                        : 'border-pine-highlight bg-pine-overlay text-pine-muted'
                    }`}
                  >
                    <Icon icon={cmd.icon} class="size-3" />
                  </div>
                  <span class="truncate">{cmd.title}</span>
                </div>

                <div class="flex shrink-0 items-center gap-2">
                  <span class="rounded-sm bg-pine-overlay/60 px-1.5 py-0.5 text-xs whitespace-nowrap text-pine-muted">
                    {cmd.category}
                  </span>
                  {cmd.shortcut && (
                    <kbd class="rounded-sm border border-pine-highlight bg-pine-overlay px-1.5 py-0.5 font-mono text-xs text-pine-muted">
                      {cmd.shortcut}
                    </kbd>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Footer shortcuts hint */}
      <div class="flex items-center justify-between border-t border-pine-highlight bg-pine-overlay/30 px-3 py-2 text-xs text-pine-muted">
        <div class="flex items-center gap-3">
          <span>
            <kbd class="font-mono text-xs text-pine-subtle">↑↓</kbd> navigate
          </span>
          <span>
            <kbd class="font-mono text-xs text-pine-subtle">Enter</kbd> select
          </span>
          <span>
            <kbd class="font-mono text-xs text-pine-subtle">Esc</kbd> close
          </span>
        </div>
        <span>Agylity Command Palette</span>
      </div>
    </dialog>
  );
};
