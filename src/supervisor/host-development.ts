import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { z } from 'zod';
import { atomicJson } from '../core/files.js';
import type { CommandRunner } from './execute.js';

const defaultRoot = '/var/lib/treeseed/manager/host-development';
const defaultSystemdRoot = '/etc/systemd/system';
const units = ['treeseed-manager-supervisor.service', 'treeseed-manager-api.service', 'treeseed-sandbox-broker.service'] as const;
const entrypoints = {
	'treeseed-manager-supervisor.service': 'supervisor.js',
	'treeseed-manager-api.service': 'api.js',
	'treeseed-sandbox-broker.service': 'sandbox-broker.js',
} as const;

export const hostDevelopmentFileSchema = z.object({
	path: z.string().regex(/^(?:package\.json|dist\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+|node_modules\/(?:@treeseed\/(?:sdk|treedx)|typescript|yaml|zod)\/(?:[a-zA-Z0-9@._+-]+\/)*[a-zA-Z0-9@._+-]+)$/u).max(512),
	size: z.number().int().min(0).max(16_777_216),
	sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
}).strict();

export const hostDevelopmentActivationSchema = z.object({
	generationId: z.string().regex(/^dev-[0-9]{10,16}-[a-f0-9]{8}$/u),
	worktree: z.string().startsWith('/').max(4_096),
	packageSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
	files: z.array(hostDevelopmentFileSchema).min(3).max(4_096),
	guestImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
}).strict();

const stateSchema = z.object({
	schemaVersion: z.literal('treeseed.host-development-generation/v1'),
	generationId: z.string(),
	status: z.enum(['activating', 'active', 'deactivating', 'installed', 'rolled-back']),
	worktree: z.string(),
	manifestDigest: z.string(),
	guestImageDigest: z.string().nullable(),
	message: z.string().nullable(),
	updatedAt: z.string(),
}).strict();

type State = z.infer<typeof stateSchema>;

function digest(value: Buffer | string) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function state(input: Omit<State, 'schemaVersion' | 'updatedAt'>): State { return { schemaVersion: 'treeseed.host-development-generation/v1', ...input, updatedAt: new Date().toISOString() }; }
function writeState(value: State, hostRoot = defaultRoot) { mkdirSync(hostRoot, { recursive: true, mode: 0o750 }); atomicJson(`${hostRoot}/state.json`, value, 0o640); }

export function hostDevelopmentStatus(hostRoot = defaultRoot) {
	const statePath = `${hostRoot}/state.json`;
	if (!existsSync(statePath)) return state({ generationId: 'installed', status: 'installed', worktree: '', manifestDigest: '', guestImageDigest: null, message: null });
	return stateSchema.parse(JSON.parse(readFileSync(statePath, 'utf8')));
}

function verifiedSource(worktree: string, relativePath: string, expectedSize: number, expectedDigest: string) {
	const sourceRoot = realpathSync(worktree), source = resolve(sourceRoot, relativePath);
	if (!source.startsWith(`${sourceRoot}${sep}`)) throw new Error('Host development source escaped its worktree.');
	const metadata = lstatSync(source);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== expectedSize) throw new Error(`Host development source changed while staging: ${relativePath}.`);
	const content = readFileSync(source);
	if (digest(content) !== expectedDigest) throw new Error(`Host development source digest changed while staging: ${relativePath}.`);
	return content;
}

function dropIn(unit: typeof units[number], generationRoot: string, systemdRoot: string) {
	const directory = `${systemdRoot}/${unit}.d`, target = `${directory}/90-treeseed-host-development.conf`, temporary = `${target}.new`;
	mkdirSync(directory, { recursive: true, mode: 0o755 });
	const executable = `${generationRoot}/dist/src/bin/${entrypoints[unit]}`;
	writeFileSync(temporary, `[Service]\nExecStart=\nExecStart=/usr/lib/treeseed/runtime/bin/node ${executable}\n`, { mode: 0o644 });
	renameSync(temporary, target);
}

function schedule(action: 'activate' | 'deactivate', generationId: string, command: CommandRunner) {
	const unit = `treeseed-host-development-${action}-${generationId.replace(/[^a-zA-Z0-9_.-]/gu, '-')}`;
	command('/usr/bin/systemd-run', ['--unit', unit, '--collect', '--no-block', '/usr/lib/treeseed/runtime/bin/node', '/usr/lib/treeseed/manager/dist/src/bin/host-development-switch.js', action, generationId]);
}

