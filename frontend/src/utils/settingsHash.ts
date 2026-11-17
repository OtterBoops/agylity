import { route } from 'preact-router';

export const SETTINGS_SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'coordinator', label: 'Coordinator' },
  { id: 'repositories', label: 'Repositories' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'advanced', label: 'Advanced' },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

export const readSettingsSection = (): SettingsSectionId | null => {
  const raw = (typeof window === 'undefined' ? '' : window.location.hash).replace(/^#/, '');
  return SETTINGS_SECTIONS.some((section) => section.id === raw)
    ? (raw as SettingsSectionId)
    : null;
};

export const settingsSectionLabel = (id: SettingsSectionId | null): string | null =>
  SETTINGS_SECTIONS.find((section) => section.id === id)?.label ?? null;

export const navigateToSection = (id: SettingsSectionId): void => {
  const next = `/settings#${id}`;
  if (window.location.pathname !== '/settings') {
    route(next);
    if (window.location.hash !== `#${id}`) {
      window.history.replaceState(null, '', next);
    }
  } else if (window.location.hash !== `#${id}`) {
    window.history.pushState(null, '', next);
  }
  window.dispatchEvent(new HashChangeEvent('hashchange'));
};

// Captured at import so the section you landed on survives later hash changes.
const loadedSection: SettingsSectionId | null =
  typeof window === 'undefined' ? null : readSettingsSection();

export const loadedSettingsSection = (): SettingsSectionId | null => loadedSection;
