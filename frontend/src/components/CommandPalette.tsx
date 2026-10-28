import { useEffect, useRef, useState } from 'preact/hooks';
import {
  faBell,
  faBolt,
  faChartPie,
  faCodeBranch,
  faMoon,
  faNetworkWired,
  faRotate,
  faSearch,
  faSliders,
  faTerminal,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import type { Route } from '../router';
import { Icon } from './Icon';

interface CommandItem {
  id: string;
  title: string;
  category: 'Navigation' | 'Action' | 'Theme';
  shortcut?: string;
  icon: IconDefinition;
  action: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (route: Route) => void;
  onRefresh: () => void;
  onOpenDispatch: () => void;
  onToggleTheme: () => void;
  orchestratorEnabled: boolean;
}

export const CommandPalette = ({
  isOpen,
  onClose,
  onNavigate,
  onRefresh,
  onOpenDispatch,
  onToggleTheme,
  orchestratorEnabled,
}: CommandPaletteProps) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands: CommandItem[] = [
    {
      id: 'nav-overview',
      title: 'Go to Overview & Quotas',
      category: 'Navigation',
      icon: faChartPie,
      action: () => {
        onNavigate('overview');
        onClose();
      },
    },
    {
      id: 'nav-logs',
      title: 'Go to Live Logs',
      category: 'Navigation',
      icon: faTerminal,
      action: () => {
        onNavigate('logs');
        onClose();
      },
    },
    {
      id: 'nav-notifications',
      title: 'Configure Notifications & Discord',
      category: 'Navigation',
      icon: faBell,
      action: () => {
        onNavigate('settings/notifications');
        onClose();
      },
    },
    {
      id: 'nav-orchestrator',
      title: 'Configure Task Orchestrator',
      category: 'Navigation',
      icon: faNetworkWired,
      action: () => {
        onNavigate('settings/remote');
        onClose();
      },
    },
    ...(orchestratorEnabled
      ? [
          {
            id: 'nav-repositories',
            title: 'Configure Target Repositories',
            category: 'Navigation' as const,
            icon: faCodeBranch,
            action: () => {
              onNavigate('settings/repositories');
              onClose();
            },
          },
        ]
      : []),
    {
      id: 'nav-advanced',
      title: 'Advanced Daemon Settings',
      category: 'Navigation',
      icon: faSliders,
      action: () => {
        onNavigate('settings/advanced');
        onClose();
      },
    },
    {
      id: 'act-dispatch',
      title: 'Dispatch New Autonomous Task...',
      category: 'Action',
      shortcut: 'Alt D',
      icon: faBolt,
      action: () => {
        onClose();
        onOpenDispatch();
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
    {
      id: 'act-theme',
      title: 'Cycle Color Theme',
      category: 'Theme',
      icon: faMoon,
      action: () => {
        onToggleTheme();
        onClose();
      },
    },
  ];

  const q = query.trim().toLowerCase();
  const filtered = commands.filter(
    (c) => !q || c.title.toLowerCase().includes(q) || c.category.toLowerCase().includes(q)
  );

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;
    const onWindowKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
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
  }, [isOpen, filtered, selectedIndex, onClose]);

  if (!isOpen) return null;

  return (
    <div
      class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-20 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        class="animate-in fade-in zoom-in-95 flex w-full max-w-xl flex-col overflow-hidden rounded-xl border border-pine-highlight bg-pine-surface shadow-2xl duration-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Input Bar */}
        <div class="flex items-center gap-3 border-b border-pine-highlight px-4 py-3">
          <Icon icon={faSearch} class="size-4 text-pine-muted" />
          <input
            ref={inputRef}
            type="text"
            class="flex-1 bg-transparent text-sm text-pine-text outline-none placeholder:text-pine-muted"
            placeholder="Type a command or navigate views..."
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
          <kbd class="rounded border border-pine-highlight bg-pine-overlay px-1.5 py-0.5 font-mono text-[10px] text-pine-muted">
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
                  class={`flex w-full cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                    isSelected
                      ? 'bg-pine-iris/15 font-medium text-pine-iris'
                      : 'text-pine-text hover:bg-pine-overlay'
                  }`}
                >
                  <div class="flex items-center gap-3">
                    <div
                      class={`flex size-6 items-center justify-center rounded-md border ${
                        isSelected
                          ? 'border-pine-iris/40 bg-pine-iris/20 text-pine-iris'
                          : 'border-pine-highlight bg-pine-overlay text-pine-muted'
                      }`}
                    >
                      <Icon icon={cmd.icon} class="size-3" />
                    </div>
                    <span>{cmd.title}</span>
                  </div>

                  <div class="flex items-center gap-2">
                    <span class="rounded bg-pine-overlay/60 px-1.5 py-0.5 text-[10px] text-pine-muted">
                      {cmd.category}
                    </span>
                    {cmd.shortcut && (
                      <kbd class="rounded border border-pine-highlight bg-pine-overlay px-1.5 py-0.5 font-mono text-[10px] text-pine-muted">
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
        <div class="flex items-center justify-between border-t border-pine-highlight bg-pine-overlay/30 px-3 py-2 text-[11px] text-pine-muted">
          <div class="flex items-center gap-3">
            <span>
              <kbd class="font-mono text-[10px] text-pine-subtle">↑↓</kbd> navigate
            </span>
            <span>
              <kbd class="font-mono text-[10px] text-pine-subtle">Enter</kbd> select
            </span>
            <span>
              <kbd class="font-mono text-[10px] text-pine-subtle">Esc</kbd> close
            </span>
          </div>
          <span>Agylity Command Palette</span>
        </div>
      </div>
    </div>
  );
};
