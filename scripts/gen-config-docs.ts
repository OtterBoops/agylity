import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { applyConfigReference, renderEnvExample } from '../src/config/docs.js';

// Regenerates the env reference table and `.env.example` from CONFIG_REGISTRY. The unit test in
// tests/unit/config.test.ts asserts both files already match this output, so a registry change that
// is not regenerated fails the suite instead of shipping stale docs.
const root = path.resolve(import.meta.dirname, '..');
const docPath = path.join(root, 'docs', 'configuration.md');
const envPath = path.join(root, '.env.example');

const doc = readFileSync(docPath, 'utf8');
writeFileSync(docPath, applyConfigReference(doc), 'utf8');
writeFileSync(envPath, renderEnvExample(), 'utf8');

process.stdout.write(
  `Regenerated ${path.relative(root, docPath)} and ${path.relative(root, envPath)}\n`
);
