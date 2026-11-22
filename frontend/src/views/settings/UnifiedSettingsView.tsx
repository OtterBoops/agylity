import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ConfigData } from '../../types';
import type { FieldDef } from '../../components/SettingsForm';
import { UnsavedBar } from '../../components/settings/UnsavedBar';
import {
  COORDINATOR_FIELDS,
  NETWORK_SECURITY_FIELDS,
  SENTRY_GENERAL_FIELDS,
  TELEMETRY_OVERRIDE_FIELDS,
} from '../../config/fields';
import {
  SETTINGS_SECTIONS,
  loadedSettingsSection,
  readSettingsSection,
  type SettingsSectionId,
} from '../../utils/settingsHash';
import { AdvancedView } from './AdvancedView';
import { CoordinatorView } from './CoordinatorView';
import { GeneralView } from './GeneralView';
import { NotificationsView } from '../NotificationsView';

interface UnifiedSettingsViewProps {
  config: ConfigData;
  onChanged: () => void;
  path?: string;
}

const fieldTerms = (fields: FieldDef[]): string[] =>
  fields.flatMap((field) => [
    field.label,
    field.key,
    field.hint ?? '',
    field.placeholder ?? '',
    ...(field.options ?? []).map((option) => option.label),
  ]);

const matchAll = (haystack: string, query: string): boolean => {
  const hay = haystack.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
};

interface SectionIndex {
  header: string;
  rows: string;
}

const SECTIONS: Record<SettingsSectionId, SectionIndex> = {
  general: {
    header: 'General instance base url public origin task coordinator sentry mode',
    rows: [
      ...fieldTerms(SENTRY_GENERAL_FIELDS),
      'Instance Base URL public origin required',
      'Task Coordinator enable disable swarm pull runners',
    ].join(' '),
  },
  coordinator: {
    header: 'Coordinator task coordinator swarm runners dispatch',
    rows: [
      ...fieldTerms(COORDINATOR_FIELDS),
      'Task Coordinator Swarm Runners register registration token revoke',
      'Pool Policies',
      'Repositories repository git clone url default branch local path RepoEditor',
    ].join(' '),
  },
  notifications: {
    header: 'Notifications alert destinations channels delivery',
    rows: 'Discord Bot Generic Webhook hmac signature alerts muted test delivery',
  },
  advanced: {
    header: 'Advanced network access control telemetry language server',
    rows: [...fieldTerms(NETWORK_SECURITY_FIELDS), ...fieldTerms(TELEMETRY_OVERRIDE_FIELDS)].join(
      ' '
    ),
  },
};

const SECTION_ORDER: SettingsSectionId[] = SETTINGS_SECTIONS.map((section) => section.id);

export const UnifiedSettingsView = ({ config, onChanged }: UnifiedSettingsViewProps) => {
  const [query, setQuery] = useState('');
  const [activeSection, setActiveSection] = useState<SettingsSectionId | null>(
    () => readSettingsSection() ?? loadedSettingsSection()
  );

  useEffect(() => {
    const sync = () => setActiveSection(readSettingsSection());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const rawQuery = query.trim();
  const searching = rawQuery !== '';
  const current = activeSection ?? 'general';

  const scope = useMemo(() => {
    const result: Partial<Record<SettingsSectionId, { visible: boolean; rowQuery?: string }>> = {};
    for (const id of SECTION_ORDER) {
      const index = SECTIONS[id];
      if (!searching) {
        result[id] = { visible: true };
        continue;
      }
      const headerHit = matchAll(index.header, rawQuery);
      const rowsHit = matchAll(index.rows, rawQuery);
      result[id] = {
        visible: headerHit || rowsHit,
        rowQuery: rowsHit ? rawQuery : undefined,
      };
    }
    return result;
  }, [rawQuery, searching]);

  const rendered: SettingsSectionId[] = searching
    ? SECTION_ORDER.filter((id) => scope[id]?.visible)
    : [current];

  return (
    <div class="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <div class="rounded-xl border border-pine-highlight bg-pine-surface px-3 py-2.5 sm:px-4">
        <div class="relative ml-auto flex min-w-0 flex-1 items-center gap-2 sm:max-w-xs">
          <label class="sr-only" for="settings-search">
            Search all settings
          </label>
          <input
            id="settings-search"
            type="search"
            autoComplete="off"
            spellcheck={false}
            placeholder="Search all settings…"
            value={query}
            onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setQuery('');
              }
            }}
            class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text placeholder-pine-subtle transition-colors outline-none focus:border-pine-iris"
          />
          {query !== '' && (
            <button
              type="button"
              onClick={() => setQuery('')}
              class="shrink-0 cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-2.5 py-1.5 text-xs font-medium text-pine-subtle transition-colors hover:text-pine-text"
            >
              Clear
            </button>
          )}
        </div>
        {searching && (
          <p class="mt-2 text-xs text-pine-subtle">
            {rendered.length} of {SECTION_ORDER.length} sections match “{rawQuery}”. Esc clears the
            search.
          </p>
        )}
      </div>

      <UnsavedBar />

      {searching && rendered.length === 0 && (
        <p class="rounded-xl border border-pine-highlight bg-pine-surface p-6 text-sm text-pine-subtle">
          No settings match “{rawQuery}”.
        </p>
      )}

      {rendered.map((id) => (
        <section
          key={id}
          id={id}
          role="tabpanel"
          aria-labelledby={`settings-tab-${id}`}
          class="flex flex-col gap-4"
        >
          {searching && (
            <h2 class="text-lg font-semibold text-pine-text">
              {SETTINGS_SECTIONS.find((section) => section.id === id)?.label}
            </h2>
          )}
          {id === 'general' && (
            <GeneralView
              config={config}
              onChanged={onChanged}
              searchQuery={scope.general?.rowQuery}
            />
          )}
          {id === 'coordinator' && (
            <CoordinatorView
              config={config}
              onChanged={onChanged}
              searchQuery={scope.coordinator?.rowQuery}
            />
          )}
          {id === 'notifications' && <NotificationsView config={config} onSaved={onChanged} />}
          {id === 'advanced' && (
            <AdvancedView
              config={config}
              onChanged={onChanged}
              searchQuery={scope.advanced?.rowQuery}
            />
          )}
        </section>
      ))}
    </div>
  );
};
