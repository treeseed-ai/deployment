import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { prepareIdentityBootstrap } from '../../dist/src/identity/bootstrap.js';

export function verifyIdentityBootstrap(root: string) {
  if (process.getuid?.() !== 0 || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable root acceptance required');
  const ca = join(root, 'identity-ca'); mkdirSync(ca, { mode: 0o700 });
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=disposable-authority',
    '-keyout', join(ca, 'key'), '-out', join(ca, 'cert')], { stdio: 'ignore' });
  const options = { stateRoot: join(root, '.treeseed/data/identity'), runtimeRoot: join(root, 'identity-runtime'), publicUrl: 'https://identity.example.test',
    environment: 'staging' as const, certificateAuthority: join(ca, 'cert'), certificateAuthorityKey: join(ca, 'key') };
  assert.equal(prepareIdentityBootstrap(options).configured, true);
  const key = join(options.runtimeRoot, 'tls/key.pem'), before = readFileSync(key);
  assert.equal(lstatSync(key).uid, 1000); assert.equal(lstatSync(key).mode & 0o777, 0o400);
  const store = join(options.stateRoot, 'identity-os');
  const records = readdirSync(store).filter(name => name.endsWith('.enc'));
  assert.equal(records.length, 1);
  const encrypted = readFileSync(join(store, records[0]!));
  assert.equal(encrypted.includes(Buffer.from('PRIVATE KEY')), false);
  assert.equal(prepareIdentityBootstrap(options).configured, true);
  assert.deepEqual(readFileSync(key), before);
  assert.deepEqual(readFileSync(join(store, records[0]!)), encrypted);
  const cert = new X509Certificate(readFileSync(join(options.runtimeRoot, 'tls/cert.pem')));
  assert.equal(cert.checkHost('identity'), 'identity');
  assert.ok(cert.checkHost('identity.example.test'));
  assert.ok(cert.verify(new X509Certificate(readFileSync(join(ca, 'cert'))).publicKey));
  const realm = JSON.parse(readFileSync(join(options.runtimeRoot, 'import/treeseed-realm.json'), 'utf8'));
  assert.equal(realm.users.length, 1); assert.equal(realm.users[0].credentials, undefined);
  assert.throws(() => prepareIdentityBootstrap({ ...options, environment: 'production' }));
  assert.throws(() => prepareIdentityBootstrap({ ...options, publicUrl: 'https://different.example.test' }));
  before.fill(0);
}
