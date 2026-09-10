import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, chown, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { containerdImageReference } from './image-reference.js';
import type { SandboxBrokerConfiguration } from './protocol.js';
import { recordEvent } from '../core/events.js';
import { startWorkspaceNbdService } from './workspace-nbd-service.js';

const exec = promisify(execFile);
const root = '/var/lib/treeseed/sandboxes/workspace-qualification';
let qualificationRunning = false;
type Runner = (program: string, args: string[]) => Promise<string>;
const run: Runner = async (program, args) => (await exec(program, args, {
	encoding: 'utf8', timeout: 120_000, maxBuffer: 65_536,
	env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
})).stdout;

export function qualificationArguments(options: {
	address: string; namespace: string; runtime: string; image: string;
	id: string; device: string; input: string; output: string; readOnly: boolean;
	warmSandboxId?: string;
}) {
	return ['--address', options.address, '--namespace', options.namespace, 'run', '--rm', '--null-io',
		'--runtime', options.runtime, '--cpus', '1', '--memory-limit', '536870912', '--user', '65532:65532',
		...(options.warmSandboxId ? ['--label', 'io.kubernetes.cri.container-type=container', '--label', `io.kubernetes.cri.sandbox-id=${options.warmSandboxId}`] : []),
		'--mount', `type=bind,src=${options.device},dst=/workspace/project,options=${options.readOnly ? 'ro' : 'rw'}:nodev:nosuid`,
		'--mount', `type=bind,src=${options.input},dst=/run/treeseed-probe,options=rbind:ro`,
		'--mount', `type=bind,src=${options.output},dst=/run/treeseed-output,options=rbind:rw`,
		options.image, options.id, 'node', '/run/treeseed-probe/guest.mjs', options.readOnly ? 'read-only' : 'private-write'];
}

async function removeProbeContainer(config: SandboxBrokerConfiguration, id: string) {
	const ctr = ['--address', config.containerdAddress, '--namespace', config.namespace];
	await run('/usr/bin/ctr', [...ctr, 'tasks', 'kill', '--signal', 'SIGKILL', id]).catch(() => undefined);
	await run('/usr/bin/ctr', [...ctr, 'tasks', 'delete', '--force', id]).catch(() => undefined);
	await run('/usr/bin/ctr', [...ctr, 'containers', 'delete', id]).catch(() => undefined);
	if ((await run('/usr/bin/ctr', [...ctr, 'containers', 'list', '--quiet'])).split(/\s+/u).includes(id)) {
		throw new Error('Workspace probe remains attached; retaining its storage fence.');
	}
}

async function prepareWarmProbe(config: SandboxBrokerConfiguration, image: string, id: string, input: string, output: string) {
	const ctr = ['--address', config.containerdAddress, '--namespace', config.namespace];
	const warmId = `${id}-warm`;
	await run('/usr/bin/ctr', [...ctr, 'run', '--detach', '--null-io', '--runtime', config.runtime,
		'--label', 'io.kubernetes.cri.container-type=sandbox', '--cpus', '1', '--memory-limit', '1073741824',
		image, warmId, '/bin/sleep', '120']);
	await run('/usr/bin/ctr', [...ctr, 'run', '--rm', '--null-io', '--runtime', config.runtime,
		'--label', 'io.kubernetes.cri.container-type=container', '--label', `io.kubernetes.cri.sandbox-id=${warmId}`,
		'--user', '65532:65532',
		'--mount', `type=bind,src=${input},dst=/run/treeseed-probe,options=rbind:ro`,
		'--mount', `type=bind,src=${output},dst=/run/treeseed-output,options=rbind:rw`,
		image, `${id}-ready`, 'node', '/run/treeseed-probe/guest.mjs', 'warm-ready']);
	const receipt = JSON.parse(await readFile(join(output, 'warm.json'), 'utf8')) as { bootId?: unknown };
	if (typeof receipt.bootId !== 'string' || !/^[a-f0-9-]{36}$/u.test(receipt.bootId)) throw new Error('Warm sandbox did not produce a valid boot identity.');
	return receipt.bootId;
}

async function vacantDevice() {
	for (const name of (await readdir('/sys/block')).filter(name => /^nbd[0-9]+$/u.test(name)).sort()) {
		try { await stat(`/sys/block/${name}/pid`); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `/dev/${name}`; throw error; }
	}
	throw new Error('No unallocated NBD device is available for workspace qualification.');
}

