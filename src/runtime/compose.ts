import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parse } from 'yaml';
import type { ComponentRelease } from '@treeseed/sdk/deployment';

interface ComposeService { build?: unknown; image?: string; ports?: unknown; network_mode?: string; volumes?: string[] }
interface ComposeDocument { services?: Record<string, ComposeService>; networks?: Record<string, unknown> }

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
		}
		for (const service of services) if (!document.services[service]) throw new Error(`Declared service ${service} is absent from ${file}.`);
	}
}
