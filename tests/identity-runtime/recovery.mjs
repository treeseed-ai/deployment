// Disposable database recovery acceptance only, not a production backup backend.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function recoverIdentityDatabase({ server, database }) {
  for (const name of [server, database]) {
    if (!/^treeseed-identity-test-[a-f0-9]{12}-sovereign(?:-db)?$/.test(name)) throw new Error('Recovery requires owned disposable containers');
  }
  const command = (args, input) => execFileSync('docker', args, {
    input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
  });
  const sql = query => command(['exec', database, 'psql', '-U', 'identity', '-d', 'identity', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query]);
  command(['stop', server]);
  const before = sql('SELECT id, username, realm_id FROM user_entity ORDER BY id');
  let plaintext;
  let restored;
  const key = randomBytes(32), iv = randomBytes(12);
  try {
    plaintext = command(['exec', database, 'pg_dump', '-U', 'identity', '-d', 'identity', '--format=custom']);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const decrypt = ciphertext => {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    };
    const corrupt = Buffer.from(encrypted); corrupt[0] ^= 1;
    assert.throws(() => decrypt(corrupt));
    restored = decrypt(encrypted);
    assert.deepEqual(restored, plaintext);
    // Only the positively identified disposable database is replaced. Keycloak
    // is stopped, so the restore never runs beneath an active authentication writer.
    command(['exec', database, 'dropdb', '-U', 'identity', 'identity']);
    command(['exec', database, 'createdb', '-U', 'identity', '-O', 'identity', 'identity']);
    command(['exec', '-i', database, 'pg_restore', '-U', 'identity', '-d', 'identity', '--exit-on-error', '--single-transaction'], restored);
    assert.deepEqual(sql('SELECT id, username, realm_id FROM user_entity ORDER BY id'), before);
    command(['start', server]);
    return ['database-restore-preserves-user-subjects', 'corrupt-encrypted-backup-denied'];
  } finally {
    plaintext?.fill(0); restored?.fill(0); key.fill(0);
  }
}
