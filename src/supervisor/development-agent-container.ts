import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { atomicJson } from '../core/files.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { DevelopmentSessionStore, type ManagedDevelopmentSession } from '../manager/development-sessions.js';
import { loadActiveComponents } from '../manager/current-state.js';
import { composeFiles, managedContainerDevelopmentConnectionEnvironment } from '../manager/reconcile.js';
import { componentStateRoot } from './component.js';
import { componentComposeArguments, type CommandRunner } from './compose-runtime.js';
import { copyDevelopmentRuntime } from './development-runtime-copy.js';
import { bindExistingSandboxGuestTrust, configuredSandboxGuestDigest, importSandboxGuestArchive } from './sandbox-guest-import.js';
import { recordHostDevelopmentGuestImage } from './host-development.js';

const root = '/run/treeseed/development-containers';
const projectName = 'treeseed-agent';
const services = ['manager', 'runner'] as const;

interface AgentDevelopmentInput {
	sessionId: string;
	projectId: 'agent';
	targetId: 'provider' | 'sandbox';
	action: 'start' | 'stop' | 'status' | 'logs';
}

function sourceFor(record: ManagedDevelopmentSession) {
	const repository = record.session.repositories.find((entry) => entry.projectId === 'agent');
	if (!repository) throw new Error('Agent source is not registered in this development session.');
	const worktree = realpathSync(repository.worktree);
	const stat = lstatSync(worktree);
	if (stat.uid === 0 || !existsSync(resolve(worktree, 'treeseed.package.yaml')) || !existsSync(resolve(worktree, '.git')))
		throw new Error('Development requires an operator-owned Agent checkout.');
	const roots = record.session.repositories.map((entry) => realpathSync(entry.worktree));
	let workspace = worktree;
	while (!roots.every((path) => path === workspace || path.startsWith(`${workspace}${sep}`))) workspace = dirname(workspace);
	if (workspace.split(sep).filter(Boolean).length < 3) throw new Error('Development workspace mount is too broad.');
	return { worktree, workspace, uid: stat.uid };
}

export function renderAgentDevelopmentOverride(input: { sessionId: string; runtimeRoot: string; sourceClosureDigest: string; environment?: Record<string, string>; sandboxGuestDigest?: string }) {
	if (!/^dev-[a-z0-9-]{1,64}$/u.test(input.sessionId)) throw new Error('Invalid Agent development session.');
	if (!/^sha256:[a-f0-9]{64}$/u.test(input.sourceClosureDigest)) throw new Error('Invalid Agent development source closure digest.');
	const labels = {
		'org.treeseed.development.session': input.sessionId,
		'org.treeseed.development.target': 'agent.provider',
	};
	const volumes = [
		{ type: 'bind', source: resolve(input.runtimeRoot, 'dist'), target: '/app/dist', read_only: true },
		{ type: 'bind', source: resolve(input.runtimeRoot, 'package.json'), target: '/app/package.json', read_only: true },
		{ type: 'bind', source: resolve(input.runtimeRoot, 'node_modules'), target: '/app/node_modules', read_only: true },
	];
	const environment: Record<string, string> = { ...input.environment,
		...(input.sandboxGuestDigest ? { TREESEED_DEVELOPMENT_SANDBOX_GUEST_DIGEST: input.sandboxGuestDigest } : {}),
		TREESEED_PROVIDER_RUNTIME_BUILD: input.sourceClosureDigest,
		TREESEED_DEVELOPMENT_SESSION_ID: input.sessionId, TREESEED_DEVELOPMENT_MODE: 'candidate' };
	const service = {
		restart: 'no',
		labels,
		environment,
		volumes,
	};
	return { services: { manager: service, runner: service } };
}

