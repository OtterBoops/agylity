// A link target that arrives from a runner is untrusted: only a web URL may become an href, because
// `javascript:`/`data:` would execute in the control-plane origin, where the auth token lives.
export const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return false;
  try {
    const { protocol } = new URL(trimmed);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};
