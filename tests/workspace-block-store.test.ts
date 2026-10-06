import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { lstat, readFile, readlink, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { attachWorkspaceDisk, createWorkspaceDisk, detachWorkspaceDisk, workspaceImagePath, workspaceStorageRoot, type WorkspaceDisk } from '../src/sandbox/workspace-block-store.js';
describe('workspace storage boundary', () => {
	it('only addresses canonical image IDs under managed encrypted storage', () => {
		expect(workspaceImagePath('a'.repeat(64))).toBe(`/var/lib/treeseed/agent/workspaces/images/${'a'.repeat(64)}.qcow2`);
		for (const id of ['../escape', 'file:///tmp/disk', 'a'.repeat(63)]) expect(() => workspaceImagePath(id)).toThrow('identity');
	});
	it('rejects invalid quotas before touching host resources', async () => {
		for (const size of [-1, 0, Number.NaN, Number.MAX_SAFE_INTEGER]) await expect(createWorkspaceDisk(null, size)).rejects.toThrow('quota');
	});
	it('rejects caller-selected paths and teardown without stopped-guest evidence', async () => {
		const disk = { id: 'unowned', directory: '/tmp/disk', image: '/tmp/image', device: '/dev/sda', unit: 'unrelated.service' };
		await expect(attachWorkspaceDisk(disk)).rejects.toThrow('custody');
		await expect(detachWorkspaceDisk(disk, false)).rejects.toThrow('stopped');
		await expect(detachWorkspaceDisk(disk, true)).rejects.toThrow('ownership');
	});
});

it('native original disk attachment retains denied teardown and image bytes across retry before removing only its own service process socket and fence', async () => {
	if (process.env.TREESEED_PRIVILEGED_CACHE_TESTS !== '1' || process.getuid?.() !== 0) {
		throw new Error('Explicit existing privileged host test authorization and root are required; native NBD coverage cannot be skipped.');
	}
	expect(await readlink('/proc/self/ns/mnt')).toBe(await readlink('/proc/1/ns/mnt'));
	const custody = await lstat(workspaceStorageRoot);
	expect(custody.isDirectory() && custody.uid === 0 && (custody.mode & 0o077) === 0).toBe(true);
	const exec = promisify(execFile);
	const show = async (unit: string) => {
		let bytes: string;
		try { bytes = (await exec('/usr/bin/systemctl', ['show', unit, '--property=LoadState,ActiveState,SubState,MainPID,ControlPID'],
			{ encoding: 'utf8', timeout: 15_000, maxBuffer: 65_536 })).stdout; }
		catch (error) {
			if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 4 || typeof Reflect.get(error, 'stdout') !== 'string') throw error;
			bytes = String(Reflect.get(error, 'stdout'));
		}
		const fields = Object.fromEntries(bytes.trim().split('\n').map(line => line.split('=')));
		expect(Object.keys(fields).sort()).toEqual(['ActiveState', 'ControlPID', 'LoadState', 'MainPID', 'SubState']);
		return fields;
	};
	const absent = async (path: string) => {
		try { await lstat(path); }
		catch (error) { expect(error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT').toBe(true); return; }
		throw new Error('Owned NBD resource remains; unreadability is not absence.');
	};
	const created = await createWorkspaceDisk(null, 67_108_864), imageBytes = await readFile(created.image);
	let attached: WorkspaceDisk | undefined, released = false;
	try {
		for (const readOnly of [false, true]) {
			attached = await attachWorkspaceDisk(created, readOnly);
			const original = structuredClone(attached), name = attached.device.slice('/dev/'.length);
			const fence = `${workspaceStorageRoot}/devices/${name}`, runtime = `/run/treeseed-workspace/${created.id.slice(-36)}`;
			const pid = (await readFile(`${created.directory}/nbd.pid`, 'utf8')).trim();
			expect(pid).toMatch(/^[1-9][0-9]*$/u);
			expect(await show(attached.unit)).toEqual({ LoadState: 'loaded', ActiveState: 'active', SubState: 'running', MainPID: pid, ControlPID: '0' });
			expect((await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')).toContain(created.image);
			expect((await lstat(`${runtime}/nbd.sock`)).isSocket()).toBe(true);
			const owner = await readFile(`${fence}/owner`), device = await readFile(`${created.directory}/device.json`);
			expect(owner.toString()).toBe(created.id);
			await expect(detachWorkspaceDisk(attached, false)).rejects.toThrow('stopped');
			await expect(detachWorkspaceDisk({ ...attached, unit: 'unowned.service' }, true)).rejects.toThrow('ownership');
			expect(await readFile(`${fence}/owner`)).toEqual(owner);
			expect(await readFile(`${created.directory}/device.json`)).toEqual(device);
			expect((await show(attached.unit)).MainPID).toBe(pid);
			expect(attached).toEqual(original);
			await detachWorkspaceDisk(attached, true); attached = undefined;
			expect(await show(original.unit)).toEqual({ LoadState: 'not-found', ActiveState: 'inactive', SubState: 'dead', MainPID: '0', ControlPID: '0' });
			await absent(`/proc/${pid}`); await absent(runtime); await absent(`${created.directory}/device.json`);
			// A device may already be reused by another lease. Never remove or reject that unrelated owner's fence.
			try { expect(await readFile(`${fence}/owner`, 'utf8')).not.toBe(created.id); }
			catch (error) { if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'ENOENT') throw error; }
			expect(await readFile(created.image)).toEqual(imageBytes);
			await expect(detachWorkspaceDisk(original, true)).rejects.toThrow();
			expect(await readFile(created.image)).toEqual(imageBytes);
		}
		released = true;
	} finally {
		if (attached) { await detachWorkspaceDisk(attached, true); released = true; }
		if (released) { await rm(created.directory, { recursive: true }); await absent(created.directory); }
	}
}, 30_000);
