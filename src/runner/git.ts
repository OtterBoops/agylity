// A tokenless runner only fails at push, after burning a full agent run -- fail at boot instead.
export const assertRunnerGitCredentials = (
  repositories: string[] | undefined,
  env: NodeJS.ProcessEnv = process.env
): void => {
  if (env.ALLOW_TOKENLESS_RUNNER?.trim().toLowerCase() === 'true') return;
  const token = env.GITHUB_TOKEN?.trim();
  if (token) return;

  const scope =
    repositories && repositories.length > 0
      ? `scoped to ${repositories.join(', ')}`
      : 'unscoped, so it may claim any repository the coordinator offers';

  throw new Error(
    `GITHUB_TOKEN is not set on this runner (${scope}). Without it the clone is anonymous and ` +
      'git push fails after the task has already spent its quota, so refusing to start. ' +
      'Note that env_file alone does not put a variable in the container environment -- the token ' +
      'must also be named under environment: in compose.yaml. Set ALLOW_TOKENLESS_RUNNER=true to ' +
      'run without a token against a non-GitHub remote.'
  );
};

const gitBasicAuthValue = (): string | null => {
  const ghToken = process.env.GITHUB_TOKEN?.trim();
  if (!ghToken) return null;
  return Buffer.from(`x-access-token:${ghToken}`, 'utf8').toString('base64');
};

// The token itself and its base64 form both reach git stderr, so neither may survive into a log.
export const redactGitSecrets = (text: string): string => {
  const ghToken = process.env.GITHUB_TOKEN?.trim();
  const basicAuth = gitBasicAuthValue();
  if (!ghToken || ghToken.length < 6 || !basicAuth) return text;
  return text.split(ghToken).join('[redacted]').split(basicAuth).join('[redacted]');
};

export const buildGitAuthArgs = (repoUrl?: string): string[] => {
  const basicAuth = gitBasicAuthValue();
  // The extraheader is bound to github.com; sending it to another host hands that host the token.
  if (basicAuth && (!repoUrl || repoUrl.startsWith('https://github.com/'))) {
    return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basicAuth}`];
  }
  return [];
};
