import net from 'node:net';
import type http from 'node:http';

// Normalizes IPv4-mapped IPv6 addresses (e.g. ::ffff:192.168.1.1 -> 192.168.1.1).
export const normalizeIp = (ip: string): string => {
  const trimmed = ip.trim();
  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice(7);
  }
  return trimmed;
};

const ipv4ToBigInt = (ip: string): bigint | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let res = 0n;
  for (const part of parts) {
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255) return null;
    res = (res << 8n) | BigInt(num);
  }
  return res;
};

const ipv6ToBigInt = (ip: string): bigint | null => {
  // Handle mixed IPv4-in-IPv6 if present
  const lastColon = ip.lastIndexOf(':');
  if (lastColon !== -1 && ip.slice(lastColon + 1).includes('.')) {
    const ipv4Part = ip.slice(lastColon + 1);
    const v4Num = ipv4ToBigInt(ipv4Part);
    if (v4Num === null) return null;
    const v6Prefix = ip.slice(0, lastColon);
    const highPart = ((v4Num >> 16n) & 0xffffn).toString(16);
    const lowPart = (v4Num & 0xffffn).toString(16);
    ip = `${v6Prefix}:${highPart}:${lowPart}`;
  }

  const doubleColonIdx = ip.indexOf('::');
  let segments: string[] = [];

  if (doubleColonIdx !== -1) {
    const leftStr = ip.slice(0, doubleColonIdx);
    const rightStr = ip.slice(doubleColonIdx + 2);
    const left = leftStr ? leftStr.split(':') : [];
    const right = rightStr ? rightStr.split(':') : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    segments = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    segments = ip.split(':');
  }

  if (segments.length !== 8) return null;

  let res = 0n;
  for (const seg of segments) {
    if (!seg || seg.length > 4) return null;
    const num = Number.parseInt(seg, 16);
    if (Number.isNaN(num) || num < 0 || num > 0xffff) return null;
    res = (res << 16n) | BigInt(num);
  }
  return res;
};

/** Strict decimal prefix. An empty string, a hex/exponent form or an out-of-range value is invalid. */
const parsePrefix = (prefixStr: string | null, maxBits: number): number | null => {
  if (prefixStr === null) return maxBits;
  if (!/^\d{1,3}$/.test(prefixStr)) return null;
  const prefix = Number(prefixStr);
  return prefix >= 0 && prefix <= maxBits ? prefix : null;
};

export interface ParsedSubnet {
  family: 'ipv4' | 'ipv6';
  network: bigint;
  mask: bigint;
}

export const parseSubnet = (entry: string): ParsedSubnet | null => {
  const clean = normalizeIp(entry.trim());
  if (!clean) return null;

  const slashIdx = clean.indexOf('/');
  const ipStr = slashIdx !== -1 ? clean.slice(0, slashIdx).trim() : clean;
  const prefixStr = slashIdx !== -1 ? clean.slice(slashIdx + 1).trim() : null;

  const ipFamily = net.isIP(ipStr);
  if (ipFamily === 0) return null;

  if (ipFamily === 4) {
    const ipNum = ipv4ToBigInt(ipStr);
    if (ipNum === null) return null;
    const prefix = parsePrefix(prefixStr, 32);
    if (prefix === null) return null;

    const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(32 - prefix);
    const network = ipNum & mask;
    return { family: 'ipv4', network, mask };
  }

  if (ipFamily === 6) {
    const ipNum = ipv6ToBigInt(ipStr);
    if (ipNum === null) return null;
    const prefix = parsePrefix(prefixStr, 128);
    if (prefix === null) return null;

    const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
    const network = ipNum & mask;
    return { family: 'ipv6', network, mask };
  }

  return null;
};

export const isIpInSubnet = (clientIp: string, subnet: ParsedSubnet): boolean => {
  const norm = normalizeIp(clientIp);
  const family = net.isIP(norm);
  if (family === 4 && subnet.family === 'ipv4') {
    const ipNum = ipv4ToBigInt(norm);
    if (ipNum === null) return false;
    return (ipNum & subnet.mask) === subnet.network;
  }
  if (family === 6 && subnet.family === 'ipv6') {
    const ipNum = ipv6ToBigInt(norm);
    if (ipNum === null) return false;
    return (ipNum & subnet.mask) === subnet.network;
  }
  return false;
};

export const isIpAllowed = (clientIp: string, allowedRanges?: string[]): boolean => {
  if (!allowedRanges || allowedRanges.length === 0) {
    return true; // Off by default: allow all
  }

  const norm = normalizeIp(clientIp);
  if (net.isIP(norm) === 0) {
    return false;
  }

  for (const raw of allowedRanges) {
    if (!raw || !raw.trim()) continue;
    const subnet = parseSubnet(raw);
    if (subnet && isIpInSubnet(norm, subnet)) {
      return true;
    }
  }

  return false;
};

/** Loopback only: a private-range peer is not a proxy, it is another host that can forge headers. */
export const DEFAULT_TRUSTED_PROXY_RANGES = ['127.0.0.0/8', '::1/128'];

export const isTrustedProxyPeer = (peerIp: string, customProxyRanges?: string[]): boolean => {
  const ranges =
    customProxyRanges && customProxyRanges.length > 0
      ? customProxyRanges
      : DEFAULT_TRUSTED_PROXY_RANGES;
  return isIpAllowed(peerIp, ranges);
};

// SECURITY: proxy headers are ignored unless the direct peer socket is a trusted proxy or loopback.
export const extractClientIp = (
  req: http.IncomingMessage,
  trustedProxies: boolean = false,
  trustedProxyRanges?: string[]
): string => {
  const peerIp = normalizeIp(req.socket?.remoteAddress || '127.0.0.1');

  if (trustedProxies) {
    if (isTrustedProxyPeer(peerIp, trustedProxyRanges)) {
      // Cloudflare edge connecting IP
      const cfIp = req.headers['cf-connecting-ip'];
      if (typeof cfIp === 'string' && cfIp.trim()) {
        const norm = normalizeIp(cfIp.trim());
        if (net.isIP(norm) !== 0) return norm;
      }

      // Direct Nginx / Caddy X-Real-IP
      const xRealIp = req.headers['x-real-ip'];
      if (typeof xRealIp === 'string' && xRealIp.trim()) {
        const norm = normalizeIp(xRealIp.trim());
        if (net.isIP(norm) !== 0) return norm;
      }

      // X-Forwarded-For is walked from the RIGHT, skipping trusted hops: a client-supplied
      // prefix must never be able to name its own address.
      const xForwardedFor = req.headers['x-forwarded-for'];
      if (typeof xForwardedFor === 'string' && xForwardedFor.trim()) {
        const hops = xForwardedFor
          .split(',')
          .map((h) => normalizeIp(h.trim()))
          .filter((h) => net.isIP(h) !== 0);
        for (let i = hops.length - 1; i >= 0; i--) {
          if (!isTrustedProxyPeer(hops[i]!, trustedProxyRanges)) return hops[i]!;
        }
        if (hops.length > 0) return hops[0]!;
      }
    }
  }

  return peerIp;
};
