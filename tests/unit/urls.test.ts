import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isHttpUrl } from '../../src/shared/urls.js';

describe('Shared: isHttpUrl', () => {
  it('accepts only web URLs', () => {
    assert.equal(isHttpUrl('https://github.com/OtterBoops/agylity/pull/7'), true);
    assert.equal(isHttpUrl('http://127.0.0.1:8484/x'), true);
    assert.equal(isHttpUrl('  https://example.com  '), true);
  });

  it('refuses every scheme that would execute or read locally', () => {
    for (const value of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      'ftp://example.com/x',
      '//evil.example/x',
      '/relative/path',
      'not a url',
      '',
      '   ',
    ]) {
      assert.equal(isHttpUrl(value), false, value);
    }
  });

  it('refuses anything that is not a string', () => {
    for (const value of [undefined, null, 42, {}, [], true]) {
      assert.equal(isHttpUrl(value), false, String(value));
    }
  });
});
