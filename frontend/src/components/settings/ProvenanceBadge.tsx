import type { ConfigData } from '../../types';

type ProvenanceSource = NonNullable<ConfigData['sources']>[string];

interface ProvenanceBadgeProps {
  source?: ProvenanceSource;
  isSecretSet?: boolean;
  secret?: boolean;
}

const CHIP =
  'shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-xs font-normal leading-none whitespace-nowrap';

const OVERRIDE_CHIP = `${CHIP} border-pine-iris/40 bg-pine-iris/10 text-pine-iris`;
/* Env chips keep foam text: pine-green is 3.9:1 on the card surface, below AA at text-xs. */
const ENV_CHIP = `${CHIP} border-pine-pine/40 bg-pine-pine/10 text-pine-foam`;
const UNSET_CHIP = `${CHIP} border-pine-highlight text-pine-subtle`;

const TITLE = {
  override: 'This value is an override saved from this dashboard.',
  env: 'This value comes from the server environment; no override is stored.',
  setViaUi: 'A secret is stored as an encrypted override saved from this dashboard.',
  setViaEnv:
    'A secret comes from the server environment; stored secrets are never sent to the browser.',
  notSet: 'No secret is stored, so this setting stays unset until one is entered.',
} as const;

export const ProvenanceBadge = ({ source, isSecretSet, secret }: ProvenanceBadgeProps) => {
  if (secret) {
    if (!isSecretSet) {
      return (
        <span class={UNSET_CHIP} title={TITLE.notSet}>
          not set
        </span>
      );
    }
    const viaUi = source === 'override';
    return (
      <span
        class={viaUi ? OVERRIDE_CHIP : ENV_CHIP}
        title={viaUi ? TITLE.setViaUi : TITLE.setViaEnv}
      >
        {viaUi ? 'set via UI' : 'set via env'}
      </span>
    );
  }

  if (source === 'override') {
    return (
      <span class={OVERRIDE_CHIP} title={TITLE.override}>
        override
      </span>
    );
  }
  if (source === 'env') {
    return (
      <span class={ENV_CHIP} title={TITLE.env}>
        env
      </span>
    );
  }
  return null;
};
