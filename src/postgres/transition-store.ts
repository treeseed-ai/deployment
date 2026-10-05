import { closeSync, constants, fsyncSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { deploymentDigest, postgresTransitionSelectionSchema, type PostgresTransitionSelection } from '@treeseed/sdk/deployment';
import { LocalSecretCustody } from '../security/custody/local.js';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u), id = z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/u);
const bindingSchema = z.object({
  componentId: id, requirementId: id, sourceRuntimeDigest: digest, targetRuntimeDigest: digest,
  topologyDigest: digest, planDigest: digest, intentDigest: digest,
  state: z.enum(['switched', 'accepted']), version: z.union([z.literal(1), z.literal(2)]),
}).strict().refine(value => value.version === (value.state === 'switched' ? 1 : 2));
export type PostgresTransferBinding = z.infer<typeof bindingSchema>;

/** Root-owned, covered by the PostgreSQL lifecycle backup allocation. All
 * operations run under the existing transfer OS lock. Coordinated restore, not
 * a stale writer or an automatic fallback, reverses a switched binding. */
export class PostgresTransitionStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 }); new LocalSecretCustody(root);
  }
  private read<T>(name: string, schema: z.ZodType<T>): T | null {
    new LocalSecretCustody(this.root);
    let fd: number;
    try { fd = openSync(join(this.root, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Unsafe PostgreSQL transition custody'); }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 16384) throw new Error();
      return schema.parse(JSON.parse(readFileSync(fd, 'utf8')));
    } catch { throw new Error('Invalid PostgreSQL transition record; coordinated recovery required'); }
    finally { closeSync(fd); }
  }
  private write(name: string, record: unknown) {
    new LocalSecretCustody(this.root);
    const temporary = join(this.root, `.transition-${randomUUID()}.new`);
    try {
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, join(this.root, name));
      const directory = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally { rmSync(temporary, { force: true }); }
  }
  preparation(selectionDigest: string) {
    const value = this.read(`selection-${digest.parse(selectionDigest).slice(7)}.json`, postgresTransitionSelectionSchema);
    if (value && deploymentDigest(value) !== selectionDigest) throw new Error('PostgreSQL transition selection changed');
    return value;
  }
  prepare(input: unknown) {
    const value = postgresTransitionSelectionSchema.parse(input), selectionDigest = deploymentDigest(value);
    const existing = this.preparation(selectionDigest);
    if (!existing) this.write(`selection-${selectionDigest.slice(7)}.json`, value);
    return { action: existing ? 'noop' as const : 'prepared' as const, selectionDigest };
  }
  selected(input: Omit<PostgresTransitionSelection, 'allowLocaleConversion'>) {
    const choices = [false, true].map(allowLocaleConversion => this.preparation(deploymentDigest({ ...input, allowLocaleConversion }))).filter(value => value !== null);
    if (choices.length !== 1) throw new Error('One exact PostgreSQL transition selection required');
    return choices[0]!;
  }
  binding(componentId: string) { return this.read(`binding-${id.parse(componentId)}.json`, bindingSchema); }
  switch(input: Omit<PostgresTransferBinding, 'version' | 'state'>) {
    const value = bindingSchema.parse({ ...input, version: 1, state: 'switched' });
    const existing = this.binding(value.componentId);
    if (existing) throw new Error('PostgreSQL binding compare-and-swap conflict; retain coordinated recovery');
    this.write(`binding-${value.componentId}.json`, value);
    return { bindingDigest: deploymentDigest(value) };
  }
  accept(componentId: string, expectedDigest: string) {
    digest.parse(expectedDigest);
    const existing = this.binding(componentId);
    if (!existing || existing.state !== 'switched' || deploymentDigest(existing) !== expectedDigest)
      throw new Error('PostgreSQL binding compare-and-swap conflict; retain coordinated recovery');
    const value = bindingSchema.parse({ ...existing, state: 'accepted', version: 2 });
    this.write(`binding-${componentId}.json`, value);
    return { bindingDigest: deploymentDigest(value) };
  }
}
