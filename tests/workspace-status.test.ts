import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceCatalog } from '../src/sandbox/workspace-catalog.js';

// Unit filesystem/catalog fixtures do not establish owning-host custody. The
// existing privileged public manager/supervisor case supplies that proof.
const state = vi.hoisted(() => ({ root: `/tmp/deployment-workspace-status-${globalThis.crypto.randomUUID()}` }));
vi.mock('../src/sandbox/workspace-block-store.js', () => ({ workspaceStorageRoot: state.root }));
vi.mock('node:fs', async original => {
	const fs = await original<typeof import('node:fs')>();
	const local = (path: import('node:fs').PathLike) => String(path).replace(/^\/proc\/1\/root(?=\/)/u, '');
	return { ...fs, lstatSync: (path: import('node:fs').PathLike) => fs.lstatSync(local(path)),
		readdirSync: (path: import('node:fs').PathLike) => fs.readdirSync(local(path)),
		readlinkSync: (path: import('node:fs').PathLike) => fs.readlinkSync(path === '/proc/1/ns/mnt' ? '/proc/self/ns/mnt' : path) };
});
import { workspaceStatus } from '../src/sandbox/workspace-status.js';

const id = 'workspace-lease-11111111-1111-4111-8111-111111111111';
const directory = () => join(state.root, 'leases', id);
beforeEach(() => { rmSync(state.root, { recursive: true, force: true }); mkdirSync(directory(), { recursive: true }); });
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
});

it('reads the original catalog without changing its canonical bytes and retains malformed device failures as incomplete observations', () => {
	const catalog = new WorkspaceCatalog(join(state.root, 'catalog.db'));
	try {
		const before = readFileSync(join(state.root, 'catalog.db'));
		writeFileSync(join(directory(), 'device.json'), '{');
		let observed: ReturnType<typeof workspaceStatus> | undefined;
		expect(() => { observed = workspaceStatus(); }).not.toThrow();
		expect(observed).toMatchObject({ initialized: true, complete: false, images: [], leases: [],
			disks: [{ id, type: 'directory', bytes: null, device: null }] });
		expect(observed!.errors).toContain('workspace_lease_metadata_unavailable');
		expect(readFileSync(join(directory(), 'device.json'), 'utf8')).toBe('{');
		expect(readFileSync(join(state.root, 'catalog.db'))).toEqual(before);
	} finally { catalog.close(); }
});
