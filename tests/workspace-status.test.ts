import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceCatalog } from '../src/sandbox/workspace-catalog.js';
import { simulationSourceRepository } from '../src/sandbox/simulation-source-repository.js';

// Unit filesystem/catalog fixtures do not establish owning-host custody. The
// existing privileged public manager/supervisor case supplies that proof.
const state = vi.hoisted(() => ({ root: `/tmp/deployment-workspace-status-${globalThis.crypto.randomUUID()}`,
	afterRead: undefined as (() => void) | undefined, namespace: undefined as string | undefined }));
vi.mock('../src/sandbox/workspace-block-store.js', () => ({ workspaceStorageRoot: state.root }));
vi.mock('node:fs', async original => {
	const fs = await original<typeof import('node:fs')>();
	const local = (path: import('node:fs').PathLike) => String(path).replace(/^\/proc\/1\/root(?=\/)/u, '');
	return { ...fs, lstatSync: (path: import('node:fs').PathLike) => fs.lstatSync(local(path)),
		openSync: vi.fn(fs.openSync), closeSync: vi.fn(fs.closeSync), readSync: vi.fn(fs.readSync), readFileSync: vi.fn(fs.readFileSync),
		readdirSync: (path: import('node:fs').PathLike) => {
			const entries = fs.readdirSync(local(path)), change = state.afterRead; state.afterRead = undefined; change?.(); return entries;
		},
		readlinkSync: (path: import('node:fs').PathLike) => path === '/proc/1/ns/mnt' && state.namespace !== undefined
			? state.namespace : fs.readlinkSync(path === '/proc/1/ns/mnt' ? '/proc/self/ns/mnt' : path) };
});
import { workspaceStatus } from '../src/sandbox/workspace-status.js';

const id = 'workspace-lease-11111111-1111-4111-8111-111111111111';
const directory = () => join(state.root, 'leases', id);
beforeEach(() => { state.afterRead = undefined; state.namespace = undefined;
	rmSync(state.root, { recursive: true, force: true }); mkdirSync(directory(), { recursive: true }); });
afterAll(() => rmSync(state.root, { recursive: true, force: true }));

it('reads canonical published source custody from the owning journal without exposing private results or accepting redirected repositories', () => {
	const source = { controlPlaneId: 'control', teamId: 'team', projectId: 'sdk', repositoryId: 'repository',
		commit: 'a'.repeat(40), formatVersion: 1 as const, profile: 'source-only' as const };
	const sourceReference = { kind: 'git', repository: 'treeseed-ai/sdk', commit: 'b'.repeat(40), branch: 'simulation/tester' };
	const sandboxId = 'sandbox-source-custody', root = join(state.root, 'results'), path = join(root, `${sandboxId}.json`);
	const repository = simulationSourceRepository(state.root, source);
	mkdirSync(root, { recursive: true, mode: 0o700 }); mkdirSync(repository, { recursive: true, mode: 0o700 });
	const original = { schemaVersion: 'treeseed.source-result/v1', sandboxId, leaseId: 'lease-source', source, sourceReference,
		status: 'completed', teardownVerified: true, completedAt: '2026-10-12T15:00:00.000Z', result: { private: 'never-public' } };
	const write = (value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); write(original);
	const bytes = readFileSync(path);
	const entry = () => workspaceStatus().journals!.results.entries[0]!;
	expect(entry().metadata).toMatchObject({ source, sourceReference, simulationRepository: repository });
	expect(JSON.stringify(entry())).not.toContain('never-public'); expect(readFileSync(path)).toEqual(bytes);
	for (const value of [{ ...original, source: { ...source, commit: 'moved' } },
		{ ...original, source: { ...source, credential: 'never-public' } },
		{ ...original, sourceReference: { ...sourceReference, commit: '--unsafe' } },
		{ ...original, sourceReference: { kind: 'url', url: 'https://example.invalid/' } },
		{ ...original, source: undefined }]) {
		write(value); expect(entry().metadata).toBeNull();
		expect(workspaceStatus().errors).toContain('workspace_results_metadata_unavailable');
	}
	write(original); expect(entry().metadata).toMatchObject({ source, sourceReference, simulationRepository: repository });
	rmSync(repository, { recursive: true }); expect(entry().metadata).toMatchObject({ simulationRepository: null });
	symlinkSync(root, repository); expect(entry().metadata).toBeNull();
	expect(workspaceStatus().errors).toContain('workspace_results_metadata_unavailable');
	expect(readFileSync(path)).toEqual(bytes);
});

