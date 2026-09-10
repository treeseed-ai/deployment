import { closeSync, constants, existsSync, fsyncSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocalSecretCustody } from '../security/custody/local.js';
import { withOsCustodyLock } from '../security/custody/os-lock.js';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const transferJournalSchema = z.object({
  schemaVersion: z.literal('treeseed.postgres-transfer-journal/v1'),
  intentDigest: digest, restoreGeneration: z.number().int().positive(), restoreDigest: digest,
  stage: z.enum(['fencing', 'export', 'restore', 'verify', 'switch', 'activate', 'accepted', 'recovery-required', 'rolled-back']),
  archiveDigest: digest.optional(),
}).strict();
export type TransferJournal = z.infer<typeof transferJournalSchema>;

function durableJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.new`;
  try {
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/** Root-owned transaction history survives manager/process restart. The active
 * marker must live outside replaceable application/manager backup state. There
 * is no stale-PID or wall-clock bypass. Methods run under the same OS lock.
 */
export class PostgresTransferJournal {
  constructor(readonly root: string, readonly marker = join(root, 'active.json')) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    new LocalSecretCustody(root);
  }
  async locked<T>(run: () => Promise<T>): Promise<T> { return withOsCustodyLock(this.root, run); }
  private read(path: string): TransferJournal | null {
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Unsafe PostgreSQL transfer journal'); }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 4096) throw new Error();
      return transferJournalSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
    } catch { throw new Error('Invalid PostgreSQL transfer journal; recovery required'); }
    finally { closeSync(fd); }
  }
  private path(intentDigest: string) { return join(this.root, `${digest.parse(intentDigest).slice(7)}.json`); }
  active() { return this.read(this.marker); }
  accepted(intentDigest: string) { return this.read(this.path(intentDigest))?.stage === 'accepted'; }
  begin(input: Omit<TransferJournal, 'schemaVersion' | 'stage' | 'archiveDigest'>) {
    const record = transferJournalSchema.parse({ ...input, schemaVersion: 'treeseed.postgres-transfer-journal/v1', stage: 'fencing' });
    if (this.active() || this.read(this.path(record.intentDigest))) throw new Error('PostgreSQL transfer already recorded; explicit recovery required');
    // Marker is durable before any writer or database mutation.
    durableJson(this.marker, record);
    durableJson(this.path(record.intentDigest), record);
    return record;
  }
  advance(intentDigest: string, stage: TransferJournal['stage'], archiveDigest?: string) {
    const current = this.active();
    if (!current || current.intentDigest !== intentDigest) throw new Error('Exact active PostgreSQL transfer required');
    const phases = ['fencing', 'export', 'restore', 'verify', 'switch', 'activate', 'accepted'];
    if (stage !== 'recovery-required' && (current.stage === 'recovery-required' || phases.indexOf(stage) !== phases.indexOf(current.stage) + 1))
      throw new Error('Invalid PostgreSQL transfer phase');
    const record = transferJournalSchema.parse({ ...current, stage, ...(archiveDigest ? { archiveDigest } : {}) });
    if (['restore','verify','switch','activate','accepted'].includes(stage) && !record.archiveDigest) throw new Error('Verified archive identity required');
    durableJson(this.marker, record);
    durableJson(this.path(intentDigest), record);
    if (stage === 'accepted') this.clear();
    return record;
  }
  verifyRecovery(generation: number, sha256: string) {
    const active = this.active();
    if (!active || active.restoreGeneration !== generation || active.restoreDigest !== `sha256:${sha256}`)
      throw new Error('Exact coordinated PostgreSQL restore point required');
    return active;
  }
  restored(generation: number, sha256: string) {
    const active = this.verifyRecovery(generation, sha256);
    durableJson(this.path(active.intentDigest), { ...active, stage: 'rolled-back' });
    this.clear();
  }
  private clear() {
    unlinkSync(this.marker);
    const fd = openSync(dirname(this.marker), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
