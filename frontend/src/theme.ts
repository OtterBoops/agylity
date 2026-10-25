import {
  faCircleHalfStroke,
  faDesktop,
  faMoon,
  faSun,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons';

export type ThemeChoice = 'dawn' | 'regular' | 'moon' | 'system';

export interface ThemeOption {
  id: ThemeChoice;
  label: string;
  title: string;
  icon: IconDefinition;
}

export const THEME_OPTIONS: ThemeOption[] = [
  { id: 'dawn', label: 'Dawn', title: 'Dawn (Rosé Pine light theme)', icon: faSun },
  {
    id: 'regular',
    label: 'Regular',
    title: 'Rosé Pine (Regular dark palette)',
    icon: faCircleHalfStroke,
  },
  { id: 'moon', label: 'Moon', title: 'Rosé Pine Moon (Deep dark palette)', icon: faMoon },
  { id: 'system', label: 'System', title: 'System preference (defaults to Moon)', icon: faDesktop },
];

export const resolveEffectiveTheme = (
  choice: ThemeChoice
): 'rose-pine-dawn' | 'rose-pine' | 'rose-pine-moon' => {
  if (choice === 'dawn') return 'rose-pine-dawn';
  if (choice === 'regular') return 'rose-pine';
  if (choice === 'moon') return 'rose-pine-moon';

  // System mode: inspect prefers-color-scheme, default to moon
  if (typeof window !== 'undefined' && window.matchMedia) {
    if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'rose-pine-dawn';
    }
  }
  return 'rose-pine-moon';
};

export const normalizeStoredTheme = (raw: string | null): ThemeChoice => {
  if (!raw) return 'system';
  if (raw === 'dawn' || raw === 'rose-pine-dawn') return 'dawn';
  if (raw === 'regular' || raw === 'rose-pine') return 'regular';
  if (raw === 'moon' || raw === 'rose-pine-moon') return 'moon';
  if (raw === 'system') return 'system';
  return 'system';
};

export const getThemeDisplayLabel = (choice: ThemeChoice): string => {
  if (choice === 'system') {
    const isLight =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches;
    return `System (${isLight ? 'Dawn' : 'Moon'})`;
  }
  if (choice === 'dawn') return 'Dawn';
  if (choice === 'regular') return 'Regular';
  if (choice === 'moon') return 'Moon';
  return choice;
};
