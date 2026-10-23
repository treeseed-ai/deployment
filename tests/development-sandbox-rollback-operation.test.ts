import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ sessionId: 'dev-sandbox-rollback-operation', source: '', stateRoot: '', fsRoot: '', fault: '',
	providerFailure: false, providerSelected: true, initialStates: { manager: true, runner: true }, brokerActive: true, states: { manager: true, runner: true },
	guestDigest: `sha256:${'a'.repeat(64)}`, hostDigest: `sha256:${'a'.repeat(64)}`, bindCalls: [] as string[], recordCalls: [] as string[] }));
vi.mock('../src/manager/development-sessions.js', () => ({ DevelopmentSessionStore: class { load() { return { session: {
	sessionId: fixture.sessionId, status: 'active', repositories: [{ projectId: 'agent', worktree: fixture.source }], routes: [],
	targets: [{ projectId: 'agent', targetId: 'provider', mode: fixture.providerSelected ? 'candidate' : 'released' }, { projectId: 'agent', targetId: 'sandbox', mode: 'candidate' }],
} }; } } }));
vi.mock('../src/core/configuration.js', () => ({ loadHostConfiguration: () => ({ components: { agent: { configuration: { files: { 'treeseed.capacity-provider.yaml': 'schemaVersion: 5\n' } } } } }) }));
vi.mock('../src/supervisor/component.js', async original => ({ ...await original<typeof import('../src/supervisor/component.js')>(), componentStateRoot: () => fixture.stateRoot }));
vi.mock('../src/manager/current-state.js', () => ({ loadActiveComponents: () => [{ componentId: 'agent' }] }));
vi.mock('../src/manager/reconcile.js', () => ({ composeFiles: () => [], managedContainerDevelopmentConnectionEnvironment: () => ({}) }));
vi.mock('../src/supervisor/compose-runtime.js', async original => ({ ...await original<typeof import('../src/supervisor/compose-runtime.js')>(), componentComposeArguments: () => [] }));
vi.mock('../src/supervisor/development-runtime-copy.js', async original => ({ ...await original<typeof import('../src/supervisor/development-runtime-copy.js')>(),
	copyDevelopmentRuntime: ({ destination }: { destination: string }) => { mkdirSync(resolve(destination, 'dist'), { recursive: true }); writeFileSync(resolve(destination, 'dist/main.js'), 'candidate'); return { digest: `sha256:${'c'.repeat(64)}` }; },
}));
vi.mock('../src/supervisor/sandbox-guest-import.js', () => ({
	configuredSandboxGuestDigest: () => fixture.guestDigest,
	importSandboxGuestArchive: () => { if (fixture.fault === 'import') throw new Error('fixture import failure'); return { digest: `sha256:${'b'.repeat(64)}`, image: 'treeseed/sandbox-codex:local' }; },
	bindExistingSandboxGuestTrust: (digest: string) => { fixture.bindCalls.push(digest); fixture.guestDigest = digest; },
}));
vi.mock('../src/supervisor/host-development.js', () => ({ recordHostDevelopmentGuestImage: (digest: string) => { fixture.recordCalls.push(digest); fixture.hostDigest = digest; } }));
vi.mock('../src/sandbox/configuration.js', () => ({ loadSandboxBrokerConfiguration: () => ({ containerdAddress: '/run/containerd/containerd.sock', namespace: 'test' }) }));
vi.mock('../src/sandbox/doctor.js', () => ({ inspectVmProcesses: () => ({ complete: true, processes: [] }) }));
vi.mock('node:fs', async original => {
	const fs = await original<typeof import('node:fs')>();
	const remap = (path: unknown) => typeof path === 'string' && path.startsWith('/run/treeseed/development-containers')
		? fixture.fsRoot + path.slice('/run/treeseed/development-containers'.length) : path;
	return { ...fs,
		existsSync: (path: Parameters<typeof fs.existsSync>[0]) => fs.existsSync(remap(path) as string),
		lstatSync: (path: Parameters<typeof fs.lstatSync>[0]) => {
		const stat = fs.lstatSync(remap(path) as string);
		return String(path) === fixture.source ? { ...stat, uid: 1000 } : stat;
	}, mkdirSync: (path: Parameters<typeof fs.mkdirSync>[0], options?: Parameters<typeof fs.mkdirSync>[1]) => fs.mkdirSync(remap(path) as string, options),
		mkdtempSync: (prefix: Parameters<typeof fs.mkdtempSync>[0], options?: Parameters<typeof fs.mkdtempSync>[1]) => fs.mkdtempSync(remap(prefix) as string, options),
		openSync: (path: Parameters<typeof fs.openSync>[0], flags: Parameters<typeof fs.openSync>[1], mode?: number) => fs.openSync(remap(path) as string, flags, mode),
		chownSync: (path: Parameters<typeof fs.chownSync>[0], uid: number, gid: number) => { if (!String(path).startsWith('/run/treeseed/development-containers')) fs.chownSync(remap(path) as string, uid, gid); },
		chmodSync: (path: Parameters<typeof fs.chmodSync>[0], mode: Parameters<typeof fs.chmodSync>[1]) => fs.chmodSync(remap(path) as string, mode),
		readFileSync: (path: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => fs.readFileSync(remap(path) as string, ...(args as [BufferEncoding])),
		writeFileSync: (path: Parameters<typeof fs.writeFileSync>[0], data: Parameters<typeof fs.writeFileSync>[1], options?: Parameters<typeof fs.writeFileSync>[2]) => fs.writeFileSync(remap(path) as string, data, options),
		rmSync: (path: Parameters<typeof fs.rmSync>[0], options?: Parameters<typeof fs.rmSync>[1]) => fs.rmSync(remap(path) as string, options),
		renameSync: (from: Parameters<typeof fs.renameSync>[0], to: Parameters<typeof fs.renameSync>[1]) => fs.renameSync(remap(from) as string, remap(to) as string),
		cpSync: (...args: Parameters<typeof fs.cpSync>) => {
		if (fixture.fault === 'copy') {
			const [source_, destination_] = args;
			const source = remap(source_) as string, destination = remap(destination_) as string;
			fs.mkdirSync(destination, { recursive: true });
			const first = fs.readdirSync(source, { withFileTypes: true }).find(entry => entry.isFile());
			if (first) fs.copyFileSync(resolve(source, first.name), resolve(destination, first.name));
			throw new Error('fixture partial copy failure');
		}
		return fs.cpSync(remap(args[0]) as string, remap(args[1]) as string, args[2]);
	} };
});

import { executeAgentDevelopmentContainer } from '../src/supervisor/development-agent-container.js';

const temporary: string[] = [];
afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
	const work = `/run/treeseed/development-containers/${fixture.sessionId}`;
	rmSync(work, { recursive: true, force: true });
	rmSync(fixture.fsRoot, { recursive: true, force: true });
	fixture.fault = ''; fixture.providerFailure = false; fixture.providerSelected = true; fixture.initialStates = { manager: true, runner: true }; fixture.brokerActive = true; fixture.states = { manager: true, runner: true };
	fixture.guestDigest = `sha256:${'a'.repeat(64)}`; fixture.hostDigest = fixture.guestDigest; fixture.bindCalls = []; fixture.recordCalls = [];
});

