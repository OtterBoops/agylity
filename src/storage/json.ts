/** Decodes a JSON text column, falling back when the stored value is not valid JSON. */
export const readJsonColumn = <T>(raw: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
};
