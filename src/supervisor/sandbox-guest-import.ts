import { readFileSync } from 'node:fs';
import { atomicJson } from '../core/files.js';
import { containerdImageReference } from '../sandbox/image-reference.js';
import { sandboxBrokerConfigurationSchema } from '../sandbox/protocol.js';
import type { CommandRunner } from './compose-runtime.js';

function hostArchitecture() {
	const architecture = process.arch === 'arm64' ? 'linux/arm64' : process.arch === 'x64' ? 'linux/amd64' : null;
	if (!architecture) throw new Error(`Unsupported sandbox host architecture ${process.arch}.`);
	return architecture;
}

export function configuredSandboxGuestDigest(path = '/etc/treeseed/sandbox/broker.json') {
	const current = sandboxBrokerConfigurationSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
	const digests = [...new Set(current.guestImages.map((entry) => entry.digest))];
	if (digests.length !== 1 || !/^sha256:[a-f0-9]{64}$/u.test(digests[0] ?? '')) throw new Error('Sandbox broker guest-image trust is not singular and immutable.');
	return digests[0]!;
}

export function bindExistingSandboxGuestTrust(digest: string, command: CommandRunner, path = '/etc/treeseed/sandbox/broker.json') {
	if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error('Sandbox guest digest is invalid.');
	const current = sandboxBrokerConfigurationSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
	for (const image of new Set(current.guestImages.map((entry) => entry.image))) {
		command('/usr/bin/ctr', ['--address', current.containerdAddress, '--namespace', current.namespace, 'images', 'inspect', containerdImageReference(image, digest)], '');
	}
	atomicJson(path, { ...current, guestImages: current.guestImages.map((entry) => ({ ...entry, digest })) }, 0o640);
	command('/usr/bin/systemctl', ['restart', 'treeseed-sandbox-broker.service']);
	return { changed: current.guestImages.some((entry) => entry.digest !== digest), digest };
}

export function importSandboxGuestArchive(archive: string, image: string, command: CommandRunner, brokerPath = '/etc/treeseed/sandbox/broker.json') {
	const current = sandboxBrokerConfigurationSchema.parse(JSON.parse(readFileSync(brokerPath, 'utf8')));
	const requested = image.replace(/^docker\.io\//u, '').replace(/:local$/u, '');
	const configured = [...new Set(current.guestImages.map(({ image: configuredImage }) => configuredImage.replace(/^docker\.io\//u, '').replace(/(?::[^/]+)?$/u, '')))];
	if (!configured.includes(requested)) throw new Error('Development sandbox image does not match an authorized provider image repository.');
	const architecture = hostArchitecture();
	const sourceImage = image.startsWith('docker.io/') ? image : `docker.io/${image}`;
	command('/usr/bin/ctr', ['--address', current.containerdAddress, '--namespace', current.namespace, 'images', 'import', '--platform', architecture, '--digests', archive]);
	const inspected = String(command('/usr/bin/ctr', ['--address', current.containerdAddress, '--namespace', current.namespace, 'images', 'inspect', sourceImage], '') ?? '');
	const digest = /\b(sha256:[a-f0-9]{64})\b/iu.exec(inspected)?.[1];
	if (!digest) throw new Error('Containerd did not report an immutable target digest for the imported development sandbox image.');
	for (const configuredImage of new Set(current.guestImages.map((entry) => entry.image))) command('/usr/bin/ctr', ['--address', current.containerdAddress, '--namespace', current.namespace, 'images', 'tag', '--force', sourceImage, containerdImageReference(configuredImage, digest)]);
	atomicJson(brokerPath, { ...current, guestImages: current.guestImages.map((entry) => ({ ...entry, digest })) }, 0o640);
	command('/usr/bin/systemctl', ['restart', 'treeseed-sandbox-broker.service']);
	return { image, digest, architecture, imported: true };
}
