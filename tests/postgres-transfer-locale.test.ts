import { expect, it } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { postgresLocaleConversionSchema, verifyPostgresTransferFingerprints } from '../src/postgres/transfer-locale.js';

const source = { encoding: 'UTF8', collate: 'en_US.utf8', ctype: 'en_US.utf8', provider: 'c', version: null, locale: null };
const destination = { ...source, version: '2.36' };
const policy = { method: 'logical-rebuild', source, destination };
const fingerprint = (locale: unknown) => ({ schemaDigest: deploymentDigest({ locale }), localeDigest: deploymentDigest(locale),
  definitionDigest: deploymentDigest('schema'), contentDigest: deploymentDigest('rows'), relationCount: 3 });
it('defaults to exact locale equality', () => {
  expect(verifyPostgresTransferFingerprints(fingerprint(source), fingerprint(source))).toBe(true);
  expect(verifyPostgresTransferFingerprints(fingerprint(source), fingerprint(destination))).toBe(false);
});
it('permits only the captured logical-rebuild locale transition', () => {
  expect(verifyPostgresTransferFingerprints(fingerprint(source), fingerprint(destination), policy)).toBe(true);
  expect(verifyPostgresTransferFingerprints(fingerprint(destination), fingerprint(source), policy)).toBe(false);
  expect(verifyPostgresTransferFingerprints(fingerprint(source), fingerprint({ ...destination, version: '2.41' }), policy)).toBe(false);
});
it.each(['definitionDigest', 'contentDigest', 'relationCount'] as const)('never waives %s drift', field => {
  const changed = { ...fingerprint(destination), [field]: field === 'relationCount' ? 4 : deploymentDigest('changed') };
  expect(verifyPostgresTransferFingerprints(fingerprint(source), changed, policy)).toBe(false);
});
it.each([{ encoding: 'LATIN1' }, { provider: 'i' }, { version: null }, { locale: 'en-US' }])('rejects unsupported target conversion %j', override => {
  expect(postgresLocaleConversionSchema.safeParse({ ...policy, destination: { ...destination, ...override } }).success).toBe(false);
});
it('binds conversion into the exact intent rather than a global bypass', () => {
  expect(deploymentDigest({ localeConversion: policy })).not.toBe(deploymentDigest({}));
  expect(deploymentDigest(policy)).not.toBe(deploymentDigest({ ...policy, destination: { ...destination, version: '2.41' } }));
});
