import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkspaceNbdService } from './workspace-nbd-service.js';
import { providerVolumeMapperName } from '../security/provider-volume-identity.js';

const exec = promisify(execFile);
const run = async (command: string, args: string[]) => (await exec(command, args, { encoding: 'utf8',
	timeout: 120_000, maxBuffer: 65_536, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } })).stdout.trim();
export const workspaceStorageRoot = '/var/lib/treeseed/agent/workspaces';
export interface WorkspaceDisk { id: string; directory: string; device: string; unit: string; image: string }
const leaseId = /^workspace-lease-[a-f0-9-]{36}$/u;

/** Provider-encrypted storage is a prerequisite, not an optional fallback to the host root disk. */
export async function initializeWorkspaceStorage() {
	const mount = await run('/usr/bin/findmnt', ['--noheadings', '--output', 'TARGET,SOURCE', '--target', '/var/lib/treeseed/agent']);
	const [target, source] = mount.split(/\s+/u);
	if (target !== '/var/lib/treeseed/agent' || source !== `/dev/mapper/${providerVolumeMapperName}`) throw new Error('Workspace storage requires the encrypted provider volume.');
	await privateDirectory(workspaceStorageRoot);
}

async function privateDirectory(path: string) {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const details = await lstat(path);
	if (await realpath(path) !== path || !details.isDirectory() || details.uid !== 0 || (details.mode & 0o077) !== 0) {
		throw new Error('Workspace storage directory is not root-owned private custody.');
	}
}

export function workspaceImagePath(id: string) {
	if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid workspace image identity.');
	return join(workspaceStorageRoot, 'images', `${id}.qcow2`);
}

/** Create a new writable disposable disk. Neither analysis nor work writes to the backing image. */
export async function createWorkspaceDisk(baseImageId: string | null, virtualBytes: number) {
	if (!Number.isSafeInteger(virtualBytes) || virtualBytes < 67_108_864 || virtualBytes > 137_438_953_472) throw new Error('Invalid workspace disk quota.');
	await initializeWorkspaceStorage();
	for (const name of ['images', 'devices', 'leases']) await privateDirectory(join(workspaceStorageRoot, name));
	const id = `workspace-lease-${randomUUID()}`, directory = join(workspaceStorageRoot, 'leases', id);
	await mkdir(directory, { mode: 0o700 });
	const image = join(directory, 'work.qcow2');
	if (baseImageId) {
		const base = workspaceImagePath(baseImageId), details = await lstat(base);
		if (!details.isFile() || details.uid !== 0 || (details.mode & 0o222) !== 0) throw new Error('Workspace base is not immutable manager custody.');
		const info = JSON.parse(await run('/usr/bin/qemu-img', ['info', '--output=json', '-f', 'qcow2', base])) as Record<string, unknown>;
		if (!Number.isSafeInteger(info['virtual-size']) || Number(info['virtual-size']) > virtualBytes) throw new Error('Workspace base exceeds its disk quota.');
		await run('/usr/bin/qemu-img', ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', base, image]);
	} else {
		const raw = join(directory, 'empty.raw');
		await run('/usr/bin/truncate', ['--size', String(virtualBytes), raw]);
		// This filesystem is newly created empty, never a guest-modified filesystem mounted on the host.
		await run('/usr/sbin/mkfs.ext4', ['-q', '-F', '-E', 'root_owner=65532:65532', raw]);
		await run('/usr/bin/qemu-img', ['convert', '-f', 'raw', '-O', 'qcow2', raw, image]);
		await rm(raw);
	}
	await chmod(image, 0o600);
	return { id, directory, image };
}

async function absent(path: string) {
	try { await stat(path); return false; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}

export async function attachWorkspaceDisk(disk: Pick<WorkspaceDisk, 'id' | 'directory' | 'image'>, readOnly = false): Promise<WorkspaceDisk> {
	if (!leaseId.test(disk.id) || disk.directory !== join(workspaceStorageRoot, 'leases', disk.id)
		|| disk.image !== join(disk.directory, 'work.qcow2')) throw new Error('Workspace disk escaped manager custody.');
	await run('/usr/sbin/modprobe', ['nbd']);
	for (const name of (await readdir('/sys/block')).filter(name => /^nbd[0-9]+$/u.test(name)).sort()) {
		const fence = join(workspaceStorageRoot, 'devices', name);
		try { await mkdir(fence, { mode: 0o700 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
		if (!await absent(`/sys/block/${name}/pid`)) { await rm(fence, { recursive: true }); continue; }
		await writeFile(join(fence, 'owner'), disk.id, { mode: 0o600, flag: 'wx' });
		const device = `/dev/${name}`;
		// Any startup uncertainty retains both disk and device fence for recovery.
		await writeFile(join(disk.directory, 'device.json'), JSON.stringify({ device, id: disk.id }), { mode: 0o600, flag: 'wx' });
		const unit = await startWorkspaceNbdService({ ...disk, device, image: 'work.qcow2', readOnly });
		return { ...disk, device, unit };
	}
	throw new Error('No unfenced workspace block device is available.');
}

/** Caller must first verify VM teardown. This releases transport, never candidate contents. */
export async function detachWorkspaceDisk(disk: WorkspaceDisk, guestStopped: boolean) {
	if (!guestStopped) throw new Error('Cannot detach a disk before its VM is stopped.');
	if (!leaseId.test(disk.id) || disk.directory !== join(workspaceStorageRoot, 'leases', disk.id)
		|| disk.unit !== `treeseed-${disk.id}.service` || !/^\/dev\/nbd[0-9]+$/u.test(disk.device)) throw new Error('Invalid workspace disk ownership.');
	const name = disk.device.slice('/dev/'.length), fence = join(workspaceStorageRoot, 'devices', name);
	if (await readFile(join(fence, 'owner'), 'utf8') !== disk.id) throw new Error('Workspace device ownership changed.');
	const pidPath = `/sys/block/${name}/pid`;
	if (!await absent(pidPath)) {
		const thread = (await readFile(pidPath, 'utf8')).trim(), pid = (await readFile(join(disk.directory, 'nbd.pid'), 'utf8')).trim();
		if (!/^[1-9][0-9]*$/u.test(thread) || !/^[1-9][0-9]*$/u.test(pid)
			|| await run('/usr/bin/systemctl', ['show', disk.unit, '--property=MainPID', '--value']) !== pid
			|| (await readFile(`/proc/${thread}/status`, 'utf8')).match(/^Tgid:\s+([0-9]+)$/mu)?.[1] !== pid
			|| !(await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').includes(join(disk.directory, 'work.qcow2'))) throw new Error('Workspace NBD process ownership changed.');
		// The broker deliberately has no raw NBD device access. The independently
		// owned unit closes its transport on stop; never widen broker device policy.
	}
	const state = await run('/usr/bin/systemctl', ['show', disk.unit, '--property=ActiveState', '--value']);
	if (!['inactive', 'failed'].includes(state)) await run('/usr/bin/systemctl', ['stop', disk.unit]);
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await absent(pidPath)) {
			await rm(fence, { recursive: true }); await rm(join(disk.directory, 'device.json')); return;
		}
		await delay(100);
	}
	throw new Error('Workspace disk remains mapped and fenced.');
}
