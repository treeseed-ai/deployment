import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceCatalog } from '../src/sandbox/workspace-catalog.js';

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
});