export function activeAgentClaims(stateRoot: string) {
	const path = resolve(stateRoot, 'runtime', 'capacity-state.json');
	if (!existsSync(path)) return [];
	const state = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion?: unknown; claims?: unknown };
	if (state.schemaVersion !== 1 || !Array.isArray(state.claims)) throw new Error('Provider-local capacity state is invalid.');
	return state.claims.filter((claim): claim is { id: string; status: string } => {
		if (!claim || typeof claim !== 'object') throw new Error('Provider-local capacity claim is invalid.');
		const value = claim as { id?: unknown; status?: unknown };
		if (typeof value.id !== 'string' || !['polling', 'ready', 'running', 'recovery'].includes(String(value.status)))
			throw new Error('Provider-local capacity claim is invalid.');
		return value.status !== 'polling';
	});
}

function containerState(command: CommandRunner, service: typeof services[number]) {
	const name = `${projectName}-${service}-1`;
	const value = JSON.parse(String(command('/usr/bin/docker', ['inspect', name, '--format',
		'{"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"environment":{{json .Config.Env}}}'])));
	if (value.labels?.['com.docker.compose.project'] !== projectName || value.labels?.['com.docker.compose.service'] !== service || typeof value.running !== 'boolean')
		throw new Error('Agent container ownership does not match the managed component.');
	const environment: unknown[] = Array.isArray(value.environment) ? value.environment : [];
	const connectionEnvironment = Object.fromEntries(environment
		.map(String).map((entry: string) => entry.split(/=(.*)/su, 2) as [string, string])
		.filter(([key]) => ['TREESEED_CONTROL_PLANE_URL', 'TREESEED_SERVER_PROFILE_LOCAL_URL', 'TREESEED_API_URL'].includes(key)));
	return { name, running: value.running as boolean, labels: value.labels as Record<string, string>, connectionEnvironment };
}

function stopService(command: CommandRunner, service: typeof services[number]) {
	const state = containerState(command, service);
	if (state.running) command('/usr/bin/docker', ['stop', '--time', '30', state.name]);
}

function startService(command: CommandRunner, service: typeof services[number]) {
	const state = containerState(command, service);
	if (!state.running) command('/usr/bin/docker', ['start', state.name]);
}

function restoreReleasedAgent(command: CommandRunner, compose: string[]) {
	command('/usr/bin/docker', [...compose, 'up', '--detach', '--wait', '--wait-timeout', '120', '--force-recreate', ...services]);
}

function stopForHandoff(command: CommandRunner, stateRoot: string, restoreManager: () => void) {
	stopService(command, 'manager');
	const active = activeAgentClaims(stateRoot);
	if (active.length) {
		restoreManager();
		throw new Error(`Managed Agent development cannot interrupt ${active.length} active or recoverable assignment claim(s).`);
	}
	stopService(command, 'runner');
}

interface SandboxDevelopmentReceipt {
	schemaVersion: 1;
	sessionId: string;
	priorDigest: string;
	digest: string;
	image: string;
}

function sandboxReceipt(path: string) {
	if (!existsSync(path)) return null;
	const value = JSON.parse(readFileSync(path, 'utf8')) as SandboxDevelopmentReceipt;
	if (value.schemaVersion !== 1 || !/^dev-[a-z0-9-]{1,64}$/u.test(value.sessionId)
		|| !/^sha256:[a-f0-9]{64}$/u.test(value.priorDigest) || !/^sha256:[a-f0-9]{64}$/u.test(value.digest)
		|| value.image !== 'treeseed/sandbox-codex:local') throw new Error('Managed sandbox development receipt is invalid.');
	return value;
}

