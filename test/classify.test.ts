import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify, looksLikeAuthError } from '../src/runner.ts';

describe('classify', () => {
  it('succès sans erreur', () => {
    assert.equal(classify([], false), 'success');
  });

  it('token Claude expiré (message du plugin opencode)', () => {
    assert.equal(classify(['Error: Claude Code credentials are unavailable or expired. Run `claude` to refresh them.'], false), 'auth_error');
  });

  it('ProviderAuthError signalé par le serveur', () => {
    assert.equal(classify(['ProviderAuthError: whatever'], true), 'auth_error');
  });

  it('le rafraîchissement limité est une erreur passagère, pas un token à refaire', () => {
    assert.equal(classify(['AI_APICallError: Claude token refresh is rate-limited; retry shortly.'], false), 'error');
  });

  it('erreur ordinaire', () => {
    assert.equal(classify(['UnknownError: Model not found: anthropic/nope.'], false), 'error');
  });
});

describe('looksLikeAuthError', () => {
  for (const msg of ['HTTP 401 Unauthorized', 'invalid x-api-key', 'OAuth token has expired', 'please log in again']) {
    it(`reconnaît « ${msg} »`, () => {
      assert.equal(looksLikeAuthError(msg), true);
    });
  }
  it('ignore une erreur sans rapport', () => {
    assert.equal(looksLikeAuthError('ENOENT: no such file'), false);
  });
});
