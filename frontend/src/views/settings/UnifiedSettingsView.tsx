import { useEffect, useState } from 'preact/hooks';
import type { ConfigData } from '../../types';
import { UnsavedBar } from '../../components/settings/UnsavedBar';
import { readSettingsSection, type SettingsSectionId } from '../../utils/settingsHash';
import { AdvancedView } from './AdvancedView';
import { CoordinatorView } from './CoordinatorView';
import { GeneralView } from './GeneralView';
import { NotificationsView } from '../NotificationsView';

interface UnifiedSettingsViewProps {
  config: ConfigData;
  onChanged: () => void;
  path?: string;
}

export const UnifiedSettingsView = ({ config, onChanged }: UnifiedSettingsViewProps) => {
  const [activeSection, setActiveSection] = useState<SettingsSectionId | null>(() =>
    readSettingsSection()
  );

  useEffect(() => {
    const sync = () => setActiveSection(readSettingsSection());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const current = activeSection ?? 'general';

  return (
    <div class="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <UnsavedBar />

      <section id={current} class="flex flex-col gap-4">
        {current === 'general' && <GeneralView config={config} onChanged={onChanged} />}
        {current === 'coordinator' && <CoordinatorView config={config} onChanged={onChanged} />}
        {current === 'notifications' && <NotificationsView config={config} onSaved={onChanged} />}
        {current === 'advanced' && <AdvancedView config={config} onChanged={onChanged} />}
      </section>
    </div>
  );
};
