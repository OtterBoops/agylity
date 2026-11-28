import type { RouteAuth, RouteSpec } from './routeRegistry.js';
import { ROUTES } from './routeRegistry.js';

const pathMatches = (pattern: string, pathname: string): Record<string, string> | undefined => {
  const patternParts = pattern.split('/');
  const nameParts = pathname.split('/');
  if (patternParts.length !== nameParts.length) return undefined;

  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index]!;
    const actual = nameParts[index]!;
    if (expected.startsWith('{') && expected.endsWith('}')) {
      if (!actual) return undefined;
      // A malformed escape stays raw so the handler answers 400 rather than the router throwing.
      try {
        params[expected.slice(1, -1)] = decodeURIComponent(actual);
      } catch {
        params[expected.slice(1, -1)] = actual;
      }
      continue;
    }
    if (expected !== actual) return undefined;
  }
  return params;
};

export const matchRoute = (
  pathname: string
): { route: RouteSpec; params: Record<string, string> } | undefined => {
  for (const route of ROUTES) {
    const params = pathMatches(route.path, pathname);
    if (params) return { route, params };
  }
  return undefined;
};

/** Runner-token routes keep their own brute-force bucket, so the split has one declaration. */
export const routeAuthFor = (pathname: string): RouteAuth => {
  const matched = matchRoute(pathname);
  if (matched) return matched.route.auth;
  // An unregistered path keeps the control-plane gate it had before the registry existed.
  return pathname.startsWith('/api/') ? 'bearer' : 'public';
};