it('retains orphan lease files when the catalog is absent without inventing empty canonical authority or writing evidence', () => {
	writeFileSync(join(directory(), 'work.qcow2'), 'disk');
	writeFileSync(join(directory(), 'device.json'), JSON.stringify({ id, device: '/dev/nbd99' }));
	const before = readdirSync(state.root, { recursive: true }), bytes = readFileSync(join(directory(), 'work.qcow2'));
	const observed = workspaceStatus();
	expect(observed).toMatchObject({ initialized: false, complete: false, images: null, leases: null,
		scope: { storageRoot: state.root }, errors: ['workspace_catalog_unavailable'],
		disks: [{ id, type: 'directory', bytes: 4, device: { id, device: '/dev/nbd99' } }] });
	expect(readdirSync(state.root, { recursive: true })).toEqual(before);
	expect(readFileSync(join(directory(), 'work.qcow2'))).toEqual(bytes);
	try {
		truncateSync(join(directory(), 'work.qcow2'), 8 * 1024 ** 3);
		vi.mocked(openSync).mockClear(); vi.mocked(readFileSync).mockClear();
		expect(workspaceStatus().disks[0]!.bytes).toBe(8 * 1024 ** 3);
		expect(vi.mocked(openSync).mock.calls.every(([path]) => String(path).endsWith('/device.json'))).toBe(true);
		expect(vi.mocked(readFileSync).mock.calls).toEqual([]);
	} finally { truncateSync(join(directory(), 'work.qcow2'), 4); }
	const sandboxId = 'sandbox-status-1-12345678', owner = { assignmentId: 'assignment-status', providerId: 'provider-status',
		teamId: 'team-status', projectId: 'project-status', attempt: 1 };
	const job = { schemaVersion: 'treeseed.assignment-source-job/v1', owner, state: 'stopped', leaseId: 'original-lease',
		disk: { id, directory: directory(), image: join(directory(), 'work.qcow2'), device: '/dev/nbd99', unit: `treeseed-${id}.service` },
		builderIds: ['sandbox-warm-11111111-1111-4111-8111-111111111111'], authority: { private: 'controlled-private-authority' }, failure: 'controlled-private-failure' };
	const candidate = { state: 'published', assignmentId: owner.assignmentId, attempt: 1, providerId: owner.providerId,
		verifierId: 'sandbox-warm-22222222-2222-4222-8222-222222222222', verifierStopped: true, reference: { private: 'controlled-private-reference' } };
	const result = { schemaVersion: 'treeseed.source-result/v1', sandboxId, leaseId: job.leaseId, status: 'completed',
		teardownVerified: true, completedAt: '2026-10-11T00:00:00.000Z', result: { private: 'controlled-private-result' } };
	expect(workspaceStatus()).toMatchObject({ journals: { jobs: { rootPresent: false, entries: [] },
		candidates: { rootPresent: false, entries: [] }, results: { rootPresent: false, entries: [] } } });
	for (const [kind, metadata] of Object.entries({ jobs: job, candidates: candidate, results: result })) {
		mkdirSync(join(state.root, kind), { mode: 0o700 });
		writeFileSync(join(state.root, kind, `${sandboxId}.json`), JSON.stringify(metadata), { mode: 0o600 });
	}
	const held = readdirSync(state.root, { recursive: true }).map(path => String(path));
	const inspection = workspaceStatus();
	expect(inspection).toMatchObject({ journals: {
		jobs: { rootPresent: true, entries: [{ name: `${sandboxId}.json`, type: 'file', metadata: { owner, state: 'stopped', leaseId: job.leaseId, disk: job.disk, builderIds: job.builderIds } }] },
		candidates: { entries: [{ metadata: { state: 'published', assignmentId: owner.assignmentId, verifierId: candidate.verifierId, verifierStopped: true } }] },
		results: { entries: [{ metadata: { sandboxId, leaseId: job.leaseId, status: 'completed', teardownVerified: true } }] },
	} });
	for (const secret of ['controlled-private-authority', 'controlled-private-failure', 'controlled-private-reference', 'controlled-private-result'])
		expect(JSON.stringify(inspection)).not.toContain(secret);
	expect(readdirSync(state.root, { recursive: true }).map(path => String(path))).toEqual(held);
	for (const [kind, metadata] of Object.entries({ jobs: job, candidates: candidate, results: result }))
		expect(JSON.parse(readFileSync(join(state.root, kind, `${sandboxId}.json`), 'utf8'))).toEqual(metadata);
});

