import type http from 'node:http';
import { sendJson, methodNotAllowed, readJsonBody, safeDecodeSegment } from '../http.js';
import type { WebServerOptions } from '../types.js';
import { isSecretKey, isSecretMask, maskSecret, SECRET_MASK } from '../../storage/crypto.js';
import {
  BUILTIN_DEFAULTS,
  ENV_TO_CONFIG_KEY,
  FORBIDDEN_CONFIG_KEYS,
  validateConfigOverridePatch,
} from '../../config/schema.js';
import { logger } from '../../logs/logger.js';

const isSecretSet = (value: unknown): boolean => {
  if (typeof value === 'string') return value.trim() !== '';
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
};

export const sanitizeConfigForClient = (config: Record<string, any>): Record<string, any> => {
  const result: Record<string, any> = { ...config };
  for (const [k, v] of Object.entries(result)) {
    if (!isSecretKey(k)) continue;
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

    const isPlainObject = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);

    const isKeyValueForm =
      typeof payload.key === 'string' && 'value' in payload && Object.keys(payload).length === 2;
    const isEnvelope =
      !isKeyValueForm && (Object.hasOwn(payload, 'set') || Object.hasOwn(payload, 'clear'));

    const patchToValidate: Record<string, unknown> = {};
    const keysToClear: string[] = [];

    if (isEnvelope) {
      const unexpected = Object.keys(payload).filter((k) => k !== 'set' && k !== 'clear');
      if (unexpected.length > 0) {
        return sendJson(res, 400, {
          error: `Unexpected fields in config write: ${unexpected.join(', ')}`,
        });
      }
      if (payload.set !== undefined && !isPlainObject(payload.set)) {
        return sendJson(res, 400, { error: '`set` must be a JSON object' });
      }
      if (payload.clear !== undefined && !Array.isArray(payload.clear)) {
        return sendJson(res, 400, { error: '`clear` must be an array of configuration keys' });
      }
      for (const entry of (payload.clear ?? []) as unknown[]) {
        if (typeof entry !== 'string' || entry.trim() === '') {
          return sendJson(res, 400, {
            error: '`clear` entries must be non-empty configuration keys',
          });
        }
        const key = entry.trim();
        if (FORBIDDEN_CONFIG_KEYS.has(key) || !Object.hasOwn(BUILTIN_DEFAULTS, key)) {
          const normalized = ENV_TO_CONFIG_KEY[key];
          if (!normalized || FORBIDDEN_CONFIG_KEYS.has(normalized)) {
            return sendJson(res, 400, { error: `Unknown configuration key: ${key}` });
          }
        }
        if (!keysToClear.includes(key)) keysToClear.push(key);
      }
      Object.assign(patchToValidate, payload.set ?? {});
    } else if (isKeyValueForm) {
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

    const cleared: string[] = [];
    const clearedSet = new Set<string>();

    const handleClear = (key: string) => {
      options.configStore.deleteOverride(key);
      if (!clearedSet.has(key)) {
        clearedSet.add(key);
        cleared.push(key);
      }
    };

    const handleSet = (key: string, value: unknown) => {
      if (isSecretKey(key)) {
        if (isSecretMask(value)) {
          return; // preserve existing secret, do not overwrite with mask
        }
        if (value === null || value === '') {
          handleClear(key);
          return;
        }
      }
      options.configStore.setOverride(key, value);
    };

    // Deletes first so an explicit `set` of the same key wins over its `clear`.
    for (const key of keysToClear) handleClear(key);

    for (const [k, v] of Object.entries(patchToValidate)) {
      handleSet(k, Object.hasOwn(validatedPatch, k) ? validatedPatch[k] : v);
    }

    const updatedResolved = options.configStore.resolveConfig();
    const updatedOverrides = options.configStore.getAllOverrides();
    const keys = typeof payload.key === 'string' ? [payload.key] : Object.keys(patchToValidate);
    const touched = [...keys, ...cleared];
    log.info('Configuration updated via Web API (keys: %s)', touched.join(', ') || 'none');
    return sendJson(res, 200, {
      success: true,
      resolved: sanitizeConfigForClient(updatedResolved),
      overrides: sanitizeConfigForClient(updatedOverrides),
      sources: options.configStore.getSources?.() ?? {},
      secretsMeta: getSecretsMeta(updatedResolved),
      cleared,
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
