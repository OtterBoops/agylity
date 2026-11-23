import type { Logger } from '../logs/logger.js';

// The credential belongs to the coordinator and arrives with each task lease, so a runner that still
// carries its own copy is stale by construction; ignoring it silently would hide that from the operator.
export const warnLegacyGithubToken = (log: Logger, env: NodeJS.ProcessEnv = process.env): void => {
  if (!env.GITHUB_TOKEN?.trim()) return;
  log.warn(
    'Ignoring GITHUB_TOKEN in this runner environment: GitHub credentials are configured on the ' +
      'coordinator and leased per task. Remove the variable from this runner.'
  );
};

const gitBasicAuthValue = (token: string | undefined): string | null => {
  const trimmed = token?.trim();
  if (!trimmed) return null;
  return Buffer.from(`x-access-token:${trimmed}`, 'utf8').toString('base64');
};

// The token itself and its base64 form both reach git stderr, so neither may survive into a log.
export const redactGitSecrets = (
  text: string,
  tokens: readonly (string | undefined)[] = []
): string => {
  let redacted = text;
  for (const candidate of [...tokens, process.env.GITHUB_TOKEN]) {
    const token = candidate?.trim();
    if (!token || token.length < 6) continue;
    const basicAuth = gitBasicAuthValue(token);
    redacted = redacted.split(token).join('[redacted]');
    if (basicAuth) redacted = redacted.split(basicAuth).join('[redacted]');
  }
  return redacted;
};

export const buildGitAuthArgs = (repoUrl?: string, token?: string): string[] => {
  const basicAuth = gitBasicAuthValue(token);
  // The extraheader is bound to github.com; sending it to another host hands that host the token.
  if (basicAuth && (!repoUrl || repoUrl.startsWith('https://github.com/'))) {
    return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basicAuth}`];
  }
  return [];
};
