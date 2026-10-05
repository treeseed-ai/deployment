import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { component, host } from './fixtures.js';
import { backupArchiveArguments } from '../src/supervisor/backup.js';
import { requiredBackupState } from '../src/supervisor/backup-coverage.js';
import { selectPostgresBackupState, stagePostgresBackup } from '../src/supervisor/postgres-backup-stage.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(nested = false, major = '17') {
  const root = mkdtempSync(join(tmpdir(), 'treeseed-postgres-copy-')); roots.push(root);
  const configuration = host(), id = nested ? 'ai-inference' : 'api', release = component(id, 'development', 'a');
  configuration.components[id] = { ...configuration.components.api! };
  if (nested) configuration.runtime = { management: 'managed', environment: 'development', dataRoot: '/var/lib/treeseed/development/.treeseed/data' };
  release.runtime.stateVolumes = [{ id: 'postgres', volume: `/var/lib/treeseed/components/${id}/${nested ? 'data/' : ''}postgres`, backup: 'required' }];
  release.runtimeDigest = deploymentDigest(release.runtime);
  const members = requiredBackupState(configuration, [release]), member = members[0]!, source = join(root, 'original');
  for (const directory of ['etc/treeseed', 'var/lib/treeseed/manager', member]) mkdirSync(join(source, directory), { recursive: true });
  writeFileSync(join(source, member, 'PG_VERSION'), major);
  writeFileSync(join(source, member, 'data-marker'), 'preserved-source');
  writeFileSync(join(source, 'etc/treeseed/platform.json'), JSON.stringify(configuration));
  writeFileSync(join(source, 'etc/treeseed/not-selected'), 'private-configuration');
  writeFileSync(join(source, 'var/lib/treeseed/manager/active-components.json'), JSON.stringify([release]));
  writeFileSync(join(source, 'var/lib/treeseed/manager/current-receipt.json'), JSON.stringify({ receiptId: 'accepted', configurationDigest: deploymentDigest(configuration) }));
  const generation = 7, configMember = `var/lib/treeseed/manager/backup-configuration-${generation}.json`;
  writeFileSync(join(source, configMember), JSON.stringify(configuration));
  const plaintext = execFileSync('/usr/bin/tar', backupArchiveArguments(configMember, ['etc/treeseed', 'var/lib/treeseed/manager/current-receipt.json', 'var/lib/treeseed/manager/active-components.json', configMember, ...members], source));
  const key = randomBytes(32), nonce = randomBytes(12);
  const header = { schemaVersion: 'treeseed.encrypted-backup/v1', algorithm: 'aes-256-gcm', keyId: 'application-backup-kek-v1', generation, nonce: nonce.toString('base64url'), createdAt: '2026-09-10T00:00:00.000Z' };
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(header).sort(([a], [b]) => a.localeCompare(b))))));
  const ciphertext = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const archive = join(root, `generation-${generation}.tar.gz.enc`), digest = createHash('sha256').update(ciphertext).digest('hex');
  writeFileSync(archive, ciphertext); writeFileSync(`${archive}.sha256`, `${digest}  generation-${generation}.tar.gz.enc\n`);
  const options = { backupRoot: root, stagingRoot: join(root, 'staging'), key, backupDigest: `sha256:${digest}`, componentId: id, checkOriginalStopped: vi.fn() };
  const inspection = { configuration, components: [release], coverage: { stateDirectories: members }, entries: [{ path: `${member}/`, type: 'Directory' }, { path: `${member}/PG_VERSION`, type: 'File' }] };
  return { root, source, member, generation, options, inspection, archive };
}
it.each([false, true])('extracts only the authenticated database copy (nested=%s)', async nested => {
  const f = fixture(nested), originalKey = Buffer.from(f.options.key);
  const staged = await stagePostgresBackup(f.generation, f.options);
  expect(readFileSync(join(staged.dataDirectory, 'data-marker'), 'utf8')).toBe('preserved-source');
  expect(existsSync(join(staged.directory, 'etc'))).toBe(false);
  expect(statSync(staged.directory).mode & 0o777).toBe(0o700);
  expect(f.options.checkOriginalStopped).toHaveBeenCalledTimes(2);
  expect(f.options.checkOriginalStopped).toHaveBeenCalledWith([f.member]);
  expect(f.options.key).toEqual(originalKey);
  writeFileSync(join(staged.dataDirectory, 'data-marker'), 'helper-only-change');
  expect(readFileSync(join(f.source, f.member, 'data-marker'), 'utf8')).toBe('preserved-source');
  expect(readdirSync(f.root).filter(name => name.startsWith('restore-'))).toEqual([]);
});
it.each(['digest', 'key', 'version', 'writer'] as const)('rejects %s failure without leaving copied state', async failure => {
  const f = fixture(false, failure === 'version' ? '18' : '17');
  if (failure === 'digest') f.options.backupDigest = `sha256:${'0'.repeat(64)}`;
  if (failure === 'key') f.options.key = randomBytes(32);
  if (failure === 'writer') f.options.checkOriginalStopped.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error('active'); });
  await expect(stagePostgresBackup(f.generation, f.options)).rejects.toThrow();
  expect(readdirSync(f.options.stagingRoot)).toEqual([]);
  expect(readdirSync(f.root).filter(name => name.startsWith('restore-'))).toEqual([]);
  expect(readFileSync(join(f.source, f.member, 'data-marker'), 'utf8')).toBe('preserved-source');
});
it.each(['SymbolicLink', 'Link', 'FIFO'])('rejects %s inside the selected database', type => {
  const f = fixture(); f.inspection.entries.push({ path: `${f.member}/escape`, type });
  expect(() => selectPostgresBackupState(f.inspection, 'api')).toThrow('unsupported');
});
it('rejects missing coverage, disabled components, and changed runtime digests', () => {
  const f = fixture(); f.inspection.coverage.stateDirectories = [];
  expect(() => selectPostgresBackupState(f.inspection, 'api')).toThrow('coverage');
  f.inspection.coverage.stateDirectories = [f.member]; f.inspection.configuration.components.api!.enabled = false;
  expect(() => selectPostgresBackupState(f.inspection, 'api')).toThrow('Enabled');
  f.inspection.configuration.components.api!.enabled = true; f.inspection.components[0]!.runtimeDigest = `sha256:${'0'.repeat(64)}`;
  expect(() => selectPostgresBackupState(f.inspection, 'api')).toThrow('digest');
});
