// Shared JSON-body validation for the controllers: the backlog and routine PATCH routes accept the
// same three text fields, so one route may not silently widen what the other rejects.

const TEXT_FIELDS = ['title', 'prompt', 'repositoryId'] as const;

export const isPlainJsonObject = (value: unknown): boolean =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const validateTextFieldPatch = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  for (const field of TEXT_FIELDS) {
    if (!(field in record)) continue;
    const value = record[field];
    if (typeof value !== 'string' || value.trim() === '') {
      return `${field} must be a non-empty string`;
    }
  }
  return undefined;
};

export const rejectUnknownPatchKeys = (
  body: Record<string, unknown>,
  allowed: readonly string[]
): string | undefined => {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  return unknown.length > 0 ? `Unknown field(s): ${unknown.join(', ')}` : undefined;
};