function setup(fault: string) {
	fixture.fault = fault;
	fixture.states = { ...fixture.initialStates };
	const sourceParent = mkdtempSync(resolve(tmpdir(), 'sandbox-rollback-parent-')); temporary.push(sourceParent);
	const source = mkdtempSync(resolve(sourceParent, 'source-')); temporary.push(source); fixture.source = source;
	fixture.fsRoot = mkdtempSync(resolve(tmpdir(), 'sandbox-rollback-run-')); temporary.push(fixture.fsRoot);
	for (const path of ['treeseed.package.yaml', 'Dockerfile', 'Dockerfile.sandbox-codex', '.git/HEAD', 'dist/sandbox/guest.js', 'dist/main.js', '.treeseed/docker/runtime/shared/node_modules/.keep']) {
		const file = resolve(source, path); mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, path.endsWith('node_modules/.keep') ? '' : 'fixture');
	}
	fixture.stateRoot = mkdtempSync(resolve(tmpdir(), 'sandbox-rollback-state-')); temporary.push(fixture.stateRoot);
	mkdirSync(resolve(fixture.stateRoot, 'runtime'), { recursive: true });
	writeFileSync(resolve(fixture.stateRoot, 'runtime/capacity-state.json'), JSON.stringify({ schemaVersion: 1, claims: [
		{ id: 'retained-unresolved', status: 'unresolved', usage: { source: 'original-provider', amount: 'unknown' }, source: { assignmentId: 'original-assignment' } },
	] }));
	const provider = `/run/treeseed/development-containers/${fixture.sessionId}/agent/provider`;
	rmSync(`/run/treeseed/development-containers/${fixture.sessionId}`, { recursive: true, force: true });
	const sandbox = `/run/treeseed/development-containers/${fixture.sessionId}/agent/sandbox`;
	mkdirSync(sandbox, { recursive: true });
	const priorReceipt = Buffer.from(JSON.stringify({ schemaVersion: 1, sessionId: fixture.sessionId, priorDigest: `sha256:${'c'.repeat(64)}`,
		digest: `sha256:${'a'.repeat(64)}`, image: 'treeseed/sandbox-codex:local' }));
	writeFileSync(resolve(sandbox, 'receipt.json'), priorReceipt);
	if (fault !== 'first-start') { mkdirSync(provider, { recursive: true }); writeFileSync(resolve(provider, 'settings.json'), 'prior-settings'); writeFileSync(resolve(provider, 'extra.json'), 'prior-extra'); }
	const original = fault === 'first-start' ? null : readFileSync(resolve(provider, 'settings.json'));
	const commands: string[][] = [];
	const command = (executable: string, args: readonly string[]) => {
		commands.push([...args]);
		if (executable === '/usr/bin/docker' && args[0] === 'inspect') {
			const service = String(args[1]).includes('manager') ? 'manager' : 'runner';
			return JSON.stringify({ labels: { 'com.docker.compose.project': 'treeseed-agent', 'com.docker.compose.service': service }, running: fixture.states[service], environment: [], mounts: [] });
		}
		if (executable === '/usr/bin/docker' && args[0] === 'stop') { fixture.states[String(args.at(-1)).includes('manager') ? 'manager' : 'runner'] = false; return ''; }
		if (executable === '/usr/bin/docker' && args[0] === 'start') {
			if (fixture.fault === 'restore' && String(args.at(-1)).includes('manager')) throw new Error('fixture provider restoration failure');
			fixture.states[String(args.at(-1)).includes('manager') ? 'manager' : 'runner'] = true; return '';
		}
		if (executable === '/usr/bin/docker' && args[0] === 'image' && args[1] === 'save') { writeFileSync(String(args[args.indexOf('--output') + 1]), Buffer.alloc(2048, 1)); return ''; }
		if (executable === '/usr/bin/docker' && args[0] === 'compose') {
			if (fixture.providerFailure) throw new Error('fixture provider start failure');
			fixture.states = { manager: true, runner: true }; return '';
		}
		if (executable === '/usr/bin/systemctl' && args[0] === 'stop') { fixture.brokerActive = false; return ''; }
		if (executable === '/usr/bin/systemctl' && args[0] === 'start') { fixture.brokerActive = true; return ''; }
		if (executable === '/usr/bin/systemctl' && args[0] === 'show') return fixture.brokerActive ? 'active' : 'inactive';
		if (executable === '/usr/bin/ctr' && args.at(-2) === 'list') return '';
		return '';
	};
	return { provider, original, priorReceipt, source, commands, command };
}

