/** A runner credential and the control-plane Bearer token are separate auth domains. */
type AuthDomain = 'control' | 'runner';

interface AuthFailureRecord {
  failures: number;
  blockedUntilMs: number;
  lastFailureMs: number;
}

const authFailuresByIp = new Map<string, AuthFailureRecord>();

const AUTH_FAILURE_WINDOW_MS = 60_000;
const AUTH_FAILURE_MAX_ENTRIES = 10_000;

const failureKey = (clientIp: string, domain: AuthDomain): string => `${domain}:${clientIp}`;

const pruneAuthFailures = (now: number): void => {
  for (const [key, record] of authFailuresByIp) {
    if (record.blockedUntilMs <= now && now - record.lastFailureMs > AUTH_FAILURE_WINDOW_MS) {
      authFailuresByIp.delete(key);
    }
  }

  while (authFailuresByIp.size > AUTH_FAILURE_MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const [key, record] of authFailuresByIp) {
      if (record.lastFailureMs < oldestMs) {
        oldestMs = record.lastFailureMs;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    authFailuresByIp.delete(oldestKey);
  }
};

export const recordAuthFailure = (clientIp: string, domain: AuthDomain): boolean => {
  const key = failureKey(clientIp, domain);
  const now = Date.now();
  const record = authFailuresByIp.get(key) ?? {
    failures: 0,
    blockedUntilMs: 0,
    lastFailureMs: now,
  };

  if (now - record.lastFailureMs > AUTH_FAILURE_WINDOW_MS) {
    record.failures = 0;
    record.blockedUntilMs = 0;
  }

  record.failures++;
  record.lastFailureMs = now;

  if (record.failures >= 10) {
    record.blockedUntilMs = now + AUTH_FAILURE_WINDOW_MS;
  }

  authFailuresByIp.set(key, record);
  pruneAuthFailures(now);
  return record.blockedUntilMs > now;
};

export const isIpRateLimited = (clientIp: string, domain: AuthDomain): boolean => {
  const record = authFailuresByIp.get(failureKey(clientIp, domain));
  if (!record) return false;
  return record.blockedUntilMs > Date.now();
};

export const clearAuthFailures = (clientIp: string, domain: AuthDomain): void => {
  authFailuresByIp.delete(failureKey(clientIp, domain));
};
