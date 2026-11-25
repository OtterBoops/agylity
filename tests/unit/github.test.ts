import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isGithubRemoteUrl, parseGithubSlugFromUrl } from '../../src/shared/github.js';

describe('Shared: GitHub remote parsing', () => {
  it('reads a slug from every git remote shape GitHub itself accepts', () => {
    assert.equal(
      parseGithubSlugFromUrl('https://github.com/OtterBoops/agylity'),
      'OtterBoops/agylity'
    );
    assert.equal(
      parseGithubSlugFromUrl('https://github.com/OtterBoops/agylity.git'),
      'OtterBoops/agylity'
    );
    assert.equal(
      parseGithubSlugFromUrl('https://github.com/OtterBoops/agylity/'),
      'OtterBoops/agylity'
    );
    assert.equal(
      parseGithubSlugFromUrl('https://github.com:443/OtterBoops/agylity'),
      'OtterBoops/agylity'
    );
    assert.equal(
      parseGithubSlugFromUrl('git@github.com:OtterBoops/agylity.git'),
      'OtterBoops/agylity'
    );
    assert.equal(
      parseGithubSlugFromUrl('ssh://git@github.com/OtterBoops/agylity.git'),
      'OtterBoops/agylity'
    );
    assert.equal(
      parseGithubSlugFromUrl('https://www.github.com/OtterBoops/agylity'),
      'OtterBoops/agylity'
    );
  });

  it('refuses a lookalike host or a path that only contains github.com', () => {
    assert.equal(parseGithubSlugFromUrl('https://notgithub.com/a/b'), undefined);
    assert.equal(parseGithubSlugFromUrl('https://gitlab.com/x/github.com/a/b'), undefined);
    assert.equal(parseGithubSlugFromUrl('https://github.com.evil.example/a/b'), undefined);
    assert.equal(parseGithubSlugFromUrl('https://github.company.com/a/b'), undefined);
    assert.equal(parseGithubSlugFromUrl('/repos/local/checkout'), undefined);
    assert.equal(parseGithubSlugFromUrl(undefined), undefined);
  });

  it('classifies a remote by its host alone', () => {
    assert.equal(isGithubRemoteUrl('https://github.com/OtterBoops/agylity.git'), true);
    assert.equal(isGithubRemoteUrl('git@github.com:OtterBoops/agylity.git'), true);
    assert.equal(isGithubRemoteUrl('https://github.com/OtterBoops/agylity/tree/main'), true);
    assert.equal(isGithubRemoteUrl('https://notgithub.com/a/b'), false);
    assert.equal(isGithubRemoteUrl('https://gitlab.com/x/github.com/a/b'), false);
    assert.equal(isGithubRemoteUrl(''), false);
    assert.equal(isGithubRemoteUrl(undefined), false);
  });
});
