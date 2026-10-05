import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { loadHostConfiguration } from '../core/configuration.js';
import { withLocalPostgresBootstrap } from '../postgres/connection.js';
import { activatePostgresAllocation } from '../postgres/activation.js';
import { disablePostgresAllocation } from '../postgres/disable.js';
import { DevelopmentSessionStore, hasRegisteredDevelopmentTarget } from '../manager/development-sessions.js';
import { loadActiveComponents } from '../manager/current-state.js';
import { localPostgresTopology } from './postgres.js';
import { preparePostgresCredentials } from './postgres-credentials.js';
import { materializePostgresClient, clearPostgresClient } from './postgres-client-files.js';
import { readComponentCredential } from './component-sealed.js';
import { copyDevelopmentRuntime } from './development-runtime-copy.js';
import { developmentContainerSource, developmentRuntimeOwner, resolveDevelopmentRuntimeImage } from './development-container.js';
import type { CommandRunner } from './compose-runtime.js';

const requirementId = 'api';

export function parseDevelopmentMigrationInventory(output: string) {
	const inventoryLine = output.split('\n').reverse().find((line) => line.trim().startsWith('{'));
	const inventory = inventoryLine ? JSON.parse(inventoryLine) as { schemaVersion?: unknown; pending?: unknown; unexpected?: unknown; schema?: unknown } : null;
	const schema = inventory?.schema && typeof inventory.schema === 'object' && !Array.isArray(inventory.schema)
		? inventory.schema as Record<string, unknown> : null;
	if (inventory?.schemaVersion !== 'treeseed.database-migration-inventory/v1'
		|| !Array.isArray(inventory.pending) || !Array.isArray(inventory.unexpected)
		|| [...inventory.pending, ...inventory.unexpected].some((name) => typeof name !== 'string' || !/^[A-Za-z0-9._-]+\.sql$/u.test(name))
		|| (schema && Object.entries(schema).some(([table, columns]) => !/^[a-z0-9_]+$/u.test(table)
			|| !Array.isArray(columns) || columns.some((column) => typeof column !== 'string' || !/^[a-z0-9_]+$/u.test(column)))))
		throw new Error('Development migration did not return a valid migration inventory.');
	return { pending: inventory.pending as string[], unexpected: inventory.unexpected as string[], schema: schema ?? {} };
}

function running(command: CommandRunner, name: string) {
	try { return String(command('/usr/bin/docker', ['inspect', '--format', '{{.State.Running}}', name])).trim() === 'true'; }
	catch { return false; }
}

/** Apply source migrations with the separately-scoped migration identity.
 * This is available only through the protected local manager socket and a
 * registered active API development session. A failed live activation may have
 * restored the released runtime, so the explicit migration operation must not
 * depend on the target's last successful mode. Source code never executes in the
 * privileged supervisor; it executes in a bounded, unprivileged container.
 */
export async function executeDevelopmentPostgresMigration(
	input: { sessionId: string; projectId: 'api' }, command: CommandRunner, capture: CommandRunner = command,
) {
	const record = new DevelopmentSessionStore().load(input.sessionId);
	if (!hasRegisteredDevelopmentTarget(record, 'api', 'service')) {
		throw new Error('An active API development session is required.');
	}
	const host = loadHostConfiguration(), releases = loadActiveComponents();
	const component = releases.find((release) => release.componentId === 'api');
	if (!component) throw new Error('The accepted API component is required for development migration custody.');
	const topology = localPostgresTopology(host, releases);
	const allocation = topology.allocations.find((candidate) => candidate.requirementId === requirementId);
	if (!allocation) throw new Error('The managed API database allocation is unavailable.');
	const source = developmentContainerSource(record), identity = developmentRuntimeOwner(host, component);
	const directory = resolve('/run/treeseed/development-containers', input.sessionId, 'migration');
	const runtime = resolve(directory, 'runtime');
	rmSync(directory, { recursive: true, force: true });
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const copied = copyDevelopmentRuntime({ worktree: source.worktree, workspace: source.workspace, destination: runtime, sourceUid: source.uid });
	const image = resolveDevelopmentRuntimeImage(capture);
	const knownContainers = [
		`treeseed-${input.sessionId}-api-service`,
		`treeseed-${input.sessionId}-api-operations-runner`,
		'treeseed-api-api-1',
		'treeseed-api-operations-runner-1',
	];
	const restart = knownContainers.filter((name) => running(capture, name));
	if (restart.length) command('/usr/bin/docker', ['stop', '--time', '30', ...restart]);
	const session = <T>(run: Parameters<typeof withLocalPostgresBootstrap<T>>[2]) => withLocalPostgresBootstrap('/run/treeseed/postgres/socket', allocation.database, run);
	let migrationActivated = false;
	try {
		await session((connection) => preparePostgresCredentials(host, requirementId, connection));
		await session((connection) => activatePostgresAllocation(topology, requirementId, 'migration', readComponentCredential(host, allocation.migrationCredentialReference), connection));
		migrationActivated = true;
		materializePostgresClient(host, component, requirementId, 'migration');
		const output = String(capture('/usr/bin/docker', [
			'run', '--rm', '--init', '--read-only', '--network', 'treeseed-postgres-private',
			'--user', `${identity.uid}:${identity.gid}`, '--workdir', '/app', '--tmpfs', '/tmp',
			'--mount', `type=bind,source=${runtime},target=/app,readonly`,
			'--mount', 'type=bind,source=/run/treeseed/postgres-clients/api/api/migration,target=/run/treeseed/postgres/api,readonly',
			'--env', 'TREESEED_DATABASE_URL_FILE=/run/treeseed/postgres/api/url',
			'--env', 'TREESEED_DEVELOPMENT_MODE=candidate', image,
			'node', './dist/scripts/support/migrate-db.js',
		]));
		const inventory = parseDevelopmentMigrationInventory(output);
		return { schemaVersion: 'treeseed.development-postgres-migration-receipt/v1', sessionId: input.sessionId,
			projectId: 'api', sourceDigest: copied.digest, topologyDigest: deploymentDigest(topology), applied: true,
			pending: inventory.pending, unexpected: inventory.unexpected, schema: inventory.schema };
	} finally {
		try {
			if (migrationActivated) await session((connection) => disablePostgresAllocation(topology, requirementId, connection));
			await session((connection) => activatePostgresAllocation(topology, requirementId, 'runtime', readComponentCredential(host, allocation.runtimeCredentialReference), connection));
			clearPostgresClient('api', requirementId, 'migration');
			materializePostgresClient(host, component, requirementId, 'runtime');
		} finally {
			rmSync(directory, { recursive: true, force: true });
			if (restart.length) command('/usr/bin/docker', ['start', ...restart]);
		}
	}
}
