import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import YAML from 'yaml';
import type { HostConfiguration } from '@treeseed/sdk/deployment';
import { readComponentCredential } from './component-sealed.js';
import { loadHostConfiguration } from '../core/configuration.js';

function bindingDigest(host: HostConfiguration, componentId: string, secretIds: string[]) {
	const configuration = host.components[componentId];
	const ids = [...new Set([...Object.values(configuration?.configuration?.secretEnvironment ?? {}), ...secretIds])].sort();
	return createHash('sha256').update(JSON.stringify({ configuration, secrets: ids.map(id => [id, host.secrets[String(id)]]) })).digest('hex');
}

export function componentRuntimeRoot(componentId: string) {
	if (!/^[a-z][a-z0-9.-]+$/u.test(componentId)) throw new Error('Invalid component runtime identity.');
	return `/run/treeseed/component-runtime/${componentId}`;
}

function privateWrite(path: string, value: string, gid: number) {
	if (existsSync(path) && readFileSync(path, 'utf8') === value) return;
	const temporary = `${path}.${randomUUID()}`;
	try {
		writeFileSync(temporary, value, { flag: 'wx', mode: 0o640 });
		chownSync(temporary, 0, gid); renameSync(temporary, path);
	} finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function usesSealedComponentCredentials(host: HostConfiguration, componentId: string, secretIds: readonly string[]) {
	const environment = host.components[componentId]?.configuration?.secretEnvironment ?? {};
	return [...Object.values(environment), ...secretIds].some(id => typeof id === 'string' && host.secrets[id]?.provider === 'systemd-credential');
}

/** Debian creates an empty input placeholder; it has no credential content to migrate. */
export function assertEmptyPersistentPlaceholder(path: string, inspect: (path: string) => Pick<Stats, 'isFile' | 'isSymbolicLink' | 'uid' | 'size' | 'mode'> = lstatSync) {
	let metadata;
	try { metadata = inspect(path); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0 || metadata.size !== 0 || (metadata.mode & 0o027))
		throw new Error('Existing persistent component inputs require an explicit custody migration before sealed activation.');
}

/** Only the supervisor writes this directory; the descriptor contains paths, never values. */
export function prepareEphemeralComponentInputs(host: HostConfiguration, componentId: string, environment: string, secretIds: readonly string[], gid: number) {
	const root = componentRuntimeRoot(componentId);
	assertEmptyPersistentPlaceholder(`/etc/treeseed/components/${componentId}/environment`);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const metadata = lstatSync(root);
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0) throw new Error('Unsafe component runtime custody.');
	chmodSync(root, 0o700);
	const secrets: Record<string, { file: string }> = {};
	const pending = new Map<string, string>();
	for (const id of secretIds) {
		if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(id)) throw new Error('Invalid component secret identity.');
		const secret = host.secrets[id];
		if (secret?.provider !== 'systemd-credential') continue;
		if (!secret.reference.endsWith('.cred')) throw new Error('OS credential reference must identify a sealed record.');
		const value = readComponentCredential(host, id, secret.reference.slice(0, -5));
		const path = resolve(root, `secret-${id}`);
		if (existsSync(path) && readFileSync(path, 'utf8') !== value) throw new Error('Changed component secret requires coordinated rotation before activation.');
		pending.set(path, value); secrets[id] = { file: path };
	}
	for (const [path, value] of pending) privateWrite(path, value, gid);
	privateWrite(resolve(root, 'environment'), environment, gid);
	privateWrite(resolve(root, 'inputs.json'), JSON.stringify({ secrets, secretIds, bindingDigest: bindingDigest(host, componentId, [...secretIds]) }), gid);
	return Object.keys(secrets);
}

/** Preserve all package-owned settings; replace only its environment file and named secret sources. */
export function ephemeralComposeOverlay(componentId: string, sources: string[], secrets: Record<string, { file: string }>) {
	const root = componentRuntimeRoot(componentId), oldEnvironment = `/etc/treeseed/components/${componentId}/environment`;
	const services: Record<string, unknown> = {};
	for (const source of sources) {
		const parsed = YAML.parse(source) as { services?: Record<string, { env_file?: unknown }> };
		for (const [name, service] of Object.entries(parsed.services ?? {})) {
			if (service.env_file === undefined) continue;
			const files = Array.isArray(service.env_file) ? service.env_file : [service.env_file];
			const replaced = files.map(file => file === oldEnvironment ? resolve(root, 'environment')
				: file && typeof file === 'object' && 'path' in file && file.path === oldEnvironment ? { ...file, path: resolve(root, 'environment') } : file);
			if (JSON.stringify(files) !== JSON.stringify(replaced)) {
				if (services[name]) throw new Error('Layered component environment files require an explicit merged declaration.');
				services[name] = { env_file: replaced };
			}
		}
	}
	for (const [id, value] of Object.entries(secrets)) {
		if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(id) || value.file !== resolve(root, `secret-${id}`)) throw new Error('Invalid ephemeral secret binding.');
	}
	const document = new YAML.Document({ services, secrets });
	for (const name of Object.keys(services)) (document.getIn(['services', name, 'env_file']) as YAML.YAMLSeq).tag = '!override';
	return document.toString();
}

export function ephemeralComposeArguments(componentId: string, files: string[]) {
	const root = componentRuntimeRoot(componentId), marker = resolve(root, 'inputs.json');
	if (!existsSync(marker)) return null;
	const metadata = lstatSync(marker);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o027)) throw new Error('Unsafe ephemeral component descriptor.');
	const inputs = JSON.parse(readFileSync(marker, 'utf8')) as { secrets: Record<string, { file: string }>; secretIds: string[]; bindingDigest: string };
	if (!Array.isArray(inputs.secretIds) || inputs.secretIds.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(id))
		|| inputs.bindingDigest !== bindingDigest(loadHostConfiguration(), componentId, inputs.secretIds)) throw new Error('Component credential bindings changed; reconcile runtime inputs before execution.');
	const overlay = ephemeralComposeOverlay(componentId, files.map(path => readFileSync(path, 'utf8')), inputs.secrets);
	const path = resolve(root, 'compose.yaml');
	privateWrite(path, overlay, metadata.gid);
	return { environment: resolve(root, 'environment'), overlay: path };
}
