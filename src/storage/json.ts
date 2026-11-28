export const readJsonColumn = <T>(raw: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
};
