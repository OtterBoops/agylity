import type http from 'node:http';
import { sendJson, methodNotAllowed, readJsonBody, safeDecodeSegment } from '../http.js';
import type { WebServerOptions } from '../types.js';
import { isSecretKey, isSecretMask, maskSecret, SECRET_MASK } from '../../storage/crypto.js';
import {
  BUILTIN_DEFAULTS,
  ENV_TO_CONFIG_KEY,
  FORBIDDEN_CONFIG_KEYS,
  validateConfigOverridePatch,
} from '../../config/registry.js';
import {
  maskNotificationDestinations,
  mergeDestinationSecrets,
} from '../../config/destinations.js';
import type { NotificationDestination } from '../../shared/contracts.js';
import { logger } from '../../logs/logger.js';
import { isPlainJsonObject } from './patchFields.js';
import { isValidIpRange } from '../../net/ip.js';

const isSecretSet = (value: unknown): boolean => {
  if (typeof value === 'string') return value.trim() !== '';
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
};

/** A writable key: a builtin field, or an env alias that normalises onto one. */
const isWritableConfigKey = (key: string): boolean => {
  // Own-property lookup only: `ENV_TO_CONFIG_KEY['__proto__']` would answer with Object.prototype.
  const alias = Object.hasOwn(ENV_TO_CONFIG_KEY, key) ? ENV_TO_CONFIG_KEY[key] : undefined;
  if (FORBIDDEN_CONFIG_KEYS.has(key)) return false;
  if (Object.hasOwn(BUILTIN_DEFAULTS, key)) return true;
  return Boolean(alias) && !FORBIDDEN_CONFIG_KEYS.has(alias!);
};

const sanitizeConfigForClient = (config: Record<string, any>): Record<string, any> => {
  const result: Record<string, any> = { ...config };
  for (const [k, v] of Object.entries(result)) {
    if (!isSecretKey(k)) continue;
    result[k] = typeof v === 'string' ? maskSecret(v) : isSecretSet(v) ? SECRET_MASK : '';
  }
  if (Array.isArray(result.destinations)) {
    result.destinations = maskNotificationDestinations(
      result.destinations as NotificationDestination[]
    ).destinations;
  }
  return result;
};

const getSecretsMeta = (config: Record<string, any>): Record<string, { isSet: boolean }> => {
  const meta: Record<string, { isSet: boolean }> = {};
  for (const [k, v] of Object.entries(config)) {
    if (isSecretKey(k)) {
      meta[k] = { isSet: isSecretSet(v) };
    }
  }
  return meta;
};

/** Per-instance secret presence, keyed `<destinationId>.<field>` under `destinationsMeta`. */
const getDestinationsMeta = (
  config: Record<string, any>
): Record<string, Record<string, { isSet: boolean }>> => {
  if (!Array.isArray(config.destinations)) return {};
  return maskNotificationDestinations(config.destinations as NotificationDestination[]).meta;
};

/** The client view of the store, shared by every write and read so no response drops a field. */
const configView = (options: WebServerOptions) => {
  const resolved = options.configStore.resolveConfig();
  return {
    resolved: sanitizeConfigForClient(resolved),
    overrides: sanitizeConfigForClient(options.configStore.getAllOverrides()),
    sources: options.configStore.getSources?.() ?? {},
    secretsMeta: getSecretsMeta(resolved),
    destinationsMeta: getDestinationsMeta(resolved),
  };
};

export const handleConfigEndpoint = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): Promise<void> => {
  const log = options.logger ?? logger.child('web');

  if (method === 'GET') {
    return sendJson(res, 200, configView(options), { 'Cache-Control': 'no-store' });
  }

  if (method === 'POST') {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return;
    const payload: any = parsed.body;

    if (!isPlainJsonObject(payload)) {
      return sendJson(res, 400, { error: 'Payload must be a JSON object' });
    }

    const isKeyValueForm =
      typeof payload.key === 'string' && 'value' in payload && Object.keys(payload).length === 2;
    const isEnvelope =
      !isKeyValueForm && (Object.hasOwn(payload, 'set') || Object.hasOwn(payload, 'clear'));

    // Null-prototype target: a `__proto__` JSON key must stay an own key the validator can reject.
    const patchToValidate: Record<string, unknown> = Object.create(null);
    const keysToClear: string[] = [];

    if (isEnvelope) {
      const unexpected = Object.keys(payload).filter((k) => k !== 'set' && k !== 'clear');
      if (unexpected.length > 0) {
        return sendJson(res, 400, {
          error: `Unexpected fields in config write: ${unexpected.join(', ')}`,
        });
      }
      if (payload.set !== undefined && !isPlainJsonObject(payload.set)) {
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
        if (!isWritableConfigKey(key)) {
          return sendJson(res, 400, { error: `Unknown configuration key: ${key}` });
        }
        if (!keysToClear.includes(key)) keysToClear.push(key);
      }
      Object.assign(patchToValidate, payload.set ?? {});
    } else if (isKeyValueForm) {
      patchToValidate[payload.key] = payload.value;
    } else {
      Object.assign(patchToValidate, payload);
    }

    const keysToValidate: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(patchToValidate)) {
      if (isSecretKey(k) && (isSecretMask(v) || v === null || v === '')) {
        // A masked or cleared secret keeps its stored value, but the key still has to be real.
        if (!isWritableConfigKey(k)) {
          return sendJson(res, 400, { error: `Unknown configuration key: ${k}` });
        }
        continue;
      }
      keysToValidate[k] = v;
    }

    // An allowlist that parses to nothing denies every client, loopback included, and the override
    // outranks the env — so an unparseable entry is rejected instead of locking the operator out.
    for (const key of ['allowedIpRanges', 'trustedProxyRanges'] as const) {
      const rawRanges = keysToValidate[key];
      if (!Array.isArray(rawRanges)) continue;
      const bad = rawRanges.find((entry) => typeof entry !== 'string' || !isValidIpRange(entry));
      if (bad !== undefined) {
        return sendJson(res, 400, {
          error: `${key} entry is not a valid IP or CIDR: ${String(bad)}`,
        });
      }
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
      if (key === 'destinations' && Array.isArray(value)) {
        // The resolved list is decrypted and includes env-seeded instances, so a first UI save of a
        // destination that came from the environment still finds the secret its mask stands for.
        const stored = options.configStore.resolveConfig().destinations;
        options.configStore.setOverride(
          key,
          mergeDestinationSecrets(value as NotificationDestination[], stored)
        );
        return;
      }
      options.configStore.setOverride(key, value);
    };

    // Deletes first so an explicit `set` of the same key wins over its `clear`.
    for (const key of keysToClear) handleClear(key);

    for (const [k, v] of Object.entries(patchToValidate)) {
      handleSet(k, Object.hasOwn(validatedPatch, k) ? validatedPatch[k] : v);
    }

    const keys = typeof payload.key === 'string' ? [payload.key] : Object.keys(patchToValidate);
    const touched = [...keys, ...cleared];
    log.info('Configuration updated via Web API (keys: %s)', touched.join(', ') || 'none');
    return sendJson(res, 200, { success: true, ...configView(options), cleared });
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
  // An unknown or prototype key must never reach the settings store.
  if (!isWritableConfigKey(decodedKey)) {
    return sendJson(res, 400, { error: `Unknown configuration key: ${decodedKey}` });
  }
  options.configStore.deleteOverride(decodedKey);
  log.info('Configuration override deleted via Web API: %s', decodedKey);
  return sendJson(res, 200, { success: true, ...configView(options) });
};
