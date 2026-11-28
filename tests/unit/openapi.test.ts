import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../../src/web/openapi.js';
import { ROUTES } from '../../src/web/routeRegistry.js';
import { AGYLITY_VERSION } from '../../src/version.js';

const render = (): string =>
  `${JSON.stringify(buildOpenApiDocument(ROUTES, AGYLITY_VERSION), null, 2)}\n`;

type Operation = {
  parameters?: { name: string; in: string; required: boolean }[];
  requestBody?: { content: Record<string, { schema?: Record<string, unknown> }> };
  responses: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }>;
  security?: unknown;
};

const documentPaths = (): Record<string, Record<string, Operation>> =>
  (
    buildOpenApiDocument(ROUTES, AGYLITY_VERSION) as unknown as {
      paths: Record<string, Record<string, Operation>>;
    }
  ).paths;

/** A write that reads no body: the handler ignores the request stream entirely. */
const BODYLESS_PATHS = new Set([
  '/api/alerts/dismiss',
  '/api/backlog/sync-github',
  '/api/backlog/{id}/dispatch',
  '/api/routines/{id}/trigger',
  '/api/tasks/{id}/cancel',
  '/api/tasks/{id}/retry',
]);

describe('Control plane: OpenAPI contract', () => {
  it('keeps docs/openapi.json identical to what the registry generates', () => {
    const target = fileURLToPath(new URL('../../docs/openapi.json', import.meta.url));
    assert.equal(readFileSync(target, 'utf8'), render());
  });

  it('documents every declared route under its methods', () => {
    const paths = documentPaths();

    for (const route of ROUTES) {
      for (const method of route.methods) {
        assert.ok(
          paths[route.path]?.[method.toLowerCase()],
          `${method} ${route.path} must be documented`
        );
      }
    }
  });

  it('contracts exactly the verbs each route advertises', () => {
    for (const route of ROUTES) {
      assert.deepEqual(
        Object.keys(route.operations).sort(),
        [...route.methods].sort(),
        `${route.path} advertises ${route.methods.join(',')} and contracts ${Object.keys(route.operations).join(',')}`
      );
    }
  });

  it('gives every operation a success body schema', () => {
    const paths = documentPaths();

    for (const route of ROUTES) {
      for (const [method, operation] of Object.entries(route.operations)) {
        const success = Object.keys(operation.responses).filter((status) => {
          const code = Number(status);
          return code >= 200 && code < 300;
        });
        assert.ok(success.length > 0, `${method} ${route.path} declares no 2xx response`);

        for (const status of success) {
          assert.ok(
            paths[route.path]?.[method.toLowerCase()]?.responses[status]?.content?.[
              'application/json'
            ]?.schema,
            `${method} ${route.path} ${status} must carry a JSON body schema`
          );
        }
      }
    }
  });

  it('gives every operation that reads a body a request schema', () => {
    for (const route of ROUTES) {
      for (const [method, operation] of Object.entries(route.operations)) {
        if (method === 'GET' || method === 'DELETE') continue;
        assert.equal(
          Boolean(operation.request?.body),
          !BODYLESS_PATHS.has(route.path),
          `${method} ${route.path} request body schema disagrees with the handler`
        );
      }
    }
  });

  it('emits a JSON body schema for every documented response', () => {
    for (const [path, methods] of Object.entries(documentPaths())) {
      for (const [method, operation] of Object.entries(methods)) {
        const statuses = Object.keys(operation.responses);
        assert.ok(statuses.length > 0, `${method} ${path} documents no response`);
        for (const status of statuses) {
          assert.ok(
            operation.responses[status]?.content?.['application/json']?.schema,
            `${method} ${path} ${status} has no schema`
          );
        }
      }
    }
  });

  it('separates the runner credential from the control-plane token', () => {
    const paths = documentPaths();
    const securityOf = (path: string, method: string): unknown => paths[path]![method]?.security;

    assert.equal(securityOf('/api/health', 'get'), undefined);
    assert.equal(securityOf('/api/runners/register', 'post'), undefined);
    assert.deepEqual(securityOf('/api/tasks/poll', 'post'), [{ runnerAuth: [] }]);
    assert.deepEqual(securityOf('/api/tasks/{id}/status', 'post'), [{ runnerAuth: [] }]);
    assert.deepEqual(securityOf('/api/tasks', 'get'), [{ bearerAuth: [] }]);
  });

  it('documents path parameters alongside the declared query parameters', () => {
    const paths = documentPaths();
    const namesOf = (path: string, method: string): string[] =>
      (paths[path]![method]!.parameters ?? []).map((param) => param.name);

    assert.deepEqual(namesOf('/api/tasks/{id}', 'get'), ['id']);
    assert.deepEqual(namesOf('/api/alerts/events', 'get'), ['limit', 'before', 'pool']);
  });

  it('defaults the OpenAPI document version to AGYLITY_VERSION', () => {
    assert.equal(buildOpenApiDocument(ROUTES).info.version, AGYLITY_VERSION);
  });
});
