import { describe, expect, it } from 'vitest';
import { subscriptionResultQuarantine } from '../src/sandbox/runtime.js';

const secret = 'synthetic-private-credential-value';
describe('subscription result quarantine diagnosis', () => {
  it.each(['access_token', 'refresh_token', 'id_token', 'account_id'])('keeps %s fingerprint rejection with static response diagnosis', field => {
    expect(subscriptionResultQuarantine(JSON.stringify({ responseMarkdown: secret }), { tokens: { [field]: secret } }))
      .toEqual({ credentialField: field, resultSection: 'responseMarkdown' });
  });
  it('classifies raw diagnostic events without returning the credential or dynamic payload keys', () => {
    const result = subscriptionResultQuarantine(JSON.stringify({ diagnostics: { providerEvents: [{ item: { output: secret } }] } }),
      { tokens: { [secret]: secret } });
    expect(result).toEqual({ credentialField: 'other', resultSection: 'diagnostics.providerEvents' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('retains fail-closed matching for malformed result JSON and short-value policy', () => {
    expect(subscriptionResultQuarantine(`invalid ${secret}`, { tokens: { access_token: secret } }))
      .toEqual({ credentialField: 'access_token', resultSection: 'other' });
    expect(subscriptionResultQuarantine('short value', { tokens: { access_token: 'short' } })).toBeNull();
  });
  it('passes clean results without modifying content or accepting malformed credentials', () => {
    const result = JSON.stringify({ responseMarkdown: 'Public response', diagnostics: { providerEvents: [] } });
    expect(subscriptionResultQuarantine(result, { tokens: { access_token: secret } })).toBeNull();
    expect(subscriptionResultQuarantine(result, { tokens: null })).toBeNull();
    expect(result).toContain('Public response');
  });
});
