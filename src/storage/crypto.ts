import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CANONICAL_SECRET_CONFIG_KEYS, SECRET_CONFIG_KEY_ENV_NAMES } from '../config/registry.js';
import { logger } from '../logs/logger.js';

export const ENCRYPTION_PREFIX = 'enc:v1:';

// An undecryptable enc:v1: value is fatal to callers, never a silently absent secret.
export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

const SECRET_KEYS = new Set<string>([
  ...CANONICAL_SECRET_CONFIG_KEYS,
  ...Object.values(SECRET_CONFIG_KEY_ENV_NAMES),
]);

export const isSecretKey = (key: string): boolean => {
  if (SECRET_KEYS.has(key)) return true;
  const lower = key.toLowerCase();
  return (
    lower.endsWith('token') ||
    lower.endsWith('secret') ||
    lower.endsWith('password') ||
    lower.endsWith('key') ||
    lower.includes('csrf') ||
    lower.includes('webhook_url') ||
    lower.includes('webhookurl')
  );
};

let processMemoryKey: Buffer | null = null;

export const resolveMasterKey = (keyFilePath = 'data/.agylity.key'): Buffer => {
  const envKey = process.env.AGYLITY_SECRET_KEY;
  if (envKey && envKey.trim()) {
    const trimmed = envKey.trim();
    if (trimmed.length === 64 && /^[0-9a-fA-F]+$/.test(trimmed)) {
      return Buffer.from(trimmed, 'hex');
    }
    return createHash('sha256').update(trimmed, 'utf8').digest();
  }

  // A configured keyfile path must never fall back to a per-process key, or every secret
  // encrypted with the real keyfile becomes undecryptable.
  if (keyFilePath && keyFilePath !== ':memory:') {
    if (existsSync(keyFilePath)) {
      let raw: string;
      try {
        raw = readFileSync(keyFilePath, 'utf8').trim();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger
          .child('crypto')
          .error('Secret key file is unreadable at %s: %s', keyFilePath, reason);
        throw new Error(
          `Unable to read the configured secret key file at ${keyFilePath}: ${reason}`
        );
      }
      // An empty key file must not degrade to sha256(''), a key anyone can recompute.
      if (raw.length === 0) {
        logger.child('crypto').error('Secret key file is empty at %s', keyFilePath);
        throw new Error(`The configured secret key file at ${keyFilePath} is empty`);
      }
      if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
        return Buffer.from(raw, 'hex');
      }
      return createHash('sha256').update(raw, 'utf8').digest();
    }

    const parentDir = dirname(keyFilePath);
    if (parentDir && parentDir !== '.' && !existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    // Write to a sibling temp file first so linkSync publishes only a complete 64-char key.
    const generatedKey = randomBytes(32);
    const tmpPath = `${keyFilePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(tmpPath, generatedKey.toString('hex'), {
        mode: 0o600,
        encoding: 'utf8',
        flag: 'wx',
      });
      linkSync(tmpPath, keyFilePath);
      return generatedKey;
    } catch (err) {
      // Another process won the creation race; a key of our own would encrypt secrets nothing can read.
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      return resolveMasterKey(keyFilePath);
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {}
    }
  }

  if (!processMemoryKey) {
    processMemoryKey = randomBytes(32);
  }
  return processMemoryKey;
};

export const encryptSecret = (plaintext: string, customKey?: Buffer): string => {
  if (!plaintext || typeof plaintext !== 'string') return plaintext;

  const key = customKey ?? resolveMasterKey();
  const iv = randomBytes(12); // Standard 96-bit IV for AES-GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTION_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
};

export const decryptSecret = (ciphertext: string, customKey?: Buffer): string => {
  if (!ciphertext || typeof ciphertext !== 'string') return ciphertext;
  if (!ciphertext.startsWith(ENCRYPTION_PREFIX)) return ciphertext;

  const parts = ciphertext.slice(ENCRYPTION_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new SecretDecryptionError(
      'Malformed encrypted secret: expected enc:v1:<iv>:<tag>:<data>'
    );
  }

  const [ivHex, tagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex!, 'hex');
  const tag = Buffer.from(tagHex!, 'hex');
  const data = Buffer.from(dataHex!, 'hex');

  try {
    const key = customKey ?? resolveMasterKey();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);

    return decrypted.toString('utf8');
  } catch (err) {
    throw new SecretDecryptionError(
      `Failed to decrypt an encrypted secret: ${err instanceof Error ? err.message : String(err)}`
    );
  }
};

export const SECRET_JSON_MARKER = '\u0000json:';

export const SECRET_MASK = '••••••••';

export const isSecretMask = (value: unknown): boolean =>
  value === SECRET_MASK || value === '********';

export const maskSecret = (val: unknown): string => {
  if (!val || typeof val !== 'string') return '';
  if (val.trim() === '') return '';
  return SECRET_MASK;
};
