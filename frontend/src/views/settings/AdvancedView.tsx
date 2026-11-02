import type { ConfigData } from '../../types';
import { GeneralSettingsCard } from '../../components/GeneralSettingsCard';
import { PoolPoliciesCard } from '../../components/PoolPoliciesCard';
import { SettingsForm } from '../../components/SettingsForm';
import { SENTRY_FIELDS } from '../../config/fields';

interface AdvancedViewProps {
  config: ConfigData;
  onChanged: () => void;
}

export const AdvancedView = ({ config, onChanged }: AdvancedViewProps) => (
  <div class="flex flex-col gap-6">
    <GeneralSettingsCard />
    <PoolPoliciesCard config={config} onSaved={onChanged} />
    <SettingsForm
      title="Sentry &amp; Quota Safeguards"
      description="Fine-tune quota polling frequency, milestone warnings, Language Server Connect-RPC, and overcharge safety floor."
      fields={SENTRY_FIELDS}
      config={config}
      onSaved={onChanged}
    />
  </div>
);
