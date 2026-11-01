import type http from 'node:http';
import { sendJson, methodNotAllowed, readBody } from '../http.js';
import type { WebServerOptions } from '../types.js';
import { isSecretKey, maskSecret } from '../../storage/crypto.js';
import { validateConfigOverridePatch } from '../../config/schema.js';
import { logger } from '../../logs/logger.js';

export const sanitizeConfigForClient = (config: Record<string, any>): Record<string, any> => {
  const result: Record<string, any> = { ...config };
  for (const [k, v] of Object.entries(result)) {
    if (isSecretKey(k)) {
      result[k] = maskSecret(v);
    }
  }
  return result;
};

export const getSecretsMeta = (config: Record<string, any>): Record<string, { isSet: boolean }> => {
  const meta: Record<string, { isSet: boolean }> = {};
  for (const [k, v] of Object.entries(config)) {
    if (isSecretKey(k)) {
      meta[k] = { isSet: Boolean(v && typeof v === 'string' && v.trim() !== '') };
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
    return sendJson(res, 200, {
      resolved: sanitizeConfigForClient(resolved),
      overrides: sanitizeConfigForClient(overrides),
      secretsMeta: getSecretsMeta(resolved),
    });
  }

  if (method === 'POST') {
    const body = await readBody(req, res);
    if (!body.trim()) return sendJson(res, 400, { error: 'Request body cannot be empty' });

    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { error: 'Malformed JSON payload' });
    }

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
      if (isSecretKey(k) && (v === '••••••••' || v === '********' || v === null || v === '')) {
        continue;
      }
      keysToValidate[k] = v;
    }

    try {
      if (Object.keys(keysToValidate).length > 0) {
        validateConfigOverridePatch(keysToValidate);
      }
    } catch (err: any) {
      return sendJson(res, 400, { error: err.message });
    }

    const handleSet = (key: string, value: unknown) => {
      if (isSecretKey(key)) {
        if (value === '••••••••' || value === '********') {
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
      handleSet(k, v);
    }

    const updatedResolved = options.configStore.resolveConfig();
    const updatedOverrides = options.configStore.getAllOverrides();
    const keys = typeof payload.key === 'string' ? [payload.key] : Object.keys(payload);
    log.info('Configuration updated via Web API (keys: %s)', keys.join(', '));
    return sendJson(res, 200, {
      success: true,
      resolved: sanitizeConfigForClient(updatedResolved),
      overrides: sanitizeConfigForClient(updatedOverrides),
      secretsMeta: getSecretsMeta(updatedResolved),
    });
  }

  return methodNotAllowed(res);
};

export const handleDeleteConfigOverride = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  pathname: string,
  method: string
): void => {
  const log = options.logger ?? logger.child('web');
  const key = pathname.slice('/api/config/'.length).trim();
  if (!key || method !== 'DELETE') return methodNotAllowed(res);

  const decodedKey = decodeURIComponent(key);
  options.configStore.deleteOverride(decodedKey);
  log.info('Configuration override deleted via Web API: %s', decodedKey);
  const resolved = options.configStore.resolveConfig();
  const overrides = options.configStore.getAllOverrides();
  return sendJson(res, 200, {
    success: true,
    resolved: sanitizeConfigForClient(resolved),
    overrides: sanitizeConfigForClient(overrides),
    secretsMeta: getSecretsMeta(resolved),
  });
};
