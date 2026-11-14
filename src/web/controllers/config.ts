import type http from 'node:http';
import { sendJson, methodNotAllowed, readJsonBody, safeDecodeSegment } from '../http.js';
import type { WebServerOptions } from '../types.js';
import { isSecretKey, isSecretMask, maskSecret, SECRET_MASK } from '../../storage/crypto.js';
import { validateConfigOverridePatch } from '../../config/schema.js';
import { logger } from '../../logs/logger.js';

/** Object-valued secrets (e.g. webhookCustomHeaders) are set when they carry any entry. */
const isSecretSet = (value: unknown): boolean => {
  if (typeof value === 'string') return value.trim() !== '';
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
};

export const sanitizeConfigForClient = (config: Record<string, any>): Record<string, any> => {
  const result: Record<string, any> = { ...config };
  for (const [k, v] of Object.entries(result)) {
    if (!isSecretKey(k)) continue;
    // Never hand the client the stored value. A blank one would read as "unset", and a blank
    // write deletes the override, so a configured object secret still renders as the mask.
    result[k] = typeof v === 'string' ? maskSecret(v) : isSecretSet(v) ? SECRET_MASK : '';
  }
  return result;
};

export const getSecretsMeta = (config: Record<string, any>): Record<string, { isSet: boolean }> => {
  const meta: Record<string, { isSet: boolean }> = {};
  for (const [k, v] of Object.entries(config)) {
    if (isSecretKey(k)) {
      meta[k] = { isSet: isSecretSet(v) };
    }
  }
  return meta;
};

export const handleConfigEndpoint = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): Promise<void> => {
  const log = options.logger ?? logger.child('web');

  if (method === 'GET') {
    const resolved = options.configStore.resolveConfig();
    const overrides = options.configStore.getAllOverrides();
    const sources = options.configStore.getSources?.() ?? {};
    return sendJson(
      res,
      200,
      {
        resolved: sanitizeConfigForClient(resolved),
        overrides: sanitizeConfigForClient(overrides),
        secretsMeta: getSecretsMeta(resolved),
        sources,
      },
      { 'Cache-Control': 'no-store' }
    );
  }

  if (method === 'POST') {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return;
    const payload: any = parsed.body;

    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return sendJson(res, 400, { error: 'Payload must be a JSON object' });
    }

    const patchToValidate: Record<string, unknown> = {};
    if (
      typeof payload.key === 'string' &&
      'value' in payload &&
      Object.keys(payload).length === 2
    ) {
      patchToValidate[payload.key] = payload.value;
    } else {
      Object.assign(patchToValidate, payload);
    }

    const keysToValidate: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patchToValidate)) {
      if (isSecretKey(k) && (isSecretMask(v) || v === null || v === '')) {
        continue;
      }
      keysToValidate[k] = v;
    }

    let validatedPatch: Record<string, unknown> = {};
    try {
      if (Object.keys(keysToValidate).length > 0) {
        validatedPatch = validateConfigOverridePatch(keysToValidate);
      }
    } catch (err: any) {
      return sendJson(res, 400, { error: err.message });
    }

    const handleSet = (key: string, value: unknown) => {
      if (isSecretKey(key)) {
        if (isSecretMask(value)) {
          return; // preserve existing secret, do not overwrite with mask
        }
        if (value === null || value === '') {
          options.configStore.deleteOverride(key);
          return;
        }
      }
      options.configStore.setOverride(key, value);
    };

    for (const [k, v] of Object.entries(patchToValidate)) {
      // Store the value the schema produced, not the raw one: repositories entries, for one,
      // only gain their derived id/defaultBranch through validation.
      handleSet(k, Object.hasOwn(validatedPatch, k) ? validatedPatch[k] : v);
    }

    const updatedResolved = options.configStore.resolveConfig();
    const updatedOverrides = options.configStore.getAllOverrides();
    const keys = typeof payload.key === 'string' ? [payload.key] : Object.keys(payload);
    log.info('Configuration updated via Web API (keys: %s)', keys.join(', '));
    return sendJson(res, 200, {
      success: true,
      resolved: sanitizeConfigForClient(updatedResolved),
      overrides: sanitizeConfigForClient(updatedOverrides),
      sources: options.configStore.getSources?.() ?? {},
      secretsMeta: getSecretsMeta(updatedResolved),
    });
  }

  return methodNotAllowed(res);
};

export const handleDeleteConfigOverride = (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  pathname: string,
  method: string
): void => {
  const log = options.logger ?? logger.child('web');
  if (method !== 'DELETE') return methodNotAllowed(res);

  const key = pathname.slice('/api/config/'.length).trim();
  if (!key) return sendJson(res, 400, { error: 'Configuration key is required' });

  const decodedKey = safeDecodeSegment(key);
  if (decodedKey === null) return sendJson(res, 400, { error: 'Malformed configuration key' });
  options.configStore.deleteOverride(decodedKey);
  log.info('Configuration override deleted via Web API: %s', decodedKey);
  const resolved = options.configStore.resolveConfig();
  const overrides = options.configStore.getAllOverrides();
  return sendJson(res, 200, {
    success: true,
    resolved: sanitizeConfigForClient(resolved),
    overrides: sanitizeConfigForClient(overrides),
    sources: options.configStore.getSources?.() ?? {},
    secretsMeta: getSecretsMeta(resolved),
  });
};
