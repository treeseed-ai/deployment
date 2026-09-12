import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { atomicJson } from '../core/files.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { DevelopmentSessionStore, type ManagedDevelopmentSession } from '../manager/development-sessions.js';
import { loadActiveComponents } from '../manager/current-state.js';
import { composeFiles } from '../manager/reconcile.js';
import { componentStateRoot } from './component.js';
import { componentComposeArguments, type CommandRunner } from './compose-runtime.js';
import { copyDevelopmentRuntime } from './development-runtime-copy.js';

const root = '/run/treeseed/development-containers';
const projectName = 'treeseed-agent';
const services = ['manager', 'runner'] as const;

interface AgentDevelopmentInput {
	sessionId: string;
	projectId: 'agent';
	targetId: string;
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

export function renderAgentDevelopmentOverride(input: { sessionId: string; runtimeRoot: string }) {
	if (!/^dev-[a-z0-9-]{1,64}$/u.test(input.sessionId)) throw new Error('Invalid Agent development session.');
	const labels = {
		'org.treeseed.development.session': input.sessionId,
		'org.treeseed.development.target': 'agent.provider',
	};
	const volumes = [
		{ type: 'bind', source: resolve(input.runtimeRoot, 'dist'), target: '/app/dist', read_only: true },
		{ type: 'bind', source: resolve(input.runtimeRoot, 'package.json'), target: '/app/package.json', read_only: true },
		{ type: 'bind', source: resolve(input.runtimeRoot, 'node_modules'), target: '/app/node_modules', read_only: true },
	];
	const service = {
		restart: 'no',
		labels,
		environment: { TREESEED_DEVELOPMENT_SESSION_ID: input.sessionId, TREESEED_DEVELOPMENT_MODE: 'candidate' },
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
		'{"labels":{{json .Config.Labels}},"running":{{json .State.Running}}}'])));
	if (value.labels?.['com.docker.compose.project'] !== projectName || value.labels?.['com.docker.compose.service'] !== service || typeof value.running !== 'boolean')
		throw new Error('Agent container ownership does not match the managed component.');
	return { name, running: value.running as boolean, labels: value.labels as Record<string, string> };
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

/** Fixed Agent provider handoff. No source command, image, mount, or Compose option crosses this boundary. */
export function executeAgentDevelopmentContainer(input: AgentDevelopmentInput, command: CommandRunner) {
	if (input.targetId !== 'provider') throw new Error('Managed Agent development target is invalid.');
	const record = new DevelopmentSessionStore().load(input.sessionId);
	if (!record.session.targets.some((target) => target.projectId === 'agent' && target.targetId === 'provider'))
		throw new Error('Development container is outside the registered session.');
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
		const instances = states.map(({ name, running, labels }) => ({ name, running, health: running ? 'healthy' : 'stopped', sessionId: labels['org.treeseed.development.session'], target: labels['org.treeseed.development.target'] }));
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
	atomicJson(override, renderAgentDevelopmentOverride({ sessionId: input.sessionId, runtimeRoot }), 0o600);
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