it('retains unrelated and redirected lease entries while denying incomplete physical observations without reading their contents', () => {
	const target = join(state.root, 'private-fixture'); writeFileSync(target, 'controlled-private-content');
	writeFileSync(join(state.root, 'leases', 'unexpected-entry'), 'controlled-unrelated-content');
	symlinkSync(target, join(state.root, 'leases', 'redirected-entry'));
	const before = readdirSync(state.root, { recursive: true }), observed = workspaceStatus();
	expect(observed).toMatchObject({ complete: false });
	expect(observed.disks).toEqual(expect.arrayContaining([
		expect.objectContaining({ id: 'unexpected-entry', type: 'file' }),
		expect.objectContaining({ id: 'redirected-entry', type: 'symlink' }),
	]));
	expect(observed.errors).toContain('workspace_lease_metadata_unavailable');
	expect(JSON.stringify(observed)).not.toContain('controlled-private-content');
	expect(JSON.stringify(observed)).not.toContain('controlled-unrelated-content');
	expect(readdirSync(state.root, { recursive: true })).toEqual(before);
	state.afterRead = () => mkdirSync(join(state.root, 'leases', 'new-observed-entry'));
	const changed = workspaceStatus();
	expect(changed.complete).toBe(false); expect(changed.errors).toContain('workspace_inventory_changed');
	expect(changed.disks.some(disk => disk.id === 'new-observed-entry')).toBe(false);
	expect(changed.confirmation.disks.some(disk => disk.id === 'new-observed-entry')).toBe(true);
	state.afterRead = () => { state.namespace = 'mnt:[999999999]'; };
	const changedNamespace = workspaceStatus();
	expect(changedNamespace.complete).toBe(false); expect(changedNamespace.errors).toContain('workspace_inventory_changed');
	expect(changedNamespace.confirmation.mountNamespace).toBe('mnt:[999999999]');
	expect(changedNamespace.scope.mountNamespace).not.toBe(changedNamespace.confirmation.mountNamespace);
	state.namespace = undefined;
	rmSync(state.root, { recursive: true });
	expect(workspaceStatus()).toMatchObject({ initialized: false, complete: false, images: null, leases: null,
		leaseDirectoryPresent: null, errors: ['workspace_lease_inventory_unavailable', 'workspace_catalog_unavailable'] });
	expect(existsSync(state.root)).toBe(false);
});

