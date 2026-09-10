import { createHash, hkdfSync } from 'node:crypto';
import { closeSync, constants, createReadStream, createWriteStream, fsyncSync, fstatSync, linkSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LocalSecretCustody } from '../security/custody/local.js';
import { decryptBackupStream, encryptBackupStream } from '../supervisor/backup-stream.js';
import type { PostgresTransferArchive } from './transfer.js';
import { postgresProcessReason, PostgresProcessFailure } from './transfer-diagnostic.js';

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const domain = 'treeseed.postgres-logical-transfer/v1';

function archiveKey(root: string, intentDigest: string, backupKey: Buffer) {
  new LocalSecretCustody(root); // Same owner/ancestor policy as existing custody.
  if (!digestPattern.test(intentDigest) || backupKey.length !== 32) throw new Error();
  return Buffer.from(hkdfSync('sha256', backupKey, Buffer.from(domain), Buffer.from(intentDigest), 32));
}
function location(root: string, intentDigest: string) {
  return join(root, `${intentDigest.slice(7)}.pgdump.enc`);
}
async function checksum(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}
function syncFile(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Internal trusted stream boundary. The supervisor owns pg_dump process
 * completion, writer fencing and exact custody; paths are never wire inputs.
 * Reuse the backup envelope with an intent-specific derived key. No new KEK.
 */
export async function writePostgresLogicalArchive(root: string, intentDigest: string, backupKey: Buffer,
  source: Readable, producerCompleted: Promise<void>): Promise<PostgresTransferArchive> {
  let key: Buffer | undefined, temporary: string | undefined;
  source.on('error', () => undefined); // Validation may fail before pipeline attaches.
  // Observe producer failure immediately, including validation failures below.
  const completion = producerCompleted.catch(() => { source.destroy(new Error('Logical export failed')); throw new Error('Logical export failed'); });
  void completion.catch(() => undefined);
  try {
    key = archiveKey(root, intentDigest, backupKey);
    temporary = mkdtempSync(join(root, '.logical-export-'));
    const encrypted = join(temporary, 'archive.enc');
    await Promise.all([encryptBackupStream(source, encrypted, 1, key), completion]);
    syncFile(encrypted);
    const digest = await checksum(encrypted);
    // link is exclusive, unlike rename: an existing archive is never replaced.
    linkSync(encrypted, location(root, intentDigest));
    rmSync(encrypted);
    syncFile(root);
    return { digest, intentDigest, encrypted: true };
  } catch { throw new Error('PostgreSQL encrypted export failed; source retained.'); }
  finally {
    source.destroy(); key?.fill(0);
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

/** Snapshot ciphertext, authenticate it completely, then and only then open a
 * restore consumer. The same private snapshot feeds the second pass, preventing
 * replacement of the original path between inspection and restoration.
 */
export async function restorePostgresLogicalArchive(root: string, intentDigest: string, backupKey: Buffer,
  archive: PostgresTransferArchive, destination: () => Promise<{ input: Writable; completed: Promise<void> }>) {
  let key: Buffer | undefined, temporary: string | undefined, fd: number | undefined;
  let processFailure: PostgresProcessFailure | undefined;
  try {
    key = archiveKey(root, intentDigest, backupKey);
    if (archive.intentDigest !== intentDigest || archive.encrypted !== true || !digestPattern.test(archive.digest)) throw new Error();
    fd = openSync(location(root, intentDigest), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error();
    temporary = mkdtempSync(join(root, '.logical-restore-'));
    const snapshot = join(temporary, 'archive.enc');
    await pipeline(createReadStream('', { fd, autoClose: false }), createWriteStream(snapshot, { flags: 'wx', mode: 0o600 }));
    closeSync(fd); fd = undefined;
    if (await checksum(snapshot) !== archive.digest) throw new Error();
    await decryptBackupStream(snapshot, 1, key, new Writable({ write(chunk: Buffer, _encoding, done) { chunk.fill(0); done(); } }));
    const target = await destination();
    const completion = target.completed.catch((error: unknown) => {
      const reason = postgresProcessReason(error);
      if (reason) processFailure = new PostgresProcessFailure(reason);
      target.input.destroy(new Error('Logical restore failed')); throw new Error('Logical restore failed');
    });
    try { await Promise.all([decryptBackupStream(snapshot, 1, key, target.input), completion]); }
    finally { target.input.destroy(); await completion.catch(() => undefined); }
    return { restored: true as const, intentDigest, archiveDigest: archive.digest };
  } catch { throw processFailure ?? new Error('PostgreSQL authenticated restore failed; explicit recovery required.'); }
  finally {
    if (fd !== undefined) closeSync(fd);
    key?.fill(0);
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
