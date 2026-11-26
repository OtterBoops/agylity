import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../../src/web/openapi.js';
import { ROUTES } from '../../src/web/routeRegistry.js';
import { AGYLITY_VERSION } from '../../src/version.js';

const render = (): string => `${JSON.stringify(buildOpenApiDocument(AGYLITY_VERSION), null, 2)}\n`;

describe('Control plane: OpenAPI contract', () => {
  it('keeps docs/openapi.json identical to what the registry generates', () => {
    const target = fileURLToPath(new URL('../../docs/openapi.json', import.meta.url));
    assert.equal(readFileSync(target, 'utf8'), render());
  });

  it('documents every declared route under its methods', () => {
    const doc = buildOpenApiDocument(AGYLITY_VERSION);

    for (const route of ROUTES) {
      for (const method of route.methods) {
        assert.ok(
          doc.paths[route.path]?.[method.toLowerCase()],
          `${method} ${route.path} must be documented`
        );
      }
    }
  });

  it('separates the runner credential from the control-plane token', () => {
    const doc = buildOpenApiDocument(AGYLITY_VERSION);

    const securityOf = (path: string, method: string): unknown =>
      (doc.paths[path]![method] as Record<string, unknown>).security;

    assert.equal(securityOf('/api/health', 'get'), undefined);
    assert.equal(securityOf('/api/runners/register', 'post'), undefined);
    assert.deepEqual(securityOf('/api/tasks/poll', 'post'), [{ runnerAuth: [] }]);
    assert.deepEqual(securityOf('/api/tasks/{id}/status', 'post'), [{ runnerAuth: [] }]);
    assert.deepEqual(securityOf('/api/tasks', 'get'), [{ bearerAuth: [] }]);
  });

  it('defaults the OpenAPI document version to AGYLITY_VERSION', () => {
    assert.equal(buildOpenApiDocument().info.version, AGYLITY_VERSION);
  });
});
