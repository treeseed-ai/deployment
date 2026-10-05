import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { apiIdentityFixture } from '../../tests/identity-api-fixture.js';
import { materializeApiIdentityRuntime } from '../../dist/src/supervisor/identity-api-files.js';
import { readOsCredentialFile } from '../../dist/src/security/custody/os-file.js';
import { prepareApiIdentityBootstrap } from '../../dist/src/identity/api-bootstrap.js';

/** Synthetic keys and exact scratch targets, only on a disposable root runner. */
export function verifyApiIdentityFiles() {
  if (process.getuid?.() !== 0 || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable privileged Actions acceptance required');
  const root = '/run/treeseed/identity-clients/api';
  const { configuration, release, descriptor } = apiIdentityFixture();
  const paths = Object.values(configuration.secrets).map(item => item.reference);
  assert.equal(existsSync(root), false);
  for (const path of paths) assert.equal(existsSync(path), false);
  try {
    assert.deepEqual(prepareApiIdentityBootstrap(configuration, release), { configured: true, applications: 1 });
    const descriptorPath = `${root}/runtime.json`;
    const first = lstatSync(descriptorPath);
    assert.equal(first.mode & 0o777, 0o400); assert.equal(first.uid, 65532);
    assert.equal(lstatSync('/run/treeseed/identity-clients').mode & 0o777, 0o700);
    const contents = readOsCredentialFile(descriptorPath);
    try { assert.deepEqual(JSON.parse(contents.toString()), descriptor); } finally { contents.fill(0); }
    assert.equal(materializeApiIdentityRuntime(configuration, release).action, 'noop');
    assert.equal(lstatSync(descriptorPath).ino, first.ino);
    const secret = `${root}/credentials/${descriptor.applications[0]!.signingKeyReference}`;
    const saved = readFileSync(secret);
    chmodSync(secret, 0o644);
    assert.throws(() => materializeApiIdentityRuntime(configuration, release), /materialization failed/);
    chmodSync(secret, 0o400);
    unlinkSync(secret); symlinkSync(descriptorPath, secret);
    assert.throws(() => materializeApiIdentityRuntime(configuration, release), /materialization failed/);
    unlinkSync(secret);
    assert.equal(materializeApiIdentityRuntime(configuration, release).action, 'materialized');
    assert.deepEqual(readFileSync(secret), saved); saved.fill(0);
    const unknown = `${root}/credentials/unmanaged`;
    writeFileSync(unknown, 'unmanaged-user-file', { mode: 0o600 });
    assert.throws(() => materializeApiIdentityRuntime(configuration, release), /materialization failed/);
    assert.equal(readFileSync(unknown, 'utf8'), 'unmanaged-user-file'); unlinkSync(unknown);
    descriptor.scopes.push('email');
    assert.equal(materializeApiIdentityRuntime(configuration, release).action, 'materialized');
    assert.equal(materializeApiIdentityRuntime(configuration, release).action, 'noop');
  } finally {
    for (const path of paths) if (existsSync(path)) unlinkSync(path);
    // This exact directory was asserted absent before the test created it.
    if (existsSync(root)) rmSync(root, { recursive: true });
  }
  return ['api-identity-real-os-custody', 'api-identity-mounted-file-permissions', 'api-identity-replay-noop',
    'api-identity-missing-file-recovery', 'api-identity-symlink-denial', 'api-identity-unmanaged-file-preserved'];
}
