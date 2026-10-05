import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { providerEnvironmentProfileDescriptorSchema, type ProviderEnvironmentProfileDescriptor } from '@treeseed/sdk/capacity-provider/contracts';
import { z } from 'zod';
import { providerSecuritySettings, providerSecurityStatus } from './provider-volume.js';

const profileIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/u);
const variableNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/u);
const custodySchema = z.object({
	schemaVersion: z.literal('treeseed.provider-environment-profile-custody/v1'), id: profileIdSchema,
	generation: z.number().int().positive(), variables: z.record(variableNameSchema, z.object({ rotatedAt: z.string().datetime() }).strict()),
	updatedAt: z.string().datetime(),
}).strict();
type Custody = z.infer<typeof custodySchema>;

function checkedDirectory(path: string) {
	if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Provider environment custody directories may not be symbolic links.');
	mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700);
}

export function providerEnvironmentRoot() {
	const settings = providerSecuritySettings(), status = providerSecurityStatus();
	if (!status.mounted || !status.mapperOpen || !status.credentialKeksReady) throw new Error('Provider environment custody requires the initialized encrypted provider volume.');
	const root = resolve(settings.mount, 'environment-profiles');
	if (!root.startsWith(`${settings.mount}/`)) throw new Error('Provider environment custody escaped the configured provider volume.');
	return root;
}

function paths(root: string, profileId: string) {
	const id = profileIdSchema.parse(profileId), profile = resolve(root, id), values = resolve(profile, 'values');
	if (!profile.startsWith(`${resolve(root)}/`)) throw new Error('Provider environment profile escaped its custody root.');
	return { id, profile, values, metadata: resolve(profile, 'profile.json') };
}

function load(root: string, profileId: string): Custody {
	const target = paths(root, profileId);
	if (existsSync(target.profile) && lstatSync(target.profile).isSymbolicLink()) throw new Error('Provider environment profile directories may not be symbolic links.');
	if (existsSync(target.values) && lstatSync(target.values).isSymbolicLink()) throw new Error('Provider environment value directories may not be symbolic links.');
	if (!existsSync(target.metadata)) throw new Error(`Provider environment profile ${target.id} does not exist.`);
	if (lstatSync(target.metadata).isSymbolicLink()) throw new Error('Provider environment metadata may not be a symbolic link.');
	return custodySchema.parse(JSON.parse(readFileSync(target.metadata, 'utf8')));
}

function descriptor(root: string, custody: Custody): ProviderEnvironmentProfileDescriptor {
	const target = paths(root, custody.id);
	return providerEnvironmentProfileDescriptorSchema.parse({ schemaVersion: 'treeseed.provider-environment-profile/v1', id: custody.id,
		generation: custody.generation, updatedAt: custody.updatedAt,
		variables: Object.entries(custody.variables).sort(([left], [right]) => left.localeCompare(right)).map(([name, metadata]) => {
			const value = resolve(target.values, name);
			return { name, available: existsSync(value) && !lstatSync(value).isSymbolicLink(), rotatedAt: metadata.rotatedAt };
		}),
	});
}

function atomicWrite(path: string, value: string, mode: number) {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try { writeFileSync(temporary, value, { mode, flag: 'wx' }); renameSync(temporary, path); chmodSync(path, mode); }
	finally { rmSync(temporary, { force: true }); }
}

function write(root: string, custody: Custody) {
	const target = paths(root, custody.id); checkedDirectory(root); checkedDirectory(target.profile); checkedDirectory(target.values);
	atomicWrite(target.metadata, `${JSON.stringify(custodySchema.parse(custody))}\n`, 0o600);
}

function validateValue(value: string) {
	if (Buffer.byteLength(value) > 1_048_576) throw new Error('Provider environment values cannot exceed one MiB.');
	if (value.includes('\0')) throw new Error('Provider environment values cannot contain NUL bytes.');
	return value;
}

function saveValues(root: string, profileId: string, values: Record<string, string>, rotate: boolean) {
	const target = paths(root, profileId), current = existsSync(target.metadata) ? load(root, target.id) : null, now = new Date().toISOString();
	checkedDirectory(root); checkedDirectory(target.profile); checkedDirectory(target.values);
	let changed = current === null;
	const variables = { ...(current?.variables ?? {}) };
	for (const [rawName, rawValue] of Object.entries(values)) {
		const name = variableNameSchema.parse(rawName), value = validateValue(rawValue), path = resolve(target.values, name);
		if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Provider environment values may not be symbolic links.');
		const same = existsSync(path) && readFileSync(path, 'utf8') === value;
		if (!same || rotate) { atomicWrite(path, value, 0o600); variables[name] = { rotatedAt: now }; changed = true; }
	}
	const next: Custody = { schemaVersion: 'treeseed.provider-environment-profile-custody/v1', id: target.id,
		generation: changed ? (current?.generation ?? 0) + 1 : current!.generation, variables, updatedAt: changed ? now : current!.updatedAt };
	write(root, next); return descriptor(root, next);
}

