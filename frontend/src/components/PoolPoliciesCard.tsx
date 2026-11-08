import { useState } from 'preact/hooks';
import { faSliders } from '@fortawesome/free-solid-svg-icons';
import type { ConfigData } from '../types';
import { updateConfig } from '../api';
import { Icon } from './Icon';
import { ToggleSwitch } from './ToggleSwitch';

interface PoolPoliciesCardProps {
  config: ConfigData;
  onSaved: () => void;
}

interface PoolDef {
  key: 'gemini-argon' | 'gemini-flash' | 'claude';
  name: string;
  description: string;
}

const POOLS: PoolDef[] = [
  {
    key: 'gemini-flash',
    name: 'Gemini Flash',
    description: 'High-speed standard Gemini models (Gemini Flash, Pro) with shared 5-hour limit.',
  },
  {
    key: 'gemini-argon',
    name: 'Gemini Argon',
    description: 'Flagship reasoning pool. Distinct quota bucket with separate weekly limit.',
  },
  {
    key: 'claude',
    name: 'Claude and GPT models',
    description:
      'Third-party model bucket (Claude Sonnet/Opus, GPT-OSS). Disabled by default to prevent credit drain.',
  },
];

export const PoolPoliciesCard = ({ config, onSaved }: PoolPoliciesCardProps) => {
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const rawPolicies = config.resolved?.poolPolicies || {};
  const currentPolicies = {
    'gemini-argon': {
      alertsEnabled: rawPolicies['gemini-argon']?.alertsEnabled ?? true,
      dispatchEnabled: rawPolicies['gemini-argon']?.dispatchEnabled ?? true,
    },
    'gemini-flash': {
      alertsEnabled: rawPolicies['gemini-flash']?.alertsEnabled ?? true,
      dispatchEnabled: rawPolicies['gemini-flash']?.dispatchEnabled ?? true,
    },
    claude: {
      alertsEnabled: rawPolicies.claude?.alertsEnabled ?? false,
      dispatchEnabled: rawPolicies.claude?.dispatchEnabled ?? false,
    },
  };

  const handleToggle = async (
    poolKey: 'gemini-argon' | 'gemini-flash' | 'claude',
    field: 'alertsEnabled' | 'dispatchEnabled'
  ) => {
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
      await updateConfig({ poolPolicies: updated });
      onSaved();
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
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
                <div class="flex items-center gap-2">
                  <h4 class="text-sm font-semibold text-pine-text">{pool.name}</h4>
                  <span class="font-mono text-xs text-pine-muted">({pool.key})</span>
                </div>
                <p class="mt-0.5 text-xs text-pine-subtle">{pool.description}</p>
              </div>

              <div class="flex flex-wrap items-center gap-6">
                {/* Alerts Toggle */}
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

                {/* Dispatch Toggle */}
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