function executeSandboxDevelopment(input: AgentDevelopmentInput, record: ManagedDevelopmentSession, command: CommandRunner) {
	const directory = resolve(root, input.sessionId, 'agent', 'sandbox');
	const archive = resolve(directory, 'sandbox-codex.tar');
	const receiptPath = resolve(directory, 'receipt.json');
	const receipt = sandboxReceipt(receiptPath);
	if (input.action === 'logs') return { events: receipt ? [{ service: 'sandbox-guest', output: JSON.stringify(receipt) }] : [] };
	if (input.action === 'status') {
		if (!receipt) return { registered: false, state: null };
		const activeDigest = configuredSandboxGuestDigest();
		return { registered: true, ready: activeDigest === receipt.digest, digest: receipt.digest, activeDigest };
	}
	if (input.action === 'stop') {
		if (receipt) {
			const active = activeAgentClaims(componentStateRoot(loadHostConfiguration(), 'agent'));
			if (active.length) throw new Error(`Managed sandbox development cannot restore guest trust while ${active.length} assignment claim(s) are active or recoverable.`);
			bindExistingSandboxGuestTrust(receipt.priorDigest, command); recordHostDevelopmentGuestImage(receipt.priorDigest);
		}
		rmSync(directory, { recursive: true, force: true });
		if (record.session.targets.some((target) => target.projectId === 'agent' && target.targetId === 'provider' && target.mode !== 'released'))
			executeAgentDevelopmentContainer({ ...input, targetId: 'provider', action: 'start' }, command);
		return { stopped: true };
	}
	if (record.session.status !== 'active') throw new Error('Development session is not active.');
	const stateRoot = componentStateRoot(loadHostConfiguration(), 'agent');
	const active = activeAgentClaims(stateRoot);
	if (active.length) throw new Error(`Managed sandbox development cannot replace guest trust while ${active.length} assignment claim(s) are active or recoverable.`);
	const source = sourceFor(record).worktree;
	for (const path of ['Dockerfile', 'Dockerfile.sandbox-codex', 'dist/sandbox/guest.js', '.treeseed/docker/runtime/shared/node_modules']) {
		if (!existsSync(resolve(source, path))) throw new Error(`Managed sandbox development input ${path} is unavailable.`);
	}
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const lockPath = resolve(directory, 'rebuild.lock');
	let lock: number;
	try { lock = openSync(lockPath, 'wx', 0o600); }
	catch { throw new Error('Managed sandbox development rebuild is already active.'); }
	try {
		const priorDigest = receipt?.priorDigest ?? configuredSandboxGuestDigest();
		command('/usr/bin/docker', ['build', '--file', resolve(source, 'Dockerfile'), '--target', 'sandbox-base', '--tag', 'treeseed/sandbox-base:local', source]);
		command('/usr/bin/docker', ['build', '--file', resolve(source, 'Dockerfile.sandbox-codex'), '--build-arg', 'SANDBOX_BASE=treeseed/sandbox-base:local', '--tag', 'treeseed/sandbox-codex:local', source]);
		command('/usr/bin/docker', ['image', 'save', '--output', archive, 'treeseed/sandbox-codex:local']);
		const metadata = lstatSync(archive);
		if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1_024 || metadata.size > 4_294_967_296 || (metadata.mode & 0o022) !== 0)
			throw new Error('Managed sandbox archive failed bounded supervisor custody validation.');
		const imported = importSandboxGuestArchive(archive, 'treeseed/sandbox-codex:local', command);
		const next: SandboxDevelopmentReceipt = { schemaVersion: 1, sessionId: input.sessionId, priorDigest, digest: imported.digest, image: imported.image };
		atomicJson(receiptPath, next, 0o600);
		recordHostDevelopmentGuestImage(next.digest);
		if (record.session.targets.some((target) => target.projectId === 'agent' && target.targetId === 'provider' && target.mode !== 'released'))
			executeAgentDevelopmentContainer({ ...input, targetId: 'provider', action: 'start' }, command);
		return { started: true, ...next };
	} finally {
		closeSync(lock!);
		rmSync(lockPath, { force: true });
		rmSync(archive, { force: true });
	}
}

