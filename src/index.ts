import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgylityDaemon, createDaemon, startDaemon, stopDaemon } from './daemon/daemon.js';
import { main } from './cli/main.js';

export { AgylityDaemon, createDaemon, startDaemon, stopDaemon };

const isDirectExecution = (): boolean => {
  if (typeof process.argv[1] !== 'string') return false;
  if (process.env.NODE_TEST_CONTEXT || process.env.VITEST) return false;

  try {
    const currentScript = fileURLToPath(import.meta.url);
    const invokedScript = path.resolve(process.argv[1]);
    return currentScript === invokedScript;
  } catch {
    return false;
  }
};

if (isDirectExecution()) {
  main().catch((err) => {
    console.error('[agylity] Fatal daemon startup error:', err);
    process.exit(1);
  });
}

export default AgylityDaemon;
