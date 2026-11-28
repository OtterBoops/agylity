import { z } from 'zod';
import type { RouteSpec } from './routeRegistry.js';
import { AGYLITY_VERSION } from '../version.js';
import {
  ForbiddenSchema,
  PayloadTooLargeSchema,
  RateLimitedSchema,
  UnauthorizedSchema,
} from './schemas/common.js';

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  components: Record<string, unknown>;
  paths: Record<string, Record<string, unknown>>;
}

type JsonSchema = Record<string, unknown>;

const OPENAPI_VERSION = '3.1.0';

const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: 'Success',
  201: 'Created',
  400: 'Invalid request',
  401: 'Missing or invalid token',
  403: 'Blocked by the IP allowlist or the cross-site guard',
  404: 'Not found',
  409: 'Conflicting state',
  413: 'Request body over the 64 KB limit',
  429: 'Brute-force lockout',
  500: 'Unexpected failure',
  503: 'Dependency unavailable',
};

const REQUEST_BODY_METHODS = new Set(['POST', 'PATCH', 'PUT']);

/** Middleware answers every route can give, so no route declares them by hand. */
const middlewareResponses = (auth: string, method: string): Record<number, z.ZodType> => {
  const responses: Record<number, z.ZodType> = {
    403: ForbiddenSchema,
    429: RateLimitedSchema,
  };
  if (auth !== 'public') responses[401] = UnauthorizedSchema;
  if (REQUEST_BODY_METHODS.has(method)) responses[413] = PayloadTooLargeSchema;
  return responses;
};

/** OpenAPI 3.1 carries the dialect at the document root, so a nested `$schema` is noise. */
const toJsonSchema = (schema: z.ZodType, io: 'input' | 'output'): JsonSchema => {
  const generated = z.toJSONSchema(schema, { io }) as JsonSchema;
  delete generated.$schema;
  return generated;
};

const pathParameters = (pattern: string): unknown[] =>
  (pattern.match(/\{[^}]+\}/g) ?? []).map((token) => ({
    name: token.slice(1, -1),
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));

const queryParameters = (query: z.ZodType): unknown[] => {
  const generated = toJsonSchema(query, 'input');
  const properties = (generated.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((generated.required ?? []) as string[]);

  return Object.entries(properties).map(([name, schema]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema,
  }));
};

const responseEntries = (responses: Record<number, z.ZodType>): Record<string, unknown> =>
  Object.fromEntries(
    Object.keys(responses)
      .map(Number)
      .sort((left, right) => left - right)
      .map((status) => [
        String(status),
        {
          description: STATUS_TEXT[status] ?? 'Response',
          content: { 'application/json': { schema: toJsonSchema(responses[status]!, 'output') } },
        },
      ])
  );

/** The control plane's contract, derived from the registry so a route cannot exist undocumented. */
export const buildOpenApiDocument = (
  routes: readonly RouteSpec[],
  version = AGYLITY_VERSION
): OpenApiDocument => {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const pathParams = pathParameters(route.path);

    // Registration exchanges a body token rather than carrying a runner Bearer credential.
    const usesBearerSecurity = route.auth !== 'public' && route.path !== '/api/runners/register';

    for (const method of route.methods) {
      const operation = route.operations[method];
      if (!operation) continue;

      const request = operation.request;
      const parameters = [...pathParams, ...(request?.query ? queryParameters(request.query) : [])];

      paths[route.path] = paths[route.path] ?? {};
      paths[route.path]![method.toLowerCase()] = {
        summary: route.summary,
        ...(parameters.length > 0 ? { parameters } : {}),
        ...(usesBearerSecurity
          ? { security: [{ [route.auth === 'runner' ? 'runnerAuth' : 'bearerAuth']: [] }] }
          : {}),
        ...(request?.body
          ? {
              requestBody: {
                required: !request.bodyOptional,
                content: { 'application/json': { schema: toJsonSchema(request.body, 'input') } },
              },
            }
          : {}),
        responses: responseEntries({
          ...middlewareResponses(route.auth, method),
          ...operation.responses,
        }),
      };
    }
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Agylity control plane',
      version,
      description:
        'Generated from src/web/routeRegistry.ts. Runner routes take a runner credential, not the control-plane token.',
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'WEB_UI_AUTH_TOKEN control-plane token',
        },
        runnerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Runner credential from POST /api/runners/register',
        },
      },
    },
    paths,
  };
};
