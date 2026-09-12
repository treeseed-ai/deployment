import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { atomicJson } from '../core/files.js';
import { DevelopmentSessionStore } from '../manager/development-sessions.js';
import { loadActiveComponents } from '../manager/current-state.js';
import { composeFiles } from '../manager/reconcile.js';
import { componentComposeArguments, composeProjectContainerIds, type CommandRunner } from './compose-runtime.js';
import { developmentDiagnosticEvents } from './development-diagnostics.js';

type ManagedProject = 'treedx' | 'ai';
type ManagedTarget = 'service' | 'ai-inference' | 'ai-training' | 'ai-lab';
type Action = 'start' | 'stop' | 'status' | 'logs';

interface Input { sessionId: string; projectId: ManagedProject; targetId: ManagedTarget; action: Action }
interface ImageBuild { role: string; services: string[]; dockerfile: string; target?: string; buildArgs?: Record<string, string> }
interface Recipe { componentId: string; projectId: ManagedProject; targetId: ManagedTarget; builds: (worktree: string) => ImageBuild[] }

const root = '/run/treeseed/development-containers';
const aiServices: Record<Exclude<ManagedTarget, 'service'>, Record<string, string[]>> = {
	'ai-inference': {
		'inference-api': ['inference-api', 'inference-gpu-state-init'], 'inference-manager': ['inference-manager'], 'inference-vllm': ['inference-vllm'],
		'inference-evaluator': ['inference-evaluator'], 'inference-migrations': ['inference-migrations'],
	},
	'ai-training': {
		'training-api': ['training-api', 'training-gpu-state-init'], 'training-manager': ['training-manager'], 'axolotl-worker': ['training-axolotl'],
		'marker-worker': ['training-marker'], 'artifact-worker': ['training-artifact'], 'training-migrations': ['training-migrations'],
	},
	'ai-lab': {
		'lab-controller': ['controller', 'lab-state-init'], 'lab-experience-proxy': ['experience-proxy'], 'lab-library-bridge': ['library-bridge'],
		'lab-open-webui': ['open-webui', 'open-webui-action-init'], 'hermes-agent': ['hermes-agent', 'hermes-dashboard'],
		'lab-web-tool-proxy': ['web-tool-proxy'],
	},
};

