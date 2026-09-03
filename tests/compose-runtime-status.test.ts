import { describe, expect, it } from 'vitest';
import { executeSupervisorOperation } from '../src/supervisor/execute.js';

describe('managed Compose runtime status', () => {
	it('reports exact missing, unhealthy, and wrong-image service drift', () => {
		const inspections: Record<string, string> = {
			api: ['api', 'running', 'healthy', 'treeseed/api@sha256:expected'].join('\t'),
			operations: ['operations', 'running', 'unhealthy', 'treeseed/operations@sha256:expected'].join('\t'),
			stale: ['postgres', 'running', 'healthy', 'treeseed/postgres@sha256:stale'].join('\t'),
		};
		const status = executeSupervisorOperation({ operation: 'compose.status', projectName: 'treeseed-api', runtime: { componentId: 'api', files: ['api/1.0.0/compose.yml'], services: ['api', 'operations', 'postgres', 'treedx'] } }, (_executable, arguments_) => {
			if (arguments_[0] === 'ps') return 'api\noperations\nstale\n';
			if (arguments_[0] === 'inspect') return inspections[String(arguments_.at(-1))];
			if (arguments_[0] === 'compose') return JSON.stringify({ services: {
				api: { image: 'treeseed/api@sha256:expected' }, operations: { image: 'treeseed/operations@sha256:expected' },
				postgres: { image: 'treeseed/postgres@sha256:expected' }, treedx: { image: 'treeseed/treedx@sha256:expected' },
			} });
			throw new Error(`Unexpected command ${arguments_.join(' ')}`);
		});
		expect(status).toMatchObject({ present: true, running: true, ready: false, expectedServices: 4, issues: [
			{ service: 'operations', reason: 'unhealthy' }, { service: 'postgres', reason: 'wrong-image' }, { service: 'treedx', reason: 'missing' },
		] });
	});

	it('accepts the exact healthy service and image set', () => {
		const status = executeSupervisorOperation({ operation: 'compose.status', projectName: 'treeseed-api', runtime: { componentId: 'api', files: ['api/1.0.0/compose.yml'], services: ['api'] } }, (_executable, arguments_) => {
			if (arguments_[0] === 'ps') return 'api\n';
			if (arguments_[0] === 'inspect') return ['api', 'running', 'healthy', 'treeseed/api@sha256:expected'].join('\t');
			if (arguments_[0] === 'compose') return JSON.stringify({ services: { api: { image: 'treeseed/api@sha256:expected' } } });
			throw new Error(`Unexpected command ${arguments_.join(' ')}`);
		});
		expect(status).toMatchObject({ present: true, running: true, ready: true, expectedServices: 1, issues: [] });
	});

	it('does not treat successfully stopped one-shot services as persistent runtime drift', () => {
		const status = executeSupervisorOperation({ operation: 'compose.status', projectName: 'treeseed-api', runtime: { componentId: 'api', files: ['api/1.0.0/compose.yml'], services: ['migration', 'api', 'diagnostics-backfill'] } }, (_executable, arguments_) => {
			if (arguments_[0] === 'ps') return 'migration\napi\ndiagnostics\n';
			if (arguments_[0] === 'inspect') {
				const id = String(arguments_.at(-1));
				if (id === 'api') return ['api', 'running', 'healthy', 'treeseed/api@sha256:expected'].join('\t');
				return [id === 'diagnostics' ? 'diagnostics-backfill' : id, 'exited', 'none', `treeseed/${id}@sha256:expected`].join('\t');
			}
			if (arguments_[0] === 'compose') return JSON.stringify({ services: {
				migration: { image: 'treeseed/migration@sha256:expected', restart: 'no' },
				api: { image: 'treeseed/api@sha256:expected', restart: 'unless-stopped' },
				'diagnostics-backfill': { image: 'treeseed/diagnostics@sha256:expected', restart: 'no' },
			} });
			throw new Error(`Unexpected command ${arguments_.join(' ')}`);
		});
		expect(status).toMatchObject({ present: true, running: true, ready: true, expectedServices: 1, issues: [] });
	});
});
