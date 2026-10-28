export interface VersionCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  releaseUrl: string | null;
  isChecking: boolean;
}

export const APP_VERSION = '0.1.0';
const GITHUB_REPO = 'OtterBoops/agylity';
const CACHE_KEY = 'agylity_release_cache';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function isNewerVersion(current: string, latest: string): boolean {
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
}

export async function fetchLatestRelease(): Promise<{ latest: string; url: string } | null> {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.timestamp < CACHE_TTL_MS) {
        return { latest: parsed.tag, url: parsed.url };
      }
    }
  } catch {
    // ignore cache parse issues
  }

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
      } catch {
        // quota exceeded or disabled
      }
      return { latest: tag, url };
    }
  } catch {
    // network failure or offline
  }

  return null;
}
