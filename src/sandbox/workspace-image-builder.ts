import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, chown, copyFile, link, lstat, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { SourceWorkspaceKey } from '@treeseed/sdk/capacity-provider/sandbox';
import type { SandboxBrokerConfiguration } from './protocol.js';
import { WorkspaceCatalog } from './workspace-catalog.js';
import { attachWorkspaceDisk, createWorkspaceDisk, detachWorkspaceDisk, workspaceImagePath, workspaceStorageRoot, type WorkspaceDisk } from './workspace-block-store.js';
import { kataWarmOperations } from './warm-sandbox-pool.js';
import { containerdImageReference } from './image-reference.js';

const exec = promisify(execFile);
async function digest(path: string) {
	const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return `sha256:${hash.digest('hex')}`;
}

/** Trusted asynchronous worker entry: caller must authorize source acquisition before staging a bundle.
 * No fetch credentials or repository hooks are exposed to either builder or verifier. */
export async function buildWorkspaceImage(configuration: SandboxBrokerConfiguration, catalog: WorkspaceCatalog,
	input: { source: SourceWorkspaceKey; bundleDigest: string; parentId?: string; virtualBytes: number }) {
	const image = catalog.ensure(input.source);
	if (image.state === 'ready') return { imageId: image.id, noop: true };
	if (!/^sha256:[a-f0-9]{64}$/u.test(input.bundleDigest)) throw new Error('Source bundle digest is invalid.');
	const bundle = join(workspaceStorageRoot, 'bundles', `${input.bundleDigest.slice(7)}.bundle`), bundleStat = await lstat(bundle);
	if (!bundleStat.isFile() || bundleStat.uid !== 0 || (bundleStat.mode & 0o022) !== 0 || await realpath(bundle) !== bundle
		|| bundleStat.size > input.virtualBytes || await digest(bundle) !== input.bundleDigest) throw new Error('Source bundle is not verified manager custody.');
	const { jobId } = catalog.claimBuild(image.id, input.parentId ?? null);
	let disk: Awaited<ReturnType<typeof createWorkspaceDisk>> | undefined;
	let attached: WorkspaceDisk | undefined;
	let guestStopped = true;
	let transportUncertain = false;
	try {
		disk = await createWorkspaceDisk(input.parentId ?? null, input.virtualBytes);
		const incoming = join(disk.directory, 'input'), outgoing = join(disk.directory, 'output');
		for (const path of [incoming, outgoing]) { await mkdir(path, { mode: 0o700 }); await chown(path, 65532, 65532); }
		await copyFile(bundle, join(incoming, 'source.bundle'));
		await copyFile(fileURLToPath(new URL('./workspace-builder-guest.js', import.meta.url)), join(incoming, 'builder.mjs'));
		const parent = input.parentId ? catalog.image(input.parentId) : undefined;
		await writeFile(join(incoming, 'build.json'), JSON.stringify({ commit: input.source.commit,
			parentCommit: parent ? (JSON.parse(parent.source_json) as SourceWorkspaceKey).commit : null }));
		for (const name of ['source.bundle', 'builder.mjs', 'build.json']) {
			await chmod(join(incoming, name), 0o400); await chown(join(incoming, name), 65532, 65532);
		}
		const configured = configuration.guestImages[0];
		if (!configured) throw new Error('Workspace builder has no trusted guest image.');
		const guestImage = containerdImageReference(configured.image, configured.digest);
		const operations = kataWarmOperations(configuration, () => undefined);
		const ctr = async (args: string[]) => (await exec('/usr/bin/ctr', ['--address', configuration.containerdAddress,
			'--namespace', configuration.namespace, ...args], { encoding: 'utf8', timeout: 120_000, maxBuffer: 65_536,
				env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } })).stdout;
		for (const verify of [false, true]) {
			transportUncertain = true;
			attached = await attachWorkspaceDisk(disk, verify);
			const vm = await operations.create({ image: guestImage, cpuCores: 1, memoryBytes: 1_073_741_824, network: 'none' });
			const child = `${vm}-source`;
			guestStopped = false;
			try {
				await ctr(['run', '--rm', '--null-io', '--runtime', configuration.runtime,
					'--label', 'io.kubernetes.cri.container-type=container', '--label', `io.kubernetes.cri.sandbox-id=${vm}`,
					'--user', '65532:65532',
					'--mount', `type=bind,src=${attached.device},dst=/workspace/project,options=${verify ? 'ro' : 'rw'}:nodev:nosuid`,
					'--mount', `type=bind,src=${incoming},dst=/run/treeseed-builder,options=rbind:ro`,
					'--mount', `type=bind,src=${outgoing},dst=/run/treeseed-output,options=rbind:rw`,
					guestImage, child, 'node', '/run/treeseed-builder/builder.mjs', verify ? 'verify' : 'build']);
				const path = join(outgoing, 'source-verification.json'), details = await lstat(path);
				if (!details.isFile() || details.size > 8192) throw new Error('Invalid isolated source verification receipt.');
				const receipt = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
				if (receipt.commit !== input.source.commit || receipt.clean !== true || receipt.objectClosure !== true || receipt.sourceOnly !== true) throw new Error('Isolated source verification failed.');
				await rm(path);
			} finally {
				await operations.destroy(vm);
				await ctr(['tasks', 'delete', '--force', child]).catch(() => undefined);
				await ctr(['containers', 'delete', child]).catch(() => undefined);
				if ((await ctr(['tasks', 'list', '--quiet'])).split(/\s+/u).includes(child)) throw new Error('Source builder remains active; storage is quarantined.');
				guestStopped = true;
			}
			await detachWorkspaceDisk(attached, guestStopped); attached = undefined; transportUncertain = false;
		}
		await exec('/usr/bin/qemu-img', ['check', '-f', 'qcow2', disk.image], { timeout: 120_000, maxBuffer: 65_536 });
		const imageDigest = await digest(disk.image), bytes = (await lstat(disk.image)).size;
		await chmod(disk.image, 0o400);
		// Exclusive link: never overwrite an existing READY image or a crash-recovery target.
		await link(disk.image, workspaceImagePath(image.id));
		for (const path of [workspaceImagePath(image.id), join(workspaceStorageRoot, 'images')]) {
			const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
		}
		catalog.publish(image.id, jobId, { digest: imageDigest, bytes, commit: input.source.commit,
			clean: true, filesystemVerified: true, builderStopped: guestStopped });
		await rm(disk.directory, { recursive: true });
		return { imageId: image.id, digest: imageDigest, bytes, noop: false };
	} catch (error) {
		if (attached && guestStopped) { await detachWorkspaceDisk(attached, true); attached = undefined; transportUncertain = false; }
		// Uncertain transport/VM state keeps the build owner and its ancestor pins, never automatic GC.
		if (guestStopped && !transportUncertain) catalog.failBuild(image.id, jobId);
		throw error;
	}
}