it('reads the original catalog without changing its canonical bytes and retains malformed device failures as incomplete observations', () => {
	const catalog = new WorkspaceCatalog(join(state.root, 'catalog.db'));
	try {
		const before = readFileSync(join(state.root, 'catalog.db'));
		for (const invalid of ['', '{', 'null', '[]', 'true', JSON.stringify({ id }), JSON.stringify({ device: '/dev/nbd0' }),
			JSON.stringify({ id, device: null }), JSON.stringify({ id: 'foreign', device: '/dev/nbd0' }),
			JSON.stringify({ id, device: '/dev/sda' }), JSON.stringify({ id, device: '/dev/nbd0', extra: 'controlled-private-content' }),
			JSON.stringify({ id, device: '/dev/nbd0' }).padEnd(5000, ' ')]) {
			writeFileSync(join(directory(), 'device.json'), invalid);
			let observed: ReturnType<typeof workspaceStatus> | undefined;
			expect(() => { observed = workspaceStatus(); }).not.toThrow();
			expect(observed).toMatchObject({ initialized: true, complete: false, images: [], leases: [],
				disks: [{ id, type: 'directory', bytes: null, device: null }] });
			expect(observed!.errors).toContain('workspace_lease_metadata_unavailable');
			expect(JSON.stringify(observed)).not.toContain('controlled-private-content');
			expect(readFileSync(join(directory(), 'device.json'), 'utf8')).toBe(invalid);
		}
		const device = JSON.stringify({ id, device: '/dev/nbd0' }).padEnd(4096, ' ');
		writeFileSync(join(directory(), 'device.json'), device);
		expect(workspaceStatus()).toMatchObject({ complete: true, disks: [{ id, device: { id, device: '/dev/nbd0' } }] });
		vi.mocked(openSync).mockClear(); vi.mocked(closeSync).mockClear();
		vi.mocked(readSync).mockImplementationOnce(() => { throw new Error('Controlled metadata read interruption'); });
		const interrupted = workspaceStatus();
		expect(interrupted.complete).toBe(false); expect(interrupted.errors).toContain('workspace_lease_metadata_unavailable');
		expect(interrupted.errors).toContain('workspace_inventory_changed');
		expect(vi.mocked(closeSync).mock.calls.map(([fd]) => fd)).toEqual(vi.mocked(openSync).mock.results.map(result => result.value));
		expect(workspaceStatus().complete).toBe(true); expect(readFileSync(join(directory(), 'device.json'), 'utf8')).toBe(device);
		const target = join(state.root, 'private-device-fixture'); writeFileSync(target, device);
		rmSync(join(directory(), 'device.json')); symlinkSync(target, join(directory(), 'device.json'));
		vi.mocked(openSync).mockClear();
		expect(workspaceStatus()).toMatchObject({ complete: false, disks: [{ id, device: null }] });
		expect(vi.mocked(openSync).mock.calls).toEqual([]); expect(readFileSync(target, 'utf8')).toBe(device);
		expect(readFileSync(join(state.root, 'catalog.db'))).toEqual(before);
		rmSync(directory(), { recursive: true });
		expect(workspaceStatus()).toMatchObject({ initialized: true, complete: true, images: [], leases: [], disks: [], errors: [] });
	} finally { catalog.close(); }
	const database = join(state.root, 'catalog.db'), retained = readFileSync(database);
	writeFileSync(database, 'controlled-corrupt-catalog');
	expect(workspaceStatus()).toMatchObject({ initialized: true, complete: false, images: null, leases: null,
		errors: ['workspace_catalog_unavailable'] });
	expect(readFileSync(database, 'utf8')).toBe('controlled-corrupt-catalog');
		writeFileSync(database, retained); expect(workspaceStatus().complete).toBe(true);
	const jobs = join(state.root, 'jobs'), name = 'sandbox-status-1-12345678.json', path = join(jobs, name);
	mkdirSync(jobs, { mode: 0o700 });
	const valid = { schemaVersion: 'treeseed.assignment-source-job/v1', state: 'stopped',
		owner: { assignmentId: 'assignment-status', providerId: 'provider-status', teamId: 'team-status', projectId: 'project-status', attempt: 1 } };
	for (const input of ['', '{', 'null', '[]', JSON.stringify({ ...valid, schemaVersion: 'foreign' }),
		JSON.stringify({ ...valid, state: 'invented' }), JSON.stringify({ ...valid, owner: { ...valid.owner, attempt: 0 } }),
		JSON.stringify({ ...valid, owner: { ...valid.owner, providerId: 'private value' } }),
		JSON.stringify({ ...valid, disk: { id, directory: '/caller/path', image: '/caller/path/work.qcow2' } }),
		JSON.stringify({ ...valid, disk: { id, directory: directory(), image: join(directory(), 'work.qcow2'), unit: 'foreign.service' } }),
		JSON.stringify({ ...valid, disk: { id, directory: directory(), image: join(directory(), 'work.qcow2'), device: '/dev/sda' } }),
		JSON.stringify({ ...valid, builderIds: ['foreign'] }), JSON.stringify({ ...valid, builderIds: Array(2).fill('sandbox-warm-11111111-1111-4111-8111-111111111111') }),
		JSON.stringify(valid).padEnd(1_048_577, ' ')]) {
		writeFileSync(path, input, { mode: 0o600 });
		const observed = workspaceStatus();
		expect(observed.complete).toBe(false); expect(observed.errors).toContain('workspace_jobs_metadata_unavailable');
		expect(observed.journals?.jobs.entries).toContainEqual(expect.objectContaining({ name, type: 'file', metadata: null }));
		expect(readFileSync(path, 'utf8')).toBe(input);
	}
	const bytes = JSON.stringify(valid).padEnd(1_048_576, ' '); writeFileSync(path, bytes);
	expect(workspaceStatus()).toMatchObject({ complete: true, journals: { jobs: { rootPresent: true,
		entries: [{ name, type: 'file', metadata: valid, digest: expect.stringMatching(/^[a-f0-9]{64}$/u) }] } } });
	chmodSync(path, 0o644); expect(workspaceStatus().errors).toContain('workspace_jobs_metadata_unavailable'); chmodSync(path, 0o600);
	chmodSync(jobs, 0o755); expect(workspaceStatus().errors).toContain('workspace_jobs_inventory_unavailable'); chmodSync(jobs, 0o700);
	const linked = join(state.root, 'hardlink'); linkSync(path, linked);
	expect(workspaceStatus().errors).toContain('workspace_jobs_metadata_unavailable'); rmSync(linked);
	vi.mocked(openSync).mockClear(); vi.mocked(closeSync).mockClear();
	vi.mocked(readSync).mockImplementationOnce(() => { throw new Error('Controlled journal read interruption'); });
	const interrupted = workspaceStatus(); expect(interrupted.errors).toContain('workspace_jobs_metadata_unavailable');
	expect(interrupted.errors).toContain('workspace_inventory_changed');
	expect(vi.mocked(closeSync).mock.calls.map(([fd]) => fd)).toEqual(vi.mocked(openSync).mock.results.map(result => result.value));
	expect(workspaceStatus().complete).toBe(true); expect(readFileSync(path, 'utf8')).toBe(bytes);
	rmSync(path); symlinkSync(database, path); vi.mocked(openSync).mockClear();
	expect(workspaceStatus().errors).toContain('workspace_jobs_metadata_unavailable'); expect(vi.mocked(openSync).mock.calls).toEqual([]); rmSync(path);
	writeFileSync(path, JSON.stringify(valid), { mode: 0o600 });
	let reads = 0;
	state.afterRead = function change() {
		if (++reads === 3) writeFileSync(path, JSON.stringify({ ...valid, state: 'failed' }));
		else state.afterRead = change;
	};
	expect(workspaceStatus().errors).toContain('workspace_inventory_changed');
	expect(workspaceStatus()).toMatchObject({ complete: true, journals: { jobs: { entries: [{ metadata: { state: 'failed' } }] } } });
	for (const kind of ['candidates', 'results'] as const) {
		const root = join(state.root, kind), held = kind === 'candidates' ? { state: 'published', assignmentId: valid.owner.assignmentId,
			attempt: 1, providerId: valid.owner.providerId, verifierId: 'sandbox-warm-22222222-2222-4222-8222-222222222222', verifierStopped: true }
			: { schemaVersion: 'treeseed.source-result/v1', sandboxId: name.slice(0, -5), leaseId: 'lease-status', status: 'completed',
				teardownVerified: true, completedAt: '2026-10-11T00:00:00.000Z' };
		mkdirSync(root, { mode: 0o700 }); const target = join(root, name);
		const invalid = kind === 'candidates' ? [{ ...held, assignmentId: null }, { ...held, attempt: 0 }, { ...held, verifierId: 'foreign' },
			{ ...held, verifierStopped: 'true' }, { ...held, state: 'invented' }]
			: [{ ...held, sandboxId: 'foreign' }, { ...held, leaseId: '' }, { ...held, schemaVersion: 'foreign' },
				{ ...held, status: 'invented' },
				{ ...held, teardownVerified: 'true' }, { ...held, completedAt: '2026-02-30T00:00:00.000Z' }, { ...held, completedAt: '2026-10-11' }];
		for (const metadata of invalid) {
			const bytes = JSON.stringify(metadata); writeFileSync(target, bytes, { mode: 0o600 });
			expect(workspaceStatus().errors).toContain(`workspace_${kind}_metadata_unavailable`);
			expect(readFileSync(target, 'utf8')).toBe(bytes);
		}
		writeFileSync(target, JSON.stringify(held)); expect(workspaceStatus().complete).toBe(true);
		const unknown = join(root, 'unknown'), secret = 'controlled-private-unrelated-journal';
		writeFileSync(unknown, secret, { mode: 0o600 });
		const observed = workspaceStatus(); expect(observed.complete).toBe(false);
		expect(observed.journals?.[kind].entries).toContainEqual({ name: 'unknown', type: 'file', metadata: null, digest: null });
		expect(JSON.stringify(observed)).not.toContain(secret); expect(readFileSync(unknown, 'utf8')).toBe(secret);
		rmSync(unknown); expect(workspaceStatus().complete).toBe(true);
	}
	const db = new DatabaseSync(database);
	try {
		db.exec("INSERT INTO workspace_images(id,source_json,state) VALUES('image-fixture','{}','ready')");
		db.exec("INSERT INTO workspace_leases(id,image_id,authorization_id,provider_id,assignment_id,attempt,mode,acquisition,publication,state,expires_at,result_artifact_id) VALUES('lease-fixture','image-fixture','authority-fixture','provider-fixture','assignment-fixture',1,'analysis','upstream-public','denied','released','2026-10-11T00:00:00.000Z','sandbox-status-1-12345678.json')");
		expect(workspaceStatus()).toMatchObject({ complete: true, leases: [{ id: 'lease-fixture', provider_id: 'provider-fixture',
			assignment_id: 'assignment-fixture', attempt: 1, state: 'released', result_artifact_id: name }] });
	} finally { db.close(); }
});

