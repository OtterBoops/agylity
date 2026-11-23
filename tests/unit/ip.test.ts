import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { normalizeIp, isIpAllowed, isLoopbackIp, extractClientIp } from '../../src/web/ip.js';

describe('Application-Native IP Whitelisting Engine (ip.ts)', () => {
  describe('normalizeIp', () => {
    it('preserves native IPv4 and IPv6', () => {
      assert.equal(normalizeIp('10.0.0.1'), '10.0.0.1');
      assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1');
    });

    it('rewrites a hex-pair mapped tail to a dotted quad instead of slicing it blindly', () => {
      assert.equal(normalizeIp('::ffff:7f00:1'), '127.0.0.1');
      assert.equal(normalizeIp('::ffff:c0a8:0101'), '192.168.1.1');
      assert.equal(normalizeIp('::ffff:192.168.1.1'), '192.168.1.1');
    });
  });

  describe('isIpAllowed (Off by Default Invariant)', () => {
    it('returns true when allowedRanges is empty array', () => {
      assert.equal(isIpAllowed('1.2.3.4', []), true);
      assert.equal(isIpAllowed('192.168.1.1', []), true);
      assert.equal(isIpAllowed('1.2.3.4', undefined), true);
    });

    it('rejects malformed client IPs when whitelist is active', () => {
      assert.equal(isIpAllowed('not-an-ip', ['192.168.1.0/24']), false);
      // An empty peer address is neither allowlisted nor loopback, so it fails closed.
      assert.equal(isIpAllowed('', ['127.0.0.0/8', '::1/128']), false);
      assert.equal(isLoopbackIp(''), false);
    });
  });

  describe('IPv4 Exact & CIDR Matching', () => {
    it('matches an exact IPv4 address in both bare and /32 form', () => {
      const cases = [
        {
          whitelist: ['198.51.100.42', '127.0.0.1'],
          allowed: ['198.51.100.42', '127.0.0.1'],
          blocked: ['198.51.100.43', '10.0.0.1'],
        },
        {
          whitelist: ['198.51.100.42/32'],
          allowed: ['198.51.100.42'],
          blocked: ['198.51.100.41'],
        },
      ];
      for (const { whitelist, allowed, blocked } of cases) {
        for (const ip of allowed) {
          assert.equal(isIpAllowed(ip, whitelist), true, `${ip} should match ${whitelist}`);
        }
        for (const ip of blocked) {
          assert.equal(isIpAllowed(ip, whitelist), false, `${ip} should not match ${whitelist}`);
        }
      }
    });

    it('matches IPv4 /16 and /24 CIDR subnets', () => {
      const whitelist = ['192.168.0.0/16', '10.50.0.0/24'];
      assert.equal(isIpAllowed('192.168.1.1', whitelist), true);
      assert.equal(isIpAllowed('192.168.254.254', whitelist), true);
      assert.equal(isIpAllowed('10.50.0.1', whitelist), true);
      assert.equal(isIpAllowed('10.50.0.255', whitelist), true);

      assert.equal(isIpAllowed('192.169.1.1', whitelist), false);
      assert.equal(isIpAllowed('10.50.1.1', whitelist), false);
    });

    it('handles IPv4 /0 (match all)', () => {
      assert.equal(isIpAllowed('185.220.101.5', ['0.0.0.0/0']), true);
    });
  });

  describe('IPv6 Exact & CIDR Matching', () => {
    it('matches exact IPv6 address and loopback', () => {
      const whitelist = ['::1', '2001:db8::1'];
      assert.equal(isIpAllowed('::1', whitelist), true);
      assert.equal(isIpAllowed('2001:db8::1', whitelist), true);
      assert.equal(isIpAllowed('2001:db8::2', whitelist), false);
    });

    it('matches IPv6 CIDR prefix', () => {
      const whitelist = ['2001:db8::/32'];
      assert.equal(isIpAllowed('2001:db8:ffff::1', whitelist), true);
      assert.equal(isIpAllowed('2001:db9::1', whitelist), false);
    });

    it('matches IPv6 addresses with embedded IPv4 tails', () => {
      assert.equal(isIpAllowed('64:ff9b::1.2.3.4', ['64:ff9b::/96']), true);
      assert.equal(isIpAllowed('64:ff9b::1.2.3.4', ['64:ff9b:0:0:0:0:102:304']), true);
      assert.equal(isIpAllowed('64:ff9b:0:0:0:0:102:304', ['64:ff9b::1.2.3.4']), true);
      assert.equal(isIpAllowed('64:ff9b::1.2.3.5', ['64:ff9b::1.2.3.4']), false);

      assert.equal(isIpAllowed('2001:db8::1.2.3.4', ['2001:db8::/32']), true);
      assert.equal(isIpAllowed('2001:db8:0:0:0:0:1.2.3.4', ['2001:db8::1.2.3.4']), true);
      assert.equal(isIpAllowed('2001:db8::1:1.2.3.4', ['2001:db8::1:102:304']), true);
      assert.equal(isIpAllowed('::1.2.3.4', ['::102:304']), true);
    });
  });

  describe('extractClientIp', () => {
    const makeReq = (
      headers: Record<string, string>,
      remoteAddress = '127.0.0.1'
    ): http.IncomingMessage =>
      ({
        headers,
        socket: { remoteAddress },
      }) as unknown as http.IncomingMessage;

    const makeAddrlessReq = (headers: Record<string, string>): http.IncomingMessage =>
      ({ headers, socket: {} }) as unknown as http.IncomingMessage;

    it('uses socket.remoteAddress by default when trustedProxies is false', () => {
      const req = makeReq(
        {
          'cf-connecting-ip': '203.0.113.195',
          'x-forwarded-for': '198.51.100.22',
        },
        '172.18.0.1'
      );
      assert.equal(extractClientIp(req, false), '172.18.0.1');
    });

    it('fails closed with an empty peer when the socket has no remote address', () => {
      const req = makeAddrlessReq({
        'cf-connecting-ip': '198.51.100.42',
        'x-real-ip': '198.51.100.42',
        'x-forwarded-for': '198.51.100.42',
      });
      // A missing address must never be fabricated into loopback (auth exemption + proxy trust).
      assert.equal(extractClientIp(req, false), '');
      assert.equal(extractClientIp(req, true), '');
      assert.equal(isLoopbackIp(extractClientIp(req, false)), false);
    });

    it('prioritizes cf-connecting-ip when trustedProxies is true', () => {
      const req = makeReq(
        {
          'cf-connecting-ip': '198.51.100.42',
          'x-real-ip': '10.0.0.1',
          'x-forwarded-for': '10.0.0.2',
        },
        '127.0.0.1'
      );
      assert.equal(extractClientIp(req, true), '198.51.100.42');
    });

    it('prioritizes x-real-ip if cf-connecting-ip is missing', () => {
      const req = makeReq(
        {
          'x-real-ip': '198.51.100.42',
          'x-forwarded-for': '10.0.0.2',
        },
        '127.0.0.1'
      );
      assert.equal(extractClientIp(req, true), '198.51.100.42');
    });

    it('extracts the client from x-forwarded-for when the peer is a trusted proxy', () => {
      const req = makeReq({ 'x-forwarded-for': '198.51.100.42' }, '127.0.0.1');
      assert.equal(extractClientIp(req, true), '198.51.100.42');
    });

    it('IGNORES a client-supplied prefix in x-forwarded-for', () => {
      const req = makeReq(
        {
          'x-forwarded-for': '1.2.3.4, 198.51.100.42',
        },
        '127.0.0.1'
      );
      // The leftmost entry is attacker-controlled, so the rightmost untrusted hop wins.
      assert.equal(extractClientIp(req, true), '198.51.100.42');
    });

    it('ANTI-SPOOFING INVARIANT: a private-range peer is not a trusted proxy', () => {
      const req = makeReq(
        {
          'cf-connecting-ip': '198.51.100.42',
          'x-forwarded-for': '198.51.100.42',
        },
        '172.18.0.1'
      );
      // Any host on the LAN or a Docker bridge can forge these headers, so they are ignored.
      assert.equal(extractClientIp(req, true), '172.18.0.1');
    });

    it('normalizes ::ffff: in headers', () => {
      const req = makeReq(
        {
          'cf-connecting-ip': '::ffff:198.51.100.42',
        },
        '127.0.0.1'
      );
      assert.equal(extractClientIp(req, true), '198.51.100.42');
    });
  });
});
