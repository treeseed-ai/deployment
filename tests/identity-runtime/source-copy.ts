import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { component, host } from '../fixtures.js';
import { backupArchiveArguments } from '../../dist/src/supervisor/backup.js';
import { encryptBackupStream } from '../../dist/src/supervisor/backup-stream.js';
import { stagePostgresBackup } from '../../dist/src/supervisor/postgres-backup-stage.js';
import { withPostgresSourceCopy } from '../../dist/src/supervisor/postgres-source-copy.js';
import { withAttestedPostgresSource } from '../../dist/src/postgres/source-session.js';

if (process.env.GITHUB_ACTIONS !== 'true' || process.getuid?.() !== 0) throw new Error('Disposable root Actions acceptance required');
const id = `pgcopy-${randomBytes(8).toString('hex')}`, root = mkdtempSync(join(tmpdir(), 'treeseed-pgcopy-'));
const member = `var/lib/treeseed/components/${id}/postgres`, state = `/${member}`, key = randomBytes(32);
const image = process.env.TREESEED_POSTGRES_SOURCE === 'alpine'
  ? 'postgres:17.11-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
  : 'postgres:16-bookworm@sha256:bb3e1a57e5407e0a5280b4211980a5e537f4abd234a87014ac979849a78dd825';
const docker = async (args: string[]) => execFileSync('/usr/bin/docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 1048576 }).trim();
let created = false, stage = 'original-start';
try {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  await docker(['run', '-d', '--name', id, '--network', 'none', '--label', `com.docker.compose.project=treeseed-${id}`,
    '--label', 'com.docker.compose.service=database', '--mount', `type=bind,source=${state},target=/var/lib/postgresql/data`,
    '-e', 'POSTGRES_DB=application', '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image]);
  created = true;
  stage = 'original-ready';
  for (let i = 0; ; i++) {
    try {
      // pg_isready also succeeds against the entrypoint's temporary init server
      // before the application database exists. Wait for the final PID1 server.
      assert.equal(await docker(['exec', id, 'cat', '/proc/1/comm']), 'postgres');
      assert.equal(await docker(['exec', id, 'psql', '-XAt', '-U', 'postgres', '-d', 'application', '-c', 'SELECT 1']), '1');
      break;
    }
    catch { if (i >= 60) throw new Error('Original startup failed'); await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  stage = 'original-fixture';
  await docker(['exec', id, 'psql', '-X', '-U', 'postgres', '-d', 'application', '-v', 'ON_ERROR_STOP=1', '-c',
    "CREATE TABLE source_records(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,label text); INSERT INTO source_records(label) VALUES('preserved'),('雪');"]);
  stage = 'original-stop';
  await docker(['stop', '--time', '30', id]);
  const originalControl = createHash('sha256').update(readFileSync(join(state, 'global/pg_control'))).digest('hex');
  stage = 'encrypted-backup';
  const release = component(id, 'development', 'a'), configuration = host();
  configuration.components = { [id]: { ...configuration.components.api! } };
  release.runtime.services[0]!.composeService = 'database';
  release.runtime.stateVolumes = [{ id: 'postgres', volume: state, backup: 'required' }];
  release.runtimeDigest = deploymentDigest(release.runtime);
  release.images = [{ role: 'postgres', repository: 'postgres', digest: image.split('@')[1]!, platforms: ['linux/amd64'], consumers: [id] }];
  const source = join(root, 'archive-source'); mkdirSync(join(source, dirname(member)), { recursive: true });
  execFileSync('/usr/bin/cp', ['--archive', '--reflink=auto', state, join(source, member)], { stdio: 'ignore' });
  for (const directory of ['etc/treeseed', 'var/lib/treeseed/manager']) mkdirSync(join(source, directory), { recursive: true });
  const generation = 7, configMember = `var/lib/treeseed/manager/backup-configuration-${generation}.json`;
  writeFileSync(join(source, configMember), JSON.stringify(configuration));
  writeFileSync(join(source, 'etc/treeseed/never-extract'), 'not-database-data');
  writeFileSync(join(source, 'var/lib/treeseed/manager/active-components.json'), JSON.stringify([release]));
  writeFileSync(join(source, 'var/lib/treeseed/manager/current-receipt.json'), JSON.stringify({ receiptId: 'accepted', configurationDigest: deploymentDigest(configuration) }));
  const archive = join(root, `generation-${generation}.tar.gz.enc`);
  const tar = spawn('/usr/bin/tar', backupArchiveArguments(configMember, ['etc/treeseed', configMember,
    'var/lib/treeseed/manager/active-components.json', 'var/lib/treeseed/manager/current-receipt.json', member], source), { stdio: ['ignore', 'pipe', 'ignore'] });
  const [exit] = await Promise.all([once(tar, 'exit'), encryptBackupStream(tar.stdout!, archive, generation, key)]);
  assert.equal(exit[0], 0);
  const digest = execFileSync('/usr/bin/sha256sum', [archive], { encoding: 'utf8' }).split(' ')[0]!;
  writeFileSync(`${archive}.sha256`, `${digest}  generation-${generation}.tar.gz.enc\n`);
  stage = 'source-copy';
  const staged = await stagePostgresBackup(generation, { backupRoot: root, stagingRoot: join(root, 'staging'), key,
    backupDigest: `sha256:${digest}`, componentId: id, checkOriginalStopped: () => {
      assert.equal(execFileSync('/usr/bin/docker', ['inspect', '--format', '{{.State.Running}}', id], { encoding: 'utf8' }).trim(), 'false');
    } });
  assert.equal(existsSync(join(staged.directory, 'etc')), false);
  let helper = '';
  await withPostgresSourceCopy(staged, 'database', docker, async source => {
    helper = source.container;
    assert.equal(await docker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', helper]), 'none');
    assert.equal(await docker(['inspect', '--format', '{{.HostConfig.ReadonlyRootfs}}', helper]), 'true');
    await withAttestedPostgresSource(source, docker, async session => {
      assert.deepEqual((await session.query('SELECT label FROM public.source_records ORDER BY id')).rows.map(row => row.label), ['preserved', '雪']);
      await assert.rejects(session.query("INSERT INTO public.source_records(label) VALUES('denied')"));
    });
  });
  stage = 'retention';
  await assert.rejects(docker(['inspect', helper]));
  assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', id]), 'false');
  assert.equal(createHash('sha256').update(readFileSync(join(state, 'global/pg_control'))).digest('hex'), originalControl);
  console.log(JSON.stringify({ ok: true, checks: ['authenticated-scoped-copy', 'bookworm-alpine-source-helper', 'no-helper-network',
    'nonroot-readonly-container', 'attested-local-readonly-session', 'source-never-restarted', 'original-control-file-unchanged', 'helper-removed'] }));
} catch { console.error(JSON.stringify({ ok: false, stage })); process.exitCode = 1; }
finally {
  key.fill(0);
  if (created) await docker(['rm', '--force', id]);
  rmSync(`/var/lib/treeseed/components/${id}`, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
