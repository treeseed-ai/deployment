import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import type { ComponentRelease } from '@treeseed/sdk/deployment';

interface ComposeVolume { type?: string; source?: string; target?: string; read_only?: boolean }
interface ComposeService { build?: unknown; image?: string; ports?: unknown; network_mode?: string; volumes?: Array<string | ComposeVolume>; healthcheck?: unknown }
interface ComposeDocument { services?: Record<string, ComposeService>; networks?: Record<string, unknown> }

const managedBindRoots = ['/etc/treeseed', '/run/treeseed', '/var/lib/treeseed'] as const;

function volumeSource(volume: string | ComposeVolume) {
	if (typeof volume !== 'string') return volume.type === 'bind' ? volume.source : undefined;
	const source = volume.split(':', 1)[0];
	return source?.startsWith('.') || source?.startsWith('/') ? source : undefined;
}

function validateVolumes(serviceName: string, volumes: Array<string | ComposeVolume> = []) {
	for (const volume of volumes) {
		const source = volumeSource(volume);
		if (!source) continue;
		if (!isAbsolute(source)) throw new Error(`${serviceName} uses a forbidden relative source mount: ${source}.`);
		const absolute = resolve(source);
		if (!managedBindRoots.some((root) => absolute === root || absolute.startsWith(`${root}${sep}`))) throw new Error(`${serviceName} uses a source mount outside manager-owned roots: ${source}.`);
	}
}

function within(root: string, path: string) {
	const absoluteRoot = resolve(root), absolutePath = resolve(root, path);
	if (absolutePath !== absoluteRoot && !absolutePath.startsWith(`${absoluteRoot}${sep}`)) throw new Error(`Compose path escapes component bundle: ${path}`);
	return absolutePath;
}

export function validateProductionCompose(release: ComponentRelease, bundleRoot: string) {
	const acceptedImages = new Set(release.images.map((image) => `${image.repository}@${image.digest}`));
	const services = new Set(release.runtime.services.map((service) => service.composeService));
	for (const file of release.runtime.compose.files) {
		const source = readFileSync(within(bundleRoot, file.path));
		const observed = `sha256:${createHash('sha256').update(source).digest('hex')}`;
		if (observed !== file.digest) throw new Error(`${file.path} does not match its accepted runtime digest.`);
		const document = parse(source.toString('utf8')) as ComposeDocument;
		if (!document.services || Object.keys(document.services).length === 0) throw new Error(`${file.path} has no Compose services.`);
		for (const [name, service] of Object.entries(document.services)) {
			if ('build' in service) throw new Error(`${name} uses forbidden Compose build configuration.`);
			if (!service.image || !acceptedImages.has(service.image)) throw new Error(`${name} does not use an accepted immutable image digest.`);
			if ('ports' in service) throw new Error(`${name} publishes a host port; manager-owned edge routing is required.`);
			if (service.network_mode === 'host') throw new Error(`${name} uses forbidden host networking.`);
			if (!service.healthcheck) throw new Error(`${name} has no Compose health gate.`);
			validateVolumes(name, service.volumes);
		}
		for (const service of services) if (!document.services[service]) throw new Error(`Declared service ${service} is absent from ${file}.`);
	}
}
