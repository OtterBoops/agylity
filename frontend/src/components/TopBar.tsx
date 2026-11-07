import { useState, useRef, useEffect } from 'preact/hooks';
import {
  faCheck,
  faChevronDown,
  faCoins,
  faKey,
  faRotate,
  faSearch,
} from '@fortawesome/free-solid-svg-icons';
import { Icon } from './Icon';
import { type ThemeChoice, THEME_OPTIONS, getThemeDisplayLabel } from '../theme';

interface TopBarProps {
  title: string;
  subtitle?: string;
  isRefreshing: boolean;
  refreshCooldown: number;
  coordinatorEnabled?: boolean;
  remainingCredits?: number | null;
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
  onRefresh: () => void;
  onOpenCommandPalette?: () => void;
  onOpenAuthModal?: () => void;
}

export const TopBar = ({
  title,
  subtitle,
  isRefreshing,
  refreshCooldown,
  remainingCredits,
  theme,
  onThemeChange,
  onRefresh,
  onOpenCommandPalette,
  onOpenAuthModal,
}: TopBarProps) => {
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeDropdownRef = useRef<HTMLDivElement>(null);

  const activeThemeOption = THEME_OPTIONS.find((opt) => opt.id === theme) || THEME_OPTIONS[3];

  useEffect(() => {
    if (!themeMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (themeDropdownRef.current && !themeDropdownRef.current.contains(e.target as Node)) {
        setThemeMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [themeMenuOpen]);

  return (
    <header class="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-pine-highlight pb-4 sm:mb-6 sm:gap-4">
      <div>
        <h1 class="text-xl font-bold tracking-tight text-pine-text sm:text-2xl">{title}</h1>
        {subtitle && <p class="mt-0.5 text-xs text-pine-subtle sm:text-sm">{subtitle}</p>}
      </div>

      <div class="flex items-center gap-2 sm:gap-3">
        {typeof remainingCredits === 'number' && (
          <div
            class="inline-flex items-center gap-1.5 rounded-lg border border-pine-highlight bg-pine-surface px-2.5 py-1.5 text-xs font-semibold text-pine-text shadow-xs sm:px-3 sm:text-sm"
            title="Available Google AI Credits / Flex Tokens"
          >
            <Icon icon={faCoins} class="size-3 text-pine-iris sm:size-3.5" />
            <span class="font-mono text-pine-iris">{remainingCredits}</span>
            <span class="text-[11px] text-pine-subtle sm:text-xs">Credits</span>
          </div>
        )}

        {onOpenCommandPalette && (
          <button
            type="button"
            onClick={onOpenCommandPalette}
            class="hidden cursor-pointer items-center gap-2 rounded-lg border border-pine-highlight bg-pine-surface px-2.5 py-1.5 text-xs text-pine-subtle transition-colors hover:border-pine-iris hover:text-pine-text sm:inline-flex sm:text-sm"
            title="Search commands and navigate views (Ctrl+K)"
          >
            <Icon icon={faSearch} class="size-3 text-pine-muted sm:size-3.5" />
            <span>Search</span>
            <kbd class="rounded-sm border border-pine-highlight bg-pine-overlay px-1.5 py-0.5 font-mono text-xs text-pine-muted">
              Ctrl K
            </kbd>
          </button>
        )}

        {/* Theme Selector Popover */}
        <div class="relative" ref={themeDropdownRef}>
          <button
            type="button"
            onClick={() => setThemeMenuOpen(!themeMenuOpen)}
            class="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-pine-highlight bg-pine-surface px-3 py-1.5 text-xs font-medium text-pine-text transition-colors hover:bg-pine-overlay sm:text-sm"
            aria-label="Select color theme"
            aria-haspopup="true"
            aria-expanded={themeMenuOpen}
            title={`Theme: ${getThemeDisplayLabel(theme)}`}
          >
            <Icon icon={activeThemeOption.icon} class="size-3.5 text-pine-iris" />
            <span class="hidden sm:inline">{activeThemeOption.label}</span>
            <Icon
              icon={faChevronDown}
              class={`size-2.5 text-pine-muted transition-transform duration-150 ${themeMenuOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {themeMenuOpen && (
            <div
              role="menu"
              class="absolute right-0 z-50 mt-1.5 w-44 rounded-xl border border-pine-highlight bg-pine-surface p-1 shadow-lg backdrop-blur-md"
            >
              <div class="px-2 py-1 text-xs font-bold tracking-wider text-pine-muted uppercase">
                Theme
              </div>
              {THEME_OPTIONS.map((opt) => {
                const isSelected = theme === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onThemeChange(opt.id);
                      setThemeMenuOpen(false);
                    }}
                    class={`flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors sm:text-sm ${
                      isSelected
                        ? 'bg-pine-iris/15 font-semibold text-pine-iris'
                        : 'text-pine-subtle hover:bg-pine-overlay hover:text-pine-text'
                    }`}
                  >
                    <div class="flex items-center gap-2">
                      <Icon icon={opt.icon} class="size-3.5" />
                      <span>{opt.label}</span>
                    </div>
                    {isSelected && <Icon icon={faCheck} class="size-3 text-pine-iris" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button
          type="button"
          class="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-pine-highlight bg-pine-surface px-2.5 py-1.5 text-xs font-medium text-pine-text transition-colors hover:bg-pine-overlay sm:text-sm"
          onClick={onOpenAuthModal}
          title="Configure Control-Plane Auth Token"
        >
          <Icon icon={faKey} class="size-3.5 text-pine-iris" />
        </button>

        <button
          type="button"
          class="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-pine-highlight bg-pine-surface px-3 py-1.5 text-xs font-medium text-pine-text transition-colors hover:bg-pine-overlay disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm"
          onClick={onRefresh}
          disabled={refreshCooldown > 0 || isRefreshing}
          title="Poll latest quota snapshots"
        >
          <Icon icon={faRotate} class={`size-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>
    </header>
  );
};