export function activateHostDevelopment(input: unknown, command: CommandRunner, roots: { host?: string; systemd?: string } = {}) {
	const activation = hostDevelopmentActivationSchema.parse(input), sourceRoot = realpathSync(activation.worktree);
	const hostRoot = roots.host ?? defaultRoot, systemdRoot = roots.systemd ?? defaultSystemdRoot;
	if (!sourceRoot.endsWith('/deployment') || !existsSync(`${sourceRoot}/src/bin/supervisor.ts`)) throw new Error('Host development source must be a Deployment package worktree.');
	if (digest(readFileSync(`${sourceRoot}/package.json`)) !== activation.packageSha256) throw new Error('Host development package changed while staging.');
	const generationRoot = `${hostRoot}/generations/${activation.generationId}`, temporary = `${generationRoot}.new`;
	rmSync(temporary, { recursive: true, force: true }); mkdirSync(temporary, { recursive: true, mode: 0o750 });
	for (const file of activation.files) {
		const target = resolve(temporary, file.path);
		if (!target.startsWith(`${temporary}${sep}`)) throw new Error('Host development target escaped its generation.');
		mkdirSync(dirname(target), { recursive: true, mode: 0o750 });
		writeFileSync(target, verifiedSource(sourceRoot, file.path, file.size, file.sha256), { mode: 0o640 });
	}
	for (const entrypoint of Object.values(entrypoints)) if (!existsSync(`${temporary}/dist/src/bin/${entrypoint}`)) throw new Error(`Host development build omitted ${entrypoint}.`);
	renameSync(temporary, generationRoot); chmodSync(generationRoot, 0o750);
	command('/usr/bin/chown', ['-R', 'root:treeseed-manager', generationRoot]);
	const manifestDigest = digest(JSON.stringify(activation.files));
	writeState(state({ generationId: activation.generationId, status: 'activating', worktree: sourceRoot, manifestDigest, guestImageDigest: activation.guestImageDigest ?? null, message: null }), hostRoot);
	for (const unit of units) dropIn(unit, generationRoot, systemdRoot);
	command('/usr/bin/systemctl', ['daemon-reload']); schedule('activate', activation.generationId, command);
	return hostDevelopmentStatus(hostRoot);
}

export function deactivateHostDevelopment(command: CommandRunner, hostRoot = defaultRoot) {
	const current = hostDevelopmentStatus(hostRoot);
	if (current.status === 'installed') return current;
	writeState({ ...current, status: 'deactivating', message: null, updatedAt: new Date().toISOString() }, hostRoot);
	schedule('deactivate', current.generationId, command); return hostDevelopmentStatus(hostRoot);
}

export function switchHostDevelopment(action: 'activate' | 'deactivate', generationId: string, command: CommandRunner, roots: { host?: string; systemd?: string } = {}) {
	const hostRoot = roots.host ?? defaultRoot, systemdRoot = roots.systemd ?? defaultSystemdRoot, current = hostDevelopmentStatus(hostRoot);
	if (current.generationId !== generationId) throw new Error('Host development switch does not match the staged generation.');
	const removeDropIns = () => { for (const unit of units) rmSync(`${systemdRoot}/${unit}.d/90-treeseed-host-development.conf`, { force: true }); command('/usr/bin/systemctl', ['daemon-reload']); };
	if (action === 'deactivate') removeDropIns();
	try {
		command('/usr/bin/systemctl', ['restart', ...units]);
		for (const unit of units) command('/usr/bin/systemctl', ['is-active', '--quiet', unit]);
		writeState(state({ ...current, status: action === 'activate' ? 'active' : 'installed', message: null }), hostRoot);
	} catch (error) {
		removeDropIns(); command('/usr/bin/systemctl', ['restart', ...units]);
		writeState(state({ ...current, status: 'rolled-back', message: error instanceof Error ? error.message.slice(0, 1_024) : String(error).slice(0, 1_024) }), hostRoot);
		throw error;
	}
	return hostDevelopmentStatus(hostRoot);
}