async function disconnectOwnedDevice(device: string, directory: string) {
	const pidPath = `/sys/block/${device.slice('/dev/'.length)}/pid`;
	let expected: string;
	try { expected = (await readFile(join(directory, 'nbd.pid'), 'utf8')).trim(); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		const state = (await run('/usr/bin/systemctl', ['show', `treeseed-${directory.split('/').at(-1)}.service`, '--property=ActiveState', '--value'])).trim();
		if (!['inactive', 'failed'].includes(state)) throw new Error('NBD service may still attach; retaining its storage fence.');
		try { await stat(pidPath); }
		catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return; throw missing; }
		throw new Error('Mapped NBD device has no recorded owner; refusing to detach it.');
	}
	let actual: string;
	try { actual = (await readFile(pidPath, 'utf8')).trim(); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		try { await stat(`/proc/${expected}`); }
		catch (processError) { if ((processError as NodeJS.ErrnoException).code === 'ENOENT') return; throw processError; }
		throw new Error('NBD owner remains alive without a mapped device; retaining its fence.');
	}
	if (!/^[1-9][0-9]*$/u.test(expected) || !/^[1-9][0-9]*$/u.test(actual)) throw new Error('Invalid NBD owner.');
	// Linux reports the NBD client thread ID, whereas qemu-nbd writes its process ID.
	const status = await readFile(`/proc/${actual}/status`, 'utf8');
	if (status.match(/^Tgid:\s+([0-9]+)$/mu)?.[1] !== expected) throw new Error('NBD ownership changed; refusing to detach an unrelated device.');
	const arguments_ = (await readFile(`/proc/${expected}/cmdline`, 'utf8')).split('\0');
	if (!arguments_.some(value => value === join(directory, 'analysis.qcow2') || value === join(directory, 'work.qcow2'))) {
		throw new Error('NBD process does not own this workspace qualification.');
	}
	await run('/usr/bin/qemu-nbd', ['--disconnect', device]);
	for (let attempt = 0; attempt < 100; attempt++) {
		try { await stat(pidPath); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
		await delay(100);
	}
	throw new Error('Workspace device remains attached; retaining its fenced files.');
}

export async function recoverWorkspaceQualification(config: SandboxBrokerConfiguration) {
	if (qualificationRunning) throw new Error('Workspace qualification is still running.');
	const fence = join(root, 'active');
	const owner = JSON.parse(await readFile(join(fence, 'owner.json'), 'utf8')) as Record<string, unknown>;
	if (typeof owner.id !== 'string' || !/^workspace-probe-[a-f0-9-]{36}$/u.test(owner.id)
		|| owner.directory !== join(root, owner.id) || typeof owner.device !== 'string' || !/^\/dev\/nbd[0-9]+$/u.test(owner.device)) {
		throw new Error('Invalid workspace qualification recovery ownership.');
	}
	const containers = await run('/usr/bin/ctr', ['--address', config.containerdAddress, '--namespace', config.namespace, 'containers', 'list', '--quiet']);
	if ([owner.id, `${owner.id}-ready`, `${owner.id}-warm`].some(id => containers.split(/\s+/u).includes(id))) throw new Error('Workspace probe still has a container; recovery refuses to remove attached storage.');
	await disconnectOwnedDevice(owner.device, owner.directory);
	await rm(owner.directory, { recursive: true });
	await rm(fence, { recursive: true });
	return { recovered: true, id: owner.id };
}

/** Fixed local operator diagnostic: no caller-selected image, path, shell, source or credentials. */
export async function qualifyWorkspaceStorage(config: SandboxBrokerConfiguration, mode: 'cold' | 'warm' | 'hold' = 'cold') {
	if (qualificationRunning) throw new Error('Workspace qualification is already running.');
	qualificationRunning = true;
	try { return await runQualification(config, mode); }
	finally { qualificationRunning = false; }
}

