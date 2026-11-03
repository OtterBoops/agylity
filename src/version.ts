import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Read from the shipped manifest so the reported version cannot drift from package.json.
export const AGYLITY_VERSION = (() => {
  try {
    const pkg = fileURLToPath(new URL('../package.json', import.meta.url));
    return (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();
