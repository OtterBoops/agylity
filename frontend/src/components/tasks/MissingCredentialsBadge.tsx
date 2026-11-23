const MISSING_CREDENTIALS = 'Missing GitHub token on coordinator';

/**
 * Shown in a runner STATUS column instead of IDLE when the coordinator holds no GitHub token:
 * runners can lease no credential, so an idle runner cannot start a round.
 */
export const MissingCredentialsBadge = () => (
  <span
    role="img"
    aria-label={MISSING_CREDENTIALS}
    title={MISSING_CREDENTIALS}
    class="inline-flex items-center rounded-md border border-pine-love/40 bg-pine-love/10 px-2 py-0.5 text-xs font-semibold tracking-wide whitespace-nowrap text-pine-love uppercase"
  >
    NO CREDENTIALS
  </span>
);