async function runQualification(config: SandboxBrokerConfiguration, mode: 'cold' | 'warm' | 'hold') {
	await mkdir(root, { recursive: true, mode: 0o700 });
	// Cross-process exclusion; a crash deliberately leaves this fence for recovery, not reuse.
	const fence = join(root, 'active');
	await mkdir(fence, { mode: 0o700 });
	const id = `workspace-probe-${randomUUID()}`;
	const directory = join(root, id);
	let device: string | undefined;
	let attached = false;
	let stopped = true;
	let warmOwned = false;
	let held = false;
	const startedAt = Date.now();
	const ctr = ['--address', config.containerdAddress, '--namespace', config.namespace];
	try {
		const guest = config.guestImages[0];
		if (!guest) throw new Error('Workspace qualification requires a trusted guest image.');
		const image = containerdImageReference(guest.image, guest.digest);
		await mkdir(directory, { mode: 0o700 });
		const input = join(directory, 'input'), output = join(directory, 'output'), source = join(directory, 'source');
		for (const path of [input, output, source]) await mkdir(path, { mode: 0o755 });
		await chown(input, 65532, 65532);
		await chown(output, 65532, 65532);
		await writeFile(join(source, 'source.txt'), 'treeseed-workspace-fixture-v1\n', { mode: 0o444 });
		await chmod(join(source, 'source.txt'), 0o444);
		await copyFile(fileURLToPath(new URL('./workspace-qualification-guest.js', import.meta.url)), join(input, 'guest.mjs'));
		await chmod(join(input, 'guest.mjs'), 0o444);
		const raw = join(directory, 'source.raw'), base = join(directory, 'base.qcow2');
		await run('/usr/bin/truncate', ['--size=32M', raw]);
		await run('/usr/sbin/mkfs.ext4', ['-q', '-F', '-E', 'root_owner=65532:65532', '-d', source, raw]);
		await run('/usr/bin/qemu-img', ['convert', '-f', 'raw', '-O', 'qcow2', raw, base]);
		await chmod(base, 0o400);
		const digest = createHash('sha256').update(await readFile(base)).digest('hex');
		await run('/usr/sbin/modprobe', ['nbd']);
		device = await vacantDevice();
		await writeFile(join(fence, 'owner.json'), JSON.stringify({ id, device, directory, startedAt }), { mode: 0o600 });
		const results: unknown[] = [];
		for (const readOnly of [true, false]) {
			const overlay = join(directory, readOnly ? 'analysis.qcow2' : 'work.qcow2');
			await run('/usr/bin/qemu-img', ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', base, overlay]);
			// NBD exports raw sectors to Kata; neither filesystem is mounted by the host.
			attached = true; // A failed connect may still have partially attached the device.
			await startWorkspaceNbdService({ id, directory, device, image: readOnly ? 'analysis.qcow2' : 'work.qcow2', readOnly });
			if (mode === 'hold') {
				held = true;
				return { schemaVersion: 'treeseed.workspace-storage-hold/v1', id, mode,
					unit: `treeseed-${id}.service`, requiresRecovery: true };
			}
			let warmBootId: string | undefined;
			if (mode === 'warm') { warmOwned = true; warmBootId = await prepareWarmProbe(config, image, id, input, output); }
			const executionStartedAt = Date.now();
			stopped = false;
			await run('/usr/bin/ctr', qualificationArguments({ address: config.containerdAddress, namespace: config.namespace,
				runtime: config.runtime, image, id, device, input, output, readOnly, ...(mode === 'warm' ? { warmSandboxId: `${id}-warm` } : {}) }));
			stopped = true;
			const result = JSON.parse(await readFile(join(output, 'qualification.json'), 'utf8')) as Record<string, unknown>;
			if (result.sourceVerified !== true || result.writeDenied !== readOnly) throw new Error('Guest workspace qualification failed.');
			if (warmBootId && result.bootId !== warmBootId) throw new Error('Execution did not attach to the virgin warm sandbox.');
			results.push({ ...result, executionMs: Date.now() - executionStartedAt, ...(warmBootId ? { warmBootVerified: true } : {}) });
			if (warmOwned) { await removeProbeContainer(config, `${id}-warm`); warmOwned = false; }
			await disconnectOwnedDevice(device, directory); attached = false;
			await rm(join(output, 'qualification.json'));
		}
		if (createHash('sha256').update(await readFile(base)).digest('hex') !== digest) throw new Error('Immutable workspace base changed.');
		return { schemaVersion: 'treeseed.workspace-storage-qualification/v1', id, mode, guestDigest: guest.digest,
			results, baseUnchanged: true, hostFilesystemMounts: 0, elapsedMs: Date.now() - startedAt };
	} catch (error) {
		const guest = await readFile(join(directory, 'output', 'qualification.json'), 'utf8').catch(() => 'No guest receipt.');
		recordEvent('sandbox.workspace-qualification-failed', { id, guest: guest.slice(0, 4_096), message: error instanceof Error ? error.message : 'Qualification failed.' });
		throw error;
	} finally {
		if (!stopped) {
			await run('/usr/bin/ctr', [...ctr, 'tasks', 'kill', '--signal', 'SIGKILL', id]).catch(() => undefined);
			await run('/usr/bin/ctr', [...ctr, 'tasks', 'delete', '--force', id]).catch(() => undefined);
			await run('/usr/bin/ctr', [...ctr, 'containers', 'delete', id]).catch(() => undefined);
			const containers = await run('/usr/bin/ctr', [...ctr, 'containers', 'list', '--quiet']);
			if (containers.split(/\s+/u).includes(id)) throw new Error('Workspace probe remains attached; resources are fenced for recovery.');
		}
		if (warmOwned) {
			await removeProbeContainer(config, `${id}-ready`);
			await removeProbeContainer(config, `${id}-warm`);
		}
		if (!held) {
			if (attached && device) await disconnectOwnedDevice(device, directory);
			await rm(directory, { recursive: true, force: true });
			await rm(fence, { recursive: true });
		}
	}
}
