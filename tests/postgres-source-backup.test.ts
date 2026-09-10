import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { component, host } from './fixtures.js';
import { backupPostgresSourceFormat, inspectRecoveryPostgresSource, inspectRecoveryPostgresFingerprint } from '../src/supervisor/postgres-source-backup.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';

const f = vi.hoisted(() => ({ backup: vi.fn(), host: vi.fn(), docker: vi.fn(), inspect: vi.fn(), realpath: vi.fn(), session: vi.fn(), fingerprint: vi.fn() }));
vi.mock('../src/supervisor/backup.js', () => ({ inspectGenerationBackup: f.backup }));
vi.mock('../src/core/configuration.js', () => ({ loadHostConfiguration: f.host }));
vi.mock('../src/supervisor/postgres-process.js', () => ({ postgresDocker: f.docker }));
vi.mock('../src/postgres/source-inventory.js', () => ({ inspectPostgresSource: f.inspect }));
vi.mock('../src/postgres/source-session.js', () => ({ withAttestedPostgresSource: f.session }));
vi.mock('../src/postgres/transfer-fingerprint.js', () => ({ fingerprintPostgresTransfer: f.fingerprint }));
vi.mock('node:fs', async original => ({ ...await original<object>(), realpathSync: f.realpath }));
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(process,'getuid').mockReturnValue(0); });
afterEach(() => { vi.restoreAllMocks(); });
function fixture() {
  const configuration = host(), release = component('api','development','a');
  release.runtime.services[0]!.composeService='database';
  release.runtime.stateVolumes=[{ id:'postgres', volume:'/var/lib/treeseed/components/api/postgres', backup:'required' }];
  release.runtimeDigest=deploymentDigest(release.runtime);
  const backup = { sha256:'a'.repeat(64), configuration:structuredClone(configuration), components:[release], coverage:{stateDirectories:['var/lib/treeseed/components/api/postgres']} };
  const observed = { image:'postgres@sha256:example', database:'POSTGRES_DB=application', username:'POSTGRES_USER=owner',
    mounts:[{Type:'bind',Source:'/var/lib/treeseed/components/api/postgres',Destination:'/var/lib/postgresql/data'}] };
  const id='b'.repeat(64);
  f.backup.mockResolvedValue(backup); f.host.mockReturnValue(configuration); f.realpath.mockImplementation(value=>value);
  f.inspect.mockResolvedValue({container:id, database:'application', major:16, clusterIdentity:`sha256:${'d'.repeat(64)}`, inventoryDigest:`sha256:${'c'.repeat(64)}`});
  f.session.mockImplementation(async (_selection,_docker,run)=>run({query:vi.fn()}));
  f.fingerprint.mockResolvedValue({schemaDigest:`sha256:${'e'.repeat(64)}`});
  f.docker.mockImplementation(async (args:string[]) => args[0]==='ps' ? id : args[0]==='inspect' ? JSON.stringify(observed) : '/var/lib/postgresql/data');
  return {backup,configuration,observed,run:()=>inspectRecoveryPostgresSource(7,`sha256:${'a'.repeat(64)}`,'api','database')};
}
it('uses authenticated backup manifests when old package files are no longer installed',async()=>{
  const fxt=fixture(), result=await fxt.run();
  expect(result.username).toBe('owner'); expect(result.backupGeneration).toBe(7); expect(result.storageDigest).toMatch(/^sha256:/u);
  expect(f.backup).toHaveBeenCalledWith(7); expect(f.inspect.mock.calls[0]?.[0]).toEqual(fxt.backup.components[0]);
  expect(backupPostgresSourceFormat).not.toContain('POSTGRES_PASSWORD'); expect(backupPostgresSourceFormat).not.toContain('{{json .Config.Env}}');
});
it.each(['digest','host','coverage','mount','nested','symlink','runtime'] as const)('rejects unverified %s custody without catalog access',async kind=>{
  const v=fixture();
  if(kind==='digest')v.backup.sha256='d'.repeat(64);
  if(kind==='host')v.configuration.host.id='other';
  if(kind==='coverage')v.backup.coverage.stateDirectories=[];
  if(kind==='mount')v.observed.mounts[0]!.Source='/unowned';
  if(kind==='nested')v.observed.mounts.push({Type:'bind',Source:'/elsewhere',Destination:'/var/lib/postgresql/data/base'});
  if(kind==='symlink')f.realpath.mockReturnValue('/elsewhere');
  if(kind==='runtime')v.backup.components[0]!.runtimeDigest=`sha256:${'0'.repeat(64)}`;
  await expect(v.run()).rejects.toThrow('source unchanged'); expect(f.inspect).not.toHaveBeenCalled();
});
it('rejects redirected data directories and changed container identities',async()=>{
  const v=fixture(); f.docker.mockImplementation(async (args:string[]) => args[0]==='ps' ? 'b'.repeat(64) : args[0]==='inspect' ? JSON.stringify(v.observed) : '/uncovered/data');
  await expect(v.run()).rejects.toThrow('source unchanged');
  f.inspect.mockResolvedValue({container:'c'.repeat(64)}); await expect(v.run()).rejects.toThrow('source unchanged');
});
it('returns bounded custody and exact-frozen fingerprints without returning login or storage paths',async()=>{
  fixture();
  const args = [7,`sha256:${'a'.repeat(64)}`,'api','database'] as const;
  const planned = await inspectRecoveryPostgresFingerprint(...args);
  expect(JSON.stringify(planned)).not.toContain('/var/lib/');
  expect(JSON.stringify(planned)).not.toContain('owner');
  expect(f.session).not.toHaveBeenCalled();
  const checked = await inspectRecoveryPostgresFingerprint(...args,planned.custodyDigest);
  expect(checked.fingerprint).toEqual({schemaDigest:`sha256:${'e'.repeat(64)}`});
  expect(f.session.mock.calls[0]?.[0].username).toBe('owner');
  await expect(inspectRecoveryPostgresFingerprint(...args,`sha256:${'0'.repeat(64)}`)).rejects.toThrow('Exact');
  expect(f.session).toHaveBeenCalledTimes(1);
});
it('rejects changed custody after the bounded fingerprint session',async()=>{
  const v=fixture(), args=[7,`sha256:${'a'.repeat(64)}`,'api','database'] as const;
  const planned=await inspectRecoveryPostgresFingerprint(...args);
  f.fingerprint.mockImplementation(async()=>{v.backup.sha256='f'.repeat(64); return {};});
  await expect(inspectRecoveryPostgresFingerprint(...args,planned.custodyDigest)).rejects.toThrow('source unchanged');
});
it('accepts only fixed recovery descriptors on the supervisor wire',()=>{
  const request={operation:'postgres.source.recovery.inspect',generation:7,backupDigest:`sha256:${'a'.repeat(64)}`,componentId:'api',serviceId:'database'};
  expect(supervisorOperationSchema.safeParse(request).success).toBe(true);
  for(const invalid of [{path:'/unowned'},{sql:'SELECT 1'},{generation:Number.MAX_SAFE_INTEGER+1},{backupDigest:'latest'},{componentId:'../api'}])
    expect(supervisorOperationSchema.safeParse({...request,...invalid}).success).toBe(false);
});
