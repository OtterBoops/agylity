import type { ConfigData } from '../../types';
import { SettingsForm } from '../../components/SettingsForm';
import { SettingsLayout } from '../../components/SettingsLayout';
import { SENTRY_FIELDS } from '../../config/fields';

interface AdvancedViewProps {
  config: ConfigData;
  onChanged: () => void;
}

export const AdvancedView = ({ config, onChanged }: AdvancedViewProps) => (
  <SettingsLayout>
    <SettingsForm
      title="Sentry &amp; Quota Safeguards"
      description="Fine-tune quota polling frequency, milestone warnings, Language Server Connect-RPC, and overcharge safety floor."
      fields={SENTRY_FIELDS}
      config={config}
      onSaved={onChanged}
    />
  </SettingsLayout>
);