export function parseProviderEnvironmentFile(source: string) {
	if (Buffer.byteLength(source) > 1_048_576) throw new Error('Provider environment files cannot exceed one MiB.');
	const values: Record<string, string> = {};
	for (const [index, line] of source.split(/\r?\n/u).entries()) {
		if (!line.trim() || line.trimStart().startsWith('#')) continue;
		const separator = line.indexOf('=');
		if (separator < 1) throw new Error(`Provider environment file line ${index + 1} is malformed.`);
		const name = variableNameSchema.parse(line.slice(0, separator));
		if (Object.hasOwn(values, name)) throw new Error(`Provider environment file contains duplicate variable ${name}.`);
		values[name] = validateValue(line.slice(separator + 1));
	}
	if (!Object.keys(values).length) throw new Error('Provider environment file contains no values.');
	return values;
}

export function listProviderEnvironmentProfiles(root = providerEnvironmentRoot()) {
	if (!existsSync(root)) return { items: [], nextCursor: null };
	if (lstatSync(root).isSymbolicLink()) throw new Error('Provider environment custody root may not be a symbolic link.');
	const entries = readdirSync(root, { withFileTypes: true });
	if (entries.some((entry) => entry.isSymbolicLink())) throw new Error('Provider environment custody entries may not be symbolic links.');
	const items = entries.filter((entry) => entry.isDirectory() && profileIdSchema.safeParse(entry.name).success).map((entry) => descriptor(root, load(root, entry.name)))
		.sort((left, right) => left.id.localeCompare(right.id));
	return { items, nextCursor: null };
}

export function showProviderEnvironmentProfile(profileId: string, root = providerEnvironmentRoot()) { return descriptor(root, load(root, profileId)); }
export function setProviderEnvironmentValue(profileId: string, name: string, value: string, root = providerEnvironmentRoot()) { return saveValues(root, profileId, { [name]: value }, false); }
export function rotateProviderEnvironmentValue(profileId: string, name: string, value: string, root = providerEnvironmentRoot()) {
	const current = load(root, profileId); if (!Object.hasOwn(current.variables, variableNameSchema.parse(name))) throw new Error('Provider environment value cannot be rotated before it is set.');
	return saveValues(root, profileId, { [name]: value }, true);
}
export function importProviderEnvironmentValues(profileId: string, source: string, root = providerEnvironmentRoot()) { return saveValues(root, profileId, parseProviderEnvironmentFile(source), false); }
export function unsetProviderEnvironmentValue(profileId: string, name: string, root = providerEnvironmentRoot()) {
	const target = paths(root, profileId), current = load(root, profileId), selected = variableNameSchema.parse(name);
	if (!Object.hasOwn(current.variables, selected)) return descriptor(root, current);
	const path = resolve(target.values, selected); if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Provider environment values may not be symbolic links.');
	if (existsSync(path)) unlinkSync(path);
	const variables = { ...current.variables }; delete variables[selected]; const now = new Date().toISOString();
	const next = { ...current, generation: current.generation + 1, variables, updatedAt: now }; write(root, next); return descriptor(root, next);
}

type ProviderEnvironmentOperation =
	| { operation: 'provider.environment.list' }
	| { operation: 'provider.environment.show'; profileId: string }
	| { operation: 'provider.environment.set' | 'provider.environment.rotate'; profileId: string; name: string; value: string }
	| { operation: 'provider.environment.import'; profileId: string; envFile: string }
	| { operation: 'provider.environment.unset'; profileId: string; name: string };

export function executeProviderEnvironmentOperation(operation: ProviderEnvironmentOperation) {
	if (operation.operation === 'provider.environment.list') return listProviderEnvironmentProfiles();
	if (operation.operation === 'provider.environment.show') return showProviderEnvironmentProfile(operation.profileId);
	if (operation.operation === 'provider.environment.import') return importProviderEnvironmentValues(operation.profileId, operation.envFile);
	if (operation.operation === 'provider.environment.unset') return unsetProviderEnvironmentValue(operation.profileId, operation.name);
	return operation.operation === 'provider.environment.rotate' ? rotateProviderEnvironmentValue(operation.profileId, operation.name, operation.value)
		: setProviderEnvironmentValue(operation.profileId, operation.name, operation.value);
}