/** Fixed Agent provider handoff. No source command, image, mount, or Compose option crosses this boundary. */
export function executeAgentDevelopmentContainer(input: AgentDevelopmentInput, command: CommandRunner) {
	if (input.targetId !== 'provider' && input.targetId !== 'sandbox') throw new Error('Managed Agent development target is invalid.');
	const record = new DevelopmentSessionStore().load(input.sessionId);
	if (!record.session.targets.some((target) => target.projectId === 'agent' && target.targetId === input.targetId))
		throw new Error('Development container is outside the registered session.');
	if (input.targetId === 'sandbox') return executeSandboxDevelopment(input, record, command);
	const directory = resolve(root, input.sessionId, 'agent', 'provider');
	const runtimeRoot = resolve(directory, 'runtime');
	const override = resolve(directory, 'compose.json');
	const handoff = resolve(directory, 'released-agent.json');
	const releases = loadActiveComponents();
	const component = releases.find((release) => release.componentId === 'agent');
	if (!component) throw new Error('Installed Agent foundation is required for development.');
	const compose = ['/usr/bin/docker', 'compose', ...componentComposeArguments('agent', composeFiles(component)), '--project-name', projectName] as const;
	const dockerCompose = compose.slice(1);
	const candidateCompose = [...dockerCompose.slice(0, -2), '--file', override, ...dockerCompose.slice(-2)];
	const stateRoot = componentStateRoot(loadHostConfiguration(), 'agent');

	if (input.action === 'logs') {
		for (const service of services) {
			const state = containerState(command, service);
			if (state.labels['org.treeseed.development.session'] !== input.sessionId || state.labels['org.treeseed.development.target'] !== 'agent.provider')
				throw new Error('Agent development log ownership does not match the session.');
		}
		return { events: services.map((service) => ({ service, output: String(command('/usr/bin/docker', ['logs', '--tail', '100', '--since', '15m', `${projectName}-${service}-1`])) })) };
	}
	if (input.action === 'status') {
		if (!existsSync(override)) return { registered: false, state: null };
		const states = services.map((service) => containerState(command, service));
		const instances = states.map(({ name, running, labels, connectionEnvironment }) => ({ name, running, health: running ? 'healthy' : 'stopped', sessionId: labels['org.treeseed.development.session'], target: labels['org.treeseed.development.target'], connectionEnvironment }));
		return { registered: true, instances, ready: instances.every((item) => item.running) };
	}
	if (input.action === 'stop') {
		if (!existsSync(override)) { if (existsSync(directory)) rmSync(directory, { recursive: true }); return { stopped: true }; }
		stopForHandoff(command, stateRoot, () => startService(command, 'manager'));
		try { restoreReleasedAgent(command, dockerCompose); }
		catch (error) {
			try { command('/usr/bin/docker', [...candidateCompose, 'up', '--detach', '--wait', '--wait-timeout', '120', ...services]); } catch { /* retain custody for retry */ }
			throw error;
		}
		rmSync(directory, { recursive: true });
		return { stopped: true };
	}

	if (record.session.status !== 'active') throw new Error('Development session is not active.');
	const source = sourceFor(record);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	rmSync(runtimeRoot, { recursive: true, force: true });
	const receipt = copyDevelopmentRuntime({
		worktree: source.worktree,
		workspace: source.workspace,
		destination: runtimeRoot,
		sourceUid: source.uid,
		roots: [
			{ source: 'dist', target: 'dist' },
			{ source: '.treeseed/docker/runtime/shared/package.json', target: 'package.json' },
			{ source: '.treeseed/docker/runtime/shared/node_modules', target: 'node_modules' },
		],
	});
	atomicJson(resolve(directory, 'runtime-receipt.json'), receipt, 0o600);
	const host = loadHostConfiguration();
	const environment = managedContainerDevelopmentConnectionEnvironment(host, component, releases, record.routes);
	atomicJson(override, renderAgentDevelopmentOverride({ sessionId: input.sessionId, runtimeRoot, sourceClosureDigest: receipt.digest, environment, sandboxGuestDigest: configuredSandboxGuestDigest() }), 0o600);
	atomicJson(handoff, { restore: true }, 0o600);
	stopForHandoff(command, stateRoot, () => startService(command, 'manager'));
	try {
		command('/usr/bin/docker', [...candidateCompose, 'up', '--detach', '--wait', '--wait-timeout', '120', '--force-recreate', ...services]);
	} catch (error) {
		try { restoreReleasedAgent(command, dockerCompose); rmSync(directory, { recursive: true }); } catch { /* retain handoff marker for idempotent cleanup */ }
		throw error;
	}
	return { started: true, runtime: receipt };
}
