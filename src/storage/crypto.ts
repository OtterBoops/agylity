import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const ENCRYPTION_PREFIX = 'enc:v1:';

export const SECRET_KEYS = new Set([
  'discordToken',
  'antigravityCsrfToken',
  'notificationWebhookUrl',
  'webhookSecret',
  'DISCORD_TOKEN',
  'ANTIGRAVITY_CSRF_TOKEN',
  'NOTIFICATION_WEBHOOK_URL',
  'WEBHOOK_SECRET',
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
  // 1. Explicit environment variable
  const envKey = process.env.AGYLITY_SECRET_KEY || process.env.ENCRYPTION_KEY;
  if (envKey && envKey.trim()) {
    const trimmed = envKey.trim();
    if (trimmed.length === 64 && /^[0-9a-fA-F]+$/.test(trimmed)) {
      return Buffer.from(trimmed, 'hex');
    }
    return createHash('sha256').update(trimmed, 'utf8').digest();
  }

  // 2. Persistent keyfile
  if (keyFilePath && keyFilePath !== ':memory:') {
    try {
      if (existsSync(keyFilePath)) {
        const raw = readFileSync(keyFilePath, 'utf8').trim();
        if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
          return Buffer.from(raw, 'hex');
        }
        return createHash('sha256').update(raw, 'utf8').digest();
      }

      const parentDir = dirname(keyFilePath);
      if (parentDir && parentDir !== '.' && !existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      const generatedKey = randomBytes(32);
      writeFileSync(keyFilePath, generatedKey.toString('hex'), {
        mode: 0o600,
        encoding: 'utf8',
      });
      return generatedKey;
    } catch {
      // Fallback to process-level key if filesystem is read-only or during ephemeral tests
    }
  }

  // 3. Process-level memory key fallback
  if (!processMemoryKey) {
    processMemoryKey = randomBytes(32);
  }
  return processMemoryKey;
};

export const encryptSecret = (plaintext: string, customKey?: Buffer): string => {
  if (!plaintext || typeof plaintext !== 'string') return plaintext;
  if (plaintext.startsWith(ENCRYPTION_PREFIX)) return plaintext;

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

  try {
    const parts = ciphertext.slice(ENCRYPTION_PREFIX.length).split(':');
    if (parts.length !== 3) return ciphertext;

    const [ivHex, tagHex, dataHex] = parts;
    const iv = Buffer.from(ivHex!, 'hex');
    const tag = Buffer.from(tagHex!, 'hex');
    const data = Buffer.from(dataHex!, 'hex');

    const key = customKey ?? resolveMasterKey();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);

    return decrypted.toString('utf8');
  } catch {
    // If decryption fails (e.g. key mismatch or corrupted cipher), safely return original
    return ciphertext;
  }
};

export const maskSecret = (val: unknown): string => {
  if (!val || typeof val !== 'string') return '';
  if (val.trim() === '') return '';
  return '••••••••';
};