it.each(['copy', 'import', 'start', 'restore'])('runs %s failure through sandbox start rollback and retains provider, guest, host, receipt, and claims', fault => {
	const f = setup(fault);
	fixture.providerFailure = fault === 'start' || fault === 'restore';
	const claims = readFileSync(resolve(fixture.stateRoot, 'runtime/capacity-state.json'));
	expect(() => executeAgentDevelopmentContainer({ sessionId: fixture.sessionId, projectId: 'agent', targetId: 'sandbox', action: 'start' }, f.command)).toThrow();
	if (f.original) {
		expect(readFileSync(resolve(f.provider, 'settings.json'))).toEqual(f.original);
		expect(readFileSync(resolve(f.provider, 'extra.json'), 'utf8')).toBe('prior-extra');
		expect(existsSync(resolve(f.provider, 'provider-prior'))).toBe(false);
	}
	expect(readFileSync(resolve(fixture.stateRoot, 'runtime/capacity-state.json'))).toEqual(claims);
	expect(readFileSync(resolve(f.source, 'dist/main.js'), 'utf8')).toBe('fixture');
	expect(f.commands.some(args => args[0] === 'build')).toBe(true);
	expect(f.commands.some(args => args[0] === 'stop' && args[1] === 'treeseed-sandbox-broker.service')).toBe(true);
	expect(fixture.guestDigest).toBe(`sha256:${'a'.repeat(64)}`);
	expect(fixture.hostDigest).toBe(`sha256:${'a'.repeat(64)}`);
	const receiptPath = `/run/treeseed/development-containers/${fixture.sessionId}/agent/sandbox/receipt.json`;
	expect(readFileSync(receiptPath)).toEqual(f.priorReceipt);
	expect(fixture.brokerActive, JSON.stringify({ fault, commands: f.commands, binds: fixture.bindCalls })).toBe(fault !== 'restore');
	if (fault === 'copy') {
		expect(existsSync(resolve(`/run/treeseed/development-containers/${fixture.sessionId}/agent/sandbox`, 'provider-prior'))).toBe(false);
		expect(f.commands.some(args => args[0] === 'import')).toBe(false);
		fixture.fault = '';
		expect(executeAgentDevelopmentContainer({ sessionId: fixture.sessionId, projectId: 'agent', targetId: 'sandbox', action: 'start' }, f.command)).toMatchObject({ started: true });
		expect(existsSync(resolve(`/run/treeseed/development-containers/${fixture.sessionId}/agent/sandbox`, 'provider-prior'))).toBe(false);
	}
	if (fault === 'restore') expect(fixture.states).toEqual({ manager: false, runner: false });
	else expect(fixture.states).toEqual({ manager: true, runner: true });
});