function aiBuilds(worktree: string, targetId: Exclude<ManagedTarget, 'service'>): ImageBuild[] {
	const value = JSON.parse(readFileSync(resolve(worktree, 'release/image-builds.json'), 'utf8')) as {
		images?: Record<string, { dockerfile?: unknown; buildArgs?: unknown }>;
	};
	return Object.entries(aiServices[targetId]).map(([role, services]) => {
		const entry = value.images?.[role];
		if (!entry || typeof entry.dockerfile !== 'string' || !/^(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/u.test(entry.dockerfile))
			throw new Error('Managed AI development image inventory is invalid.');
		const buildArgs = entry.buildArgs;
		if (buildArgs !== undefined && (!buildArgs || typeof buildArgs !== 'object' || Array.isArray(buildArgs)
			|| Object.entries(buildArgs).some(([name, item]) => !/^[A-Z][A-Z0-9_]{0,127}$/u.test(name) || typeof item !== 'string' || item.length > 4_096)))
			throw new Error('Managed AI development build arguments are invalid.');
		return { role, services, dockerfile: entry.dockerfile, ...(buildArgs ? { buildArgs: buildArgs as Record<string, string> } : {}) };
	});
}

function recipe(input: Input): Recipe {
	if (input.projectId === 'treedx' && input.targetId === 'service') return {
		componentId: 'treedx', projectId: 'treedx', targetId: 'service',
		builds: () => [{ role: 'treedx', services: ['treedx'], dockerfile: 'Dockerfile', target: 'prod' }],
	};
	if (input.projectId === 'ai' && input.targetId !== 'service') return {
		componentId: input.targetId, projectId: 'ai', targetId: input.targetId,
		builds: (worktree) => aiBuilds(worktree, input.targetId as Exclude<ManagedTarget, 'service'>),
	};
	throw new Error('Managed component development target is invalid.');
}

function source(sessionId: string, projectId: ManagedProject) {
	const record = new DevelopmentSessionStore().load(sessionId);
	if (record.session.status !== 'active') throw new Error('Development session is not active.');
	const repository = record.session.repositories.find((entry) => entry.projectId === projectId);
	if (!repository) throw new Error('Managed component source is not registered in this development session.');
	const worktree = realpathSync(repository.worktree), stat = lstatSync(worktree);
	if (stat.uid === 0 || !existsSync(resolve(worktree, 'treeseed.package.yaml')) || !existsSync(resolve(worktree, '.git')))
		throw new Error('Managed component development requires an operator-owned checkout.');
	if (worktree.split(sep).filter(Boolean).length < 4) throw new Error('Managed component development worktree is too broad.');
	return { record, worktree };
}

function buildImages(command: CommandRunner, input: Input, worktree: string, builds: ImageBuild[]) {
	const images = new Map<string, string>();
	for (const build of builds) {
		const tag = `local/treeseed-${input.projectId}-${build.role}:${input.sessionId}`;
		const args = ['buildx', 'build', worktree, '--file', resolve(worktree, build.dockerfile), '--platform', 'linux/amd64', '--load', '--tag', tag];
		if (build.target) args.push('--target', build.target);
		for (const [name, value] of Object.entries(build.buildArgs ?? {})) args.push('--build-arg', `${name}=${value}`);
		command('/usr/bin/docker', args);
		const image = String(command('/usr/bin/docker', ['image', 'inspect', tag, '--format', '{{.Id}}'])).trim();
		if (!/^sha256:[a-f0-9]{64}$/u.test(image)) throw new Error('Managed development image identity is invalid.');
		for (const service of build.services) images.set(service, image);
	}
	return images;
}

export function renderManagedComponentOverride(input: Input, images: Map<string, string>) {
	const labels = { 'org.treeseed.development.session': input.sessionId, 'org.treeseed.development.target': `${input.projectId}.${input.targetId}` };
	return { services: Object.fromEntries([...images].map(([service, image]) => [service, { image, labels }])) };
}

function observed(command: CommandRunner, projectName: string, input: Input, runningOnly = true, expectedImages?: ReadonlyMap<string, string>) {
	const ids = composeProjectContainerIds(projectName, command, runningOnly);
	return ids.map((id) => {
		const value = String(command('/usr/bin/docker', ['inspect', id, '--format',
			'{"service":{{json (index .Config.Labels "com.docker.compose.service")}},"sessionId":{{json (index .Config.Labels "org.treeseed.development.session")}},"target":{{json (index .Config.Labels "org.treeseed.development.target")}},"image":{{json .Image}},"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}}}']));
		return { id, ...JSON.parse(value) } as { id: string; service: string; sessionId?: string; target?: string; image: string; running: boolean; health: string };
	})
		.filter((item) => (item.sessionId === input.sessionId && item.target === `${input.projectId}.${input.targetId}`)
			|| expectedImages?.get(item.service) === item.image);
}

function failureEvidence(command: CommandRunner, projectName: string, input: Input, images: ReadonlyMap<string, string>) {
	const instances = observed(command, projectName, input, false, images);
	const events = instances.flatMap((item) => {
		try { return developmentDiagnosticEvents(String(command('/usr/bin/docker', ['logs', '--tail', '100', item.id]))).map((event) => ({ ...event, service: item.service })); }
		catch { return []; }
	});
	return {
		schemaVersion: 'treeseed.development-component-failure/v1',
		target: `${input.projectId}.${input.targetId}`,
		instances: instances.map(({ service, running, health }) => ({ service, running, health })),
		events,
	};
}

/** Build and switch only fixed, installed TreeSeed component recipes; no caller-supplied Docker option crosses this boundary. */
export function executeManagedComponentDevelopment(input: Input, command: CommandRunner) {
	const selectedRecipe = recipe(input), record = new DevelopmentSessionStore().load(input.sessionId);
	if (!record.session.targets.some((target) => target.projectId === input.projectId && target.targetId === input.targetId))
		throw new Error('Managed component development is outside the registered session.');
	const component = loadActiveComponents().find((entry) => entry.componentId === selectedRecipe.componentId);
	if (!component) throw new Error('Installed component foundation is required for managed development.');
	const directory = resolve(root, input.sessionId, input.projectId, input.targetId), override = resolve(directory, 'compose.json');
	const failure = resolve(directory, 'failure.json');
	const compose = ['compose', ...componentComposeArguments(component.componentId, composeFiles(component)), '--project-name', component.runtime.compose.projectName];
	const candidate = [...compose.slice(0, -2), '--file', override, ...compose.slice(-2)];
	if (input.action === 'logs') {
		const live = observed(command, component.runtime.compose.projectName, input).map((item) => ({
		service: item.service, output: String(command('/usr/bin/docker', ['logs', '--tail', '100', '--since', '15m', item.id])),
		}));
		const retained = existsSync(failure) ? JSON.parse(readFileSync(failure, 'utf8')) as { events?: unknown[]; instances?: unknown[] } : undefined;
		return { events: retained?.events ?? [], instances: retained?.instances ?? [], logs: live };
	}
	if (input.action === 'status') {
		if (!existsSync(override)) return { registered: false, state: null };
		const instances = observed(command, component.runtime.compose.projectName, input);
		return { registered: true, instances, ready: instances.length > 0 && instances.every((item: { running: boolean; health: string }) => item.running && item.health !== 'starting' && item.health !== 'unhealthy') };
	}
	if (input.action === 'stop') {
		if (!existsSync(override)) { rmSync(directory, { recursive: true, force: true }); return { stopped: true }; }
		command('/usr/bin/docker', [...compose, 'up', '--detach', '--remove-orphans', '--wait', '--wait-timeout', '600', '--force-recreate']);
		rmSync(directory, { recursive: true }); return { stopped: true };
	}
	const { worktree } = source(input.sessionId, input.projectId);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const images = buildImages(command, input, worktree, selectedRecipe.builds(worktree));
	atomicJson(override, renderManagedComponentOverride(input, images), 0o600);
	rmSync(failure, { force: true });
	try { command('/usr/bin/docker', [...candidate, 'up', '--detach', '--remove-orphans', '--wait', '--wait-timeout', '600', '--force-recreate']); }
	catch (error) {
		const evidence = failureEvidence(command, component.runtime.compose.projectName, input, images);
		atomicJson(failure, evidence, 0o600);
		try {
			command('/usr/bin/docker', [...compose, 'up', '--detach', '--remove-orphans', '--wait', '--wait-timeout', '600', '--force-recreate']);
			rmSync(override, { force: true });
		} catch { /* retain recovery state */ }
		const codes = evidence.events.flatMap((event) => event && typeof event === 'object' && 'code' in event && typeof event.code === 'string' ? [event.code] : []);
		const services = evidence.instances.filter((item) => !item.running || item.health === 'unhealthy').map((item) => item.service);
		const detail = [...new Set([...services, ...codes])].slice(0, 8).join(',');
		throw new Error(`${error instanceof Error ? error.message : 'Managed development activation failed.'}${detail ? ` Diagnostics: ${detail}.` : ''}`);
	}
	return { started: true, images: Object.fromEntries(images) };
}
