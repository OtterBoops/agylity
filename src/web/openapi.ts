import { ROUTES } from './routeRegistry.js';
import { AGYLITY_VERSION } from '../version.js';

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  components: Record<string, unknown>;
  paths: Record<string, Record<string, unknown>>;
}

const OPENAPI_VERSION = '3.1.0';

/** The control plane's contract, derived from the registry so a route cannot exist undocumented. */
export const buildOpenApiDocument = (version = AGYLITY_VERSION): OpenApiDocument => {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of ROUTES) {
    const parameters = (route.path.match(/\{[^}]+\}/g) ?? []).map((token) => ({
      name: token.slice(1, -1),
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));

    // Registration exchanges a body token rather than carrying a runner Bearer credential.
    const usesBearerSecurity = route.auth !== 'public' && route.path !== '/api/runners/register';

    for (const method of route.methods) {
      paths[route.path] = paths[route.path] ?? {};
      paths[route.path]![method.toLowerCase()] = {
        summary: route.summary,
        ...(parameters.length > 0 ? { parameters } : {}),
        ...(usesBearerSecurity
          ? { security: [{ [route.auth === 'runner' ? 'runnerAuth' : 'bearerAuth']: [] }] }
          : {}),
        responses: {
          '200': { description: 'Success' },
          ...(route.auth === 'public'
            ? {}
            : { '401': { description: 'Missing or invalid token' } }),
          '429': { description: 'Brute-force lockout' },
        },
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