it('reads exact retained independent candidate verification through fixed owning metadata and rejects changed malformed or missing proof without repair',()=>{
 const sandbox='sandbox-verification-proof',root=join(state.root,'candidates'),path=join(root,sandbox+'.json');mkdirSync(root,{mode:0o700});
 const source={controlPlaneId:'control',teamId:'team',projectId:'project',repositoryId:'treeseed-ai/sdk',commit:'a'.repeat(40),formatVersion:1,profile:'source-only'};
 const verification={baseCommit:source.commit,commit:'b'.repeat(40),bytes:100,clean:true,objectClosure:true,ancestry:true,isolatedVerifier:true};
 const original={state:'published',assignmentId:'assignment',attempt:1,providerId:'provider',leaseId:'lease',source,commit:verification.commit,verification,digest:'sha256:'+'c'.repeat(64),verifierId:'sandbox-warm-22222222-2222-4222-8222-222222222222',verifierStopped:true,privateArgument:'never-public'};
 const write=(value:unknown)=>writeFileSync(path,JSON.stringify(value),{mode:0o600}),entry=()=>workspaceStatus().journals!.candidates.entries[0]!;write(original);const bytes=readFileSync(path),expected={...original};delete (expected as Partial<typeof original>).privateArgument;
 expect(entry().metadata).toEqual(expected);expect(JSON.stringify(entry())).not.toContain('never-public');expect(readFileSync(path)).toEqual(bytes);
 const failures:unknown[]=[];
 for(const changed of [{...original,verification:undefined},{...original,verification:{...verification,baseCommit:'d'.repeat(40)}},{...original,verification:{...verification,commit:'e'.repeat(40)}},{...original,verification:{...verification,bytes:0}},{...original,verification:{...verification,bytes:'100'}},...['clean','objectClosure','ancestry','isolatedVerifier'].map(key=>({...original,verification:{...verification,[key]:false}})),{...original,digest:'invalid'},{...original,source:{...source,commit:'staging'}},{...original,source:{...source,credential:'never-public'}}]){
  write(changed);const held=readFileSync(path);expect(entry().metadata).toBeNull();expect(workspaceStatus().errors).toContain('workspace_candidates_metadata_unavailable');expect(readFileSync(path)).toEqual(held);failures.push(held);
 }
 write(original);const retained=structuredClone(failures);expect(entry().metadata).toEqual(expected);expect(readFileSync(path)).toEqual(bytes);expect(failures).toEqual(retained);
 write({...original,state:'retained',reason:'source_publication_failed',detail:'never-public'});expect(entry().metadata).toEqual({...expected,state:'retained'});
});