it.each([
	{ providerSelected: true, manager: true, runner: true },
	{ providerSelected: true, manager: true, runner: false },
	{ providerSelected: true, manager: false, runner: true },
	{ providerSelected: true, manager: false, runner: false },
	{ providerSelected: false, manager: true, runner: true },
	{ providerSelected: false, manager: true, runner: false },
	{ providerSelected: false, manager: false, runner: true },
	{ providerSelected: false, manager: false, runner: false },
])('restores exact initial roles after failed guest import ($providerSelected, manager=$manager, runner=$runner)', ({ providerSelected, manager, runner }) => {
	fixture.providerSelected = providerSelected;
	fixture.initialStates = { manager, runner };
	const f = setup('import');
	const original = { ...fixture.initialStates };
	expect(() => executeAgentDevelopmentContainer({ sessionId: fixture.sessionId, projectId: 'agent', targetId: 'sandbox', action: 'start' }, f.command)).toThrow();
	expect(fixture.states).toEqual(original);
	expect(fixture.brokerActive).toBe(true);
	const roleStarts = f.commands.filter(args => args[0] === 'start' && /^treeseed-agent-(?:runner|manager)-1$/u.test(String(args.at(-1)))).map(args => args.at(-1));
	expect(roleStarts).toEqual([...(runner ? ['treeseed-agent-runner-1'] : []), ...(manager ? ['treeseed-agent-manager-1'] : [])]);
	const brokerStart = f.commands.findIndex(args => args[0] === 'start' && args[1] === 'treeseed-sandbox-broker.service');
	const lastRoleStart = Math.max(...f.commands.map((args, index) => args[0] === 'start' && /^treeseed-agent-(?:runner|manager)-1$/u.test(String(args.at(-1))) ? index : -1));
	expect(brokerStart).toBeGreaterThan(lastRoleStart);
});
