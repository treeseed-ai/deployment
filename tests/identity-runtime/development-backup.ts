import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { beginDevelopmentBackup, finishDevelopmentBackup, type DevelopmentBackupDependencies } from '../../dist/src/supervisor/development-backup.js';
import { assertNoBackupWriters } from '../../dist/src/supervisor/backup-writers.js';
import { encryptBackupStream, decryptBackupStream } from '../../dist/src/supervisor/backup-stream.js';
import { POSTGRES_IMAGE } from '../../dist/src/postgres/compose.js';
import type { ManagedDevelopmentSession } from '../../dist/src/manager/development-sessions.js';
import { component } from '../fixtures.js';

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable Actions acceptance required');
const root = mkdtempSync(join(tmpdir(), 'treeseed-backup-hold-'));
const sessionId = `dev-${randomBytes(8).toString('hex')}`, name = `treeseed-${sessionId}-api-operations-runner`;
const stranger = `${name}-unmanaged`, directory = join(root, sessionId, 'operations-runner'), data = join(root, 'data');
mkdirSync(directory, { recursive: true }); mkdirSync(data);
const key = randomBytes(32);
const docker = (args: readonly string[]) => execFileSync('/usr/bin/docker', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000, maxBuffer: 1_048_576 });
const compose = ['compose', '--project-name', name, '--file', join(directory, 'compose.json')];
const checks: string[] = [];
try {
  assert.equal(docker(['ps', '--all', '--filter', 'name=^/treeseed-api-operations-runner-1$', '--format', '{{.Names}}']).trim(), '', 'Disposable runner required');
  docker(['pull', '--quiet', POSTGRES_IMAGE]);
  const image = docker(['image', 'inspect', POSTGRES_IMAGE, '--format', '{{.Id}}']).trim();
  const spec = { services: { runtime: { image, container_name: name, init: true, network_mode: 'none',
    read_only: true, restart: 'no', cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
    user: `${process.getuid!()}:${process.getgid!()}`,
    labels: { 'org.treeseed.development.session': sessionId, 'org.treeseed.development.target': 'api.operations-runner' },
    entrypoint: ['/bin/sh', '-ec', "trap 'exit 0' TERM; while :; do date +%s%N > /data/tick; sleep 1 & wait $!; done"],
    volumes: [{ type: 'bind', source: data, target: '/data' }],
    healthcheck: { test: ['CMD', '/bin/sh', '-ec', 'test -s /data/tick'], interval: '1s', timeout: '1s', retries: 15 },
  } } };
  writeFileSync(join(directory, 'compose.json'), JSON.stringify(spec), { mode: 0o600 });
  writeFileSync(join(directory, 'runtime-receipt.json'), '{"fixture":"immutable-candidate"}', { mode: 0o600 });
  const api = component('api', 'development', 'a');
  const record = { session: { sessionId, status: 'active', targets: [{ projectId: 'api', targetId: 'operations-runner', mode: 'candidate' }] } } as ManagedDevelopmentSession;
  const deps: DevelopmentBackupDependencies = { command: (_executable, args) => docker(args), records: () => [record], components: () => [api],
    members: () => [data.slice(1)], holdPath: join(root, 'hold.json'), runtimeRoot: root, ownerUid: process.getuid!() };
  docker([...compose, 'up', '--detach', '--wait', '--wait-timeout', '30']);
  assert.throws(() => assertNoBackupWriters(deps.members(), docker), /Backup blocked/);
  checks.push('running candidate blocks raw backup');
  docker(['run', '--detach', '--name', stranger, '--network', 'none', '--read-only', '--mount', `type=bind,source=${data},target=/data`, '--entrypoint', '/bin/sleep', image, '300']);
  assert.throws(() => beginDevelopmentBackup(1, deps, api.runtimeDigest), /unmanaged/);
  assert.equal(existsSync(deps.holdPath), false);
  assert.equal(docker(['inspect', name, '--format', '{{.State.Running}}']).trim(), 'true');
  docker(['rm', '--force', stranger]); checks.push('unknown writer rejected before candidate interruption');
  beginDevelopmentBackup(1, deps, api.runtimeDigest);
  assertNoBackupWriters(deps.members(), docker);
  assert.ok(existsSync(join(directory, 'runtime-receipt.json')));
  assert.throws(() => beginDevelopmentBackup(2, deps, api.runtimeDigest), /interrupted/);
  const before = readFileSync(join(data, 'tick'));
  const encrypted = join(root, 'state.enc');
  await encryptBackupStream(createReadStream(join(data, 'tick')), encrypted, 1, key);
  const chunks: Buffer[] = [];
  await decryptBackupStream(encrypted, 1, key, new Writable({ write(chunk: Buffer, _encoding, next) { chunks.push(Buffer.from(chunk)); next(); } }));
  assert.deepEqual(Buffer.concat(chunks), before);
  assert.deepEqual(readFileSync(join(data, 'tick')), before);
  checks.push('drained snapshot remains unchanged through encrypted capture/read-back');
  assert.equal(finishDevelopmentBackup(1, deps).resumed, true);
  assert.equal(docker(['inspect', name, '--format', '{{.State.Health.Status}}']).trim(), 'healthy');
  assert.throws(() => assertNoBackupWriters(deps.members(), docker), /Backup blocked/);
  assert.equal(record.session.targets[0]!.mode, 'candidate');
  beginDevelopmentBackup(2, deps, api.runtimeDigest); finishDevelopmentBackup(2, deps);
  assert.equal(docker(['ps', '--filter', `label=org.treeseed.development.session=${sessionId}`, '--format', '{{.Names}}']).trim(), name);
  checks.push('repeated hold resumes one healthy candidate with unchanged selection');
  process.stdout.write(`${JSON.stringify({ ok: true, checks })}\n`);
} finally {
  for (const owned of [name, stranger]) { try { docker(['rm', '--force', owned]); } catch { /* only these disposable names */ } }
  key.fill(0); rmSync(root, { recursive: true, force: true });
}
