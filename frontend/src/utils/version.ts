declare const __APP_VERSION__: string;

import { normalizeBuildCommit } from '../../../src/shared/build.ts';

export const APP_VERSION = __APP_VERSION__;
const GITHUB_REPO = 'OtterBoops/agylity';
const CACHE_KEY = 'agylity_release_cache';
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAIN_COMMIT_CACHE_KEY = 'agylity_main_commit_cache';
const MAIN_COMMIT_TTL_MS = 10 * 60 * 1000; // main moves per commit, so it outdates faster than a tag

export const mainCommitUrl = (sha: string): string =>
  `https://github.com/${GITHUB_REPO}/commit/${sha}`;

export const mainCompareUrl = (current: string, latest: string): string =>
  `https://github.com/${GITHUB_REPO}/compare/${current}...${latest}`;

export const isNewerVersion = (current: string, latest: string): boolean => {
  const clean = (v: string) => v.replace(/^v/, '').trim();
  const [c1 = 0, c2 = 0, c3 = 0] = clean(current)
    .split('.')
    .map((p) => parseInt(p, 10) || 0);
  const [l1 = 0, l2 = 0, l3 = 0] = clean(latest)
    .split('.')
    .map((p) => parseInt(p, 10) || 0);

  if (l1 !== c1) return l1 > c1;
  if (l2 !== c2) return l2 > c2;
  return l3 > c3;
};

let inFlightRelease: Promise<{ latest: string; url: string } | null> | null = null;

export const fetchLatestRelease = (): Promise<{ latest: string; url: string } | null> => {
  if (inFlightRelease) return inFlightRelease;
  inFlightRelease = (async () => {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < CACHE_TTL_MS) {
          return { latest: parsed.tag, url: parsed.url };
        }
      }
    } catch {}

    try {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (!res.ok) return null;
      const data = await res.json();
      const tag = (data.tag_name || '').replace(/^v/, '');
      const url = data.html_url || `https://github.com/${GITHUB_REPO}/releases/latest`;

      if (tag) {
        try {
          localStorage.setItem(
            CACHE_KEY,
            JSON.stringify({
              tag,
              url,
              timestamp: Date.now(),
            })
          );
        } catch {}
        return { latest: tag, url };
      }
    } catch {}

    return null;
  })().finally(() => {
    inFlightRelease = null;
  });

  return inFlightRelease;
};

let inFlightMainCommit: Promise<{ sha: string; url: string } | null> | null = null;

/** Newest commit on `main`, or null when GitHub is unreachable or rate limited (no indicator). */
export const fetchLatestMainCommit = (
  currentCommit?: string | null
): Promise<{ sha: string; url: string } | null> => {
  const normalizedCurrent = normalizeBuildCommit(currentCommit);
  if (inFlightMainCommit) return inFlightMainCommit;
  inFlightMainCommit = (async () => {
    try {
      const cached = localStorage.getItem(MAIN_COMMIT_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        const sameBuild = !normalizedCurrent || parsed.forCommit === normalizedCurrent;
        if (sameBuild && Date.now() - parsed.timestamp < MAIN_COMMIT_TTL_MS && parsed.sha) {
          return { sha: parsed.sha, url: parsed.url };
        }
      }
    } catch {}

    try {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits/main`, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (!res.ok) return null;
      const data = await res.json();
      const sha = normalizeBuildCommit(data.sha);
      if (!sha) return null;
      const url = data.html_url || mainCommitUrl(sha);

      try {
        localStorage.setItem(
          MAIN_COMMIT_CACHE_KEY,
          JSON.stringify({
            sha,
            url,
            forCommit: normalizedCurrent,
            timestamp: Date.now(),
          })
        );
      } catch {}
      return { sha, url };
    } catch {}

    return null;
  })().finally(() => {
    inFlightMainCommit = null;
  });

  return inFlightMainCommit;
};
