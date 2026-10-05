import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostedInfrastructureToolchain } from './toolchain.js';

const executeFile = promisify(execFile);

export type OpenTofuArchiveExtractor = (archive: string, destination: string) => Promise<void>;

export interface OpenTofuAcquisitionOptions {
	fetchImpl?: typeof fetch;
	platform?: NodeJS.Platform;
	arch?: string;
	extract?: OpenTofuArchiveExtractor;
}

export function openTofuArchive(platform: NodeJS.Platform = process.platform, arch: string = process.arch) {
	if (platform !== 'linux') throw new Error(`Deployment hosted infrastructure supports OpenTofu only on Linux runners; received ${platform}.`);
	const architecture = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null;
	if (!architecture) throw new Error(`Deployment hosted infrastructure does not support OpenTofu architecture ${arch}.`);
	const { version } = hostedInfrastructureToolchain.opentofu;
	const sha256 = architecture === 'amd64'
		? hostedInfrastructureToolchain.opentofu.linuxAmd64ArchiveSha256
		: hostedInfrastructureToolchain.opentofu.linuxArm64ArchiveSha256;
	return { architecture, sha256, url: `https://github.com/opentofu/opentofu/releases/download/v${version}/tofu_${version}_linux_${architecture}.tar.gz` };
}

async function extractOpenTofuArchive(archive: string, destination: string) {
	await executeFile('tar', ['-xzf', archive, '-C', destination, 'tofu'], { windowsHide: true });
}

export async function acquireOpenTofu(root: string, options: OpenTofuAcquisitionOptions = {}) {
	const directory = join(root, '.treeseed-tools', 'opentofu', hostedInfrastructureToolchain.opentofu.version);
	const binary = join(directory, 'tofu');
	try { await access(binary, constants.X_OK); return binary; } catch { /* acquire the exact locked binary */ }
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const archive = openTofuArchive(options.platform, options.arch);
	const response = await (options.fetchImpl ?? fetch)(archive.url);
	if (!response.ok) throw new Error(`OpenTofu ${hostedInfrastructureToolchain.opentofu.version} download failed (HTTP ${response.status}).`);
	const data = Buffer.from(await response.arrayBuffer());
	const actual = createHash('sha256').update(data).digest('hex');
	if (actual !== archive.sha256) throw new Error(`OpenTofu ${hostedInfrastructureToolchain.opentofu.version} archive failed digest verification.`);
	const archivePath = join(directory, 'opentofu.tar.gz');
	try {
		await writeFile(archivePath, data, { mode: 0o600 });
		await (options.extract ?? extractOpenTofuArchive)(archivePath, directory);
		await chmod(binary, 0o700);
		await access(binary, constants.X_OK);
		return binary;
	} catch (error) {
		await rm(binary, { force: true });
		throw error;
	} finally {
		await rm(archivePath, { force: true });
	}
}
