import { useState } from 'preact/hooks';
import { faSliders } from '@fortawesome/free-solid-svg-icons';
import type { ConfigData } from '../types';
import { updateConfig } from '../api';
import { Icon } from './Icon';

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
                  <span class="font-mono text-[10px] text-pine-muted">({pool.key})</span>
                </div>
                <p class="mt-0.5 text-xs text-pine-subtle">{pool.description}</p>
              </div>

              <div class="flex flex-wrap items-center gap-6">
                {/* Alerts Toggle */}
                <div class="flex items-center gap-2.5">
                  <span class="text-xs font-medium text-pine-subtle">Alerts</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={policy.alertsEnabled}
                    disabled={isAlertsLoading}
                    onClick={() => handleToggle(pool.key, 'alertsEnabled')}
                    class={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden disabled:opacity-50 ${
                      policy.alertsEnabled
                        ? 'bg-pine-iris'
                        : 'border-pine-highlight bg-pine-overlay'
                    }`}
                    title={policy.alertsEnabled ? 'Disable pool alerts' : 'Enable pool alerts'}
                  >
                    <span
                      aria-hidden="true"
                      class={`pointer-events-none inline-block size-4 transform rounded-full bg-white shadow-xs ring-0 transition duration-200 ease-in-out ${
                        policy.alertsEnabled ? 'translate-x-4' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Dispatch Toggle */}
                <div class="flex items-center gap-2.5">
                  <span class="text-xs font-medium text-pine-subtle">Swarm Dispatch</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={policy.dispatchEnabled}
                    disabled={isDispatchLoading}
                    onClick={() => handleToggle(pool.key, 'dispatchEnabled')}
                    class={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden disabled:opacity-50 ${
                      policy.dispatchEnabled
                        ? 'bg-pine-pine'
                        : 'border-pine-highlight bg-pine-overlay'
                    }`}
                    title={
                      policy.dispatchEnabled
                        ? 'Disable swarm dispatches'
                        : 'Enable swarm dispatches'
                    }
                  >
                    <span
                      aria-hidden="true"
                      class={`pointer-events-none inline-block size-4 transform rounded-full bg-white shadow-xs ring-0 transition duration-200 ease-in-out ${
                        policy.dispatchEnabled ? 'translate-x-4' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
