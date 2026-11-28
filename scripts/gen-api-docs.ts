import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildOpenApiDocument } from '../src/web/openapi.js';
import { ROUTES } from '../src/web/routeRegistry.js';
import { AGYLITY_VERSION } from '../src/version.js';

const target = path.resolve(import.meta.dirname, '../docs/openapi.json');
const rendered = `${JSON.stringify(buildOpenApiDocument(ROUTES, AGYLITY_VERSION), null, 2)}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    console.error('docs/openapi.json is missing; run `npm run docs:api`');
    process.exit(1);
  }
  if (current !== rendered) {
    console.error('docs/openapi.json is stale; run `npm run docs:api`');
    process.exit(1);
  }
  process.exit(0);
}

writeFileSync(target, rendered);
console.log(`Wrote ${path.relative(process.cwd(), target)}`);
