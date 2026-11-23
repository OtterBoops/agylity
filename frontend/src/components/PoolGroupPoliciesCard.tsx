import { useState } from 'preact/hooks';
import { faSliders } from '@fortawesome/free-solid-svg-icons';
import type { ConfigData } from '../types';
import { updateConfig } from '../api';
import { pushErrorToast } from '../state/toastStore';
import { POOL_GROUP_LABELS, type PoolGroup } from '../../../src/shared/models.ts';
import { Icon } from './Icon';
import { ToggleSwitch } from './ToggleSwitch';

interface PoolGroupPoliciesCardProps {
  config: ConfigData;
  onSaved: () => void;
}

interface PoolPolicy {
  alertsEnabled: boolean;
  dispatchEnabled: boolean;
}

interface PoolDef {
  key: PoolGroup;
  name: string;
  description: string;
}

const POOLS: PoolDef[] = [
  {
    key: 'gemini',
    name: POOL_GROUP_LABELS.gemini,
    description:
      'Gemini 4 Hydrogen, Neon, Carbon, Argon, 3.8 Flash and the orchestrator routes share one weekly and 5-hour budget.',
  },
  {
    key: 'claude',
    name: POOL_GROUP_LABELS.claude,
    description:
      'Third-party model bucket (Claude Sonnet/Opus, GPT-OSS). Disabled by default to prevent credit drain.',
  },
];

// Gemini ships on out of the box; the Claude bucket stays off so it cannot drain credits unattended.
const POLICY_DEFAULTS: Record<PoolGroup, PoolPolicy> = {
  gemini: { alertsEnabled: true, dispatchEnabled: true },
  claude: { alertsEnabled: false, dispatchEnabled: false },
};

const resolvePolicy = (raw: Partial<PoolPolicy> | undefined, defaults: PoolPolicy): PoolPolicy => ({
  alertsEnabled: raw?.alertsEnabled ?? defaults.alertsEnabled,
  dispatchEnabled: raw?.dispatchEnabled ?? defaults.dispatchEnabled,
});

export const PoolGroupPoliciesCard = ({ config, onSaved }: PoolGroupPoliciesCardProps) => {
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const rawPolicies = (config.resolved?.poolGroupPolicies || {}) as Partial<
    Record<PoolGroup, Partial<PoolPolicy>>
  >;
  const currentPolicies: Record<PoolGroup, PoolPolicy> = {
    gemini: resolvePolicy(rawPolicies.gemini, POLICY_DEFAULTS.gemini),
    claude: resolvePolicy(rawPolicies.claude, POLICY_DEFAULTS.claude),
  };

  const handleToggle = async (poolKey: PoolGroup, field: keyof PoolPolicy) => {
    const key = `${poolKey}:${field}`;
    setSavingKey(key);
    try {
      const updated = {
        ...currentPolicies,
        [poolKey]: {
          ...currentPolicies[poolKey],
          [field]: !currentPolicies[poolKey][field],
        },
      };
      await updateConfig({ poolGroupPolicies: updated });
      onSaved();
    } catch (err: any) {
      // The switch mirrors server state, so a failed write snaps back silently without this.
      pushErrorToast('Pool policy not saved', err?.message || 'Failed to update the pool policy');
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6">
      <div class="mb-5">
        <div class="mb-1 flex items-center gap-2">
          <Icon icon={faSliders} class="size-5 text-pine-iris" />
          <h3 class="text-lg font-semibold text-pine-text">Per-Pool Policy Toggles</h3>
        </div>
        <p class="text-xs text-pine-subtle">
          Granularly enable or disable quota threshold alerts and Swarm task dispatches for each
          model pool.
        </p>
      </div>

      <div class="divide-y divide-pine-highlight/40 border-t border-pine-highlight/40">
        {POOLS.map((pool) => {
          const policy = currentPolicies[pool.key];
          const isAlertsLoading = savingKey === `${pool.key}:alertsEnabled`;
          const isDispatchLoading = savingKey === `${pool.key}:dispatchEnabled`;

          return (
            <div
              key={pool.key}
              class="flex flex-col gap-3 py-4 first:pt-4 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
            >
              <div class="min-w-0 flex-1">
                <h4 class="text-sm font-semibold text-pine-text">{pool.name}</h4>
                <p class="mt-0.5 text-xs text-pine-subtle">{pool.description}</p>
              </div>

              <div class="flex flex-wrap items-center gap-6">
                <div class="flex items-center gap-2.5">
                  <span class="text-xs font-medium text-pine-subtle">Alerts</span>
                  <ToggleSwitch
                    size="sm"
                    checked={policy.alertsEnabled}
                    disabled={isAlertsLoading}
                    onChange={() => handleToggle(pool.key, 'alertsEnabled')}
                    label={policy.alertsEnabled ? 'Disable pool alerts' : 'Enable pool alerts'}
                  />
                </div>

                <div class="flex items-center gap-2.5">
                  <span class="text-xs font-medium text-pine-subtle">Swarm Dispatch</span>
                  <ToggleSwitch
                    size="sm"
                    activeClass="bg-pine-pine"
                    checked={policy.dispatchEnabled}
                    disabled={isDispatchLoading}
                    onChange={() => handleToggle(pool.key, 'dispatchEnabled')}
                    label={
                      policy.dispatchEnabled
                        ? 'Disable swarm dispatches'
                        : 'Enable swarm dispatches'
                    }
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
