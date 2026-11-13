import type { ConfigData } from '../../types';
import { SettingsForm } from '../../components/SettingsForm';
import { SettingsLayout } from '../../components/SettingsLayout';
import { NETWORK_SECURITY_FIELDS, TELEMETRY_OVERRIDE_FIELDS } from '../../config/fields';

interface AdvancedViewProps {
  config: ConfigData;
  onChanged: () => void;
}

export const AdvancedView = ({ config, onChanged }: AdvancedViewProps) => (
  <SettingsLayout>
    <SettingsForm
      title="Network &amp; Access Control"
      description="Restrict which clients may reach this instance and how client IPs are resolved behind reverse proxies."
      fields={NETWORK_SECURITY_FIELDS}
      config={config}
      onSaved={onChanged}
    />

    <SettingsForm
      title="Language Server Telemetry"
      description="Point the sentry at a custom Antigravity Language Server Connect-RPC endpoint."
      fields={TELEMETRY_OVERRIDE_FIELDS}
      config={config}
      onSaved={onChanged}
    />
  </SettingsLayout>
);
