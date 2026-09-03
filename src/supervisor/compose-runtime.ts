import { resolve, sep } from 'node:path';
import { paths } from '../core/paths.js';
import type { SupervisorOperation } from './protocol.js';

export type CommandRunner = (executable: string, arguments_: readonly string[], input?: string) => unknown;

function bundledComposeFiles(files: readonly string[]) {
	return files.flatMap((file) => {
		const absolute = resolve(paths.bundles, file), root = resolve(paths.bundles);
		if (!absolute.startsWith(`${root}${sep}`)) throw new Error('Compose file is outside the packaged component root.');
		return ['--file', absolute];
	});
}

export function componentComposeArguments(componentId: string, files: readonly string[]) {
	return ['--env-file', `/etc/treeseed/components/${componentId}/environment`, ...bundledComposeFiles(files)];
}

export function composeProjectContainerIds(projectName: string, command: CommandRunner, runningOnly = false) {
	const output = command('/usr/bin/docker', [
		'ps', ...(runningOnly ? [] : ['--all']), '--quiet', '--filter', `label=com.docker.compose.project=${projectName}`,
	], '');
	return typeof output === 'string' ? output.trim().split(/\s+/u).filter(Boolean) : [];
}

interface ComposeServiceObservation {
	service: string;
	state: string;
	health: string;
	image: string;
}

function composeServiceObservations(projectName: string, command: CommandRunner) {
	return composeProjectContainerIds(projectName, command).flatMap((id): ComposeServiceObservation[] => {
		const raw = String(command('/usr/bin/docker', ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.service"}}\t{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\t{{.Config.Image}}', id], '') ?? '').trim();
		const [service = '', state = '', health = '', image = ''] = raw.split('\t');
		if (!/^[a-z][a-z0-9.-]{0,127}$/u.test(service) || !/^[a-z]+$/u.test(state) || !/^(?:none|starting|healthy|unhealthy)$/u.test(health) || image.length === 0 || image.length > 512) return [];
		return [{ service, state, health, image }];
	});
}

function expectedComposeImages(componentId: string, files: readonly string[], projectName: string, command: CommandRunner) {
	const output = command('/usr/bin/docker', ['compose', ...componentComposeArguments(componentId, files), '--project-name', projectName, 'config', '--format', 'json'], '');
	if (typeof output !== 'string') throw new Error('Compose did not report its expected runtime configuration.');
	const configured = JSON.parse(output) as { services?: Record<string, { image?: unknown }> };
	return new Map(Object.entries(configured.services ?? {}).flatMap(([service, value]) => typeof value.image === 'string' && value.image.length > 0 && value.image.length <= 512 ? [[service, value.image] as const] : []));
}

export function composeRuntimeStatus(operation: Extract<SupervisorOperation, { operation: 'compose.status' }>, command: CommandRunner) {
	const containers = composeProjectContainerIds(operation.projectName, command);
	const running = composeProjectContainerIds(operation.projectName, command, true);
	if (!operation.runtime) return { present: containers.length > 0, running: running.length > 0, containers: containers.length, runningContainers: running.length };
	const { componentId, files, services } = operation.runtime;
	const observations = composeServiceObservations(operation.projectName, command);
	const expectedImages = expectedComposeImages(componentId, files, operation.projectName, command);
	const issues: Array<{ service: string; reason: 'missing' | 'stopped' | 'unhealthy' | 'wrong-image' }> = [];
	for (const service of services) {
		const instances = observations.filter((item) => item.service === service);
		if (instances.length === 0) { issues.push({ service, reason: 'missing' }); continue; }
		if (instances.some((item) => item.state !== 'running')) { issues.push({ service, reason: 'stopped' }); continue; }
		if (instances.some((item) => item.health === 'starting' || item.health === 'unhealthy')) { issues.push({ service, reason: 'unhealthy' }); continue; }
		const expectedImage = expectedImages.get(service);
		if (!expectedImage || instances.some((item) => item.image !== expectedImage)) issues.push({ service, reason: 'wrong-image' });
	}
	return { present: containers.length > 0, running: running.length > 0, ready: issues.length === 0, containers: containers.length, runningContainers: running.length, expectedServices: services.length, issues };
}
