import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ edge: 0, postgres: 0 }));
vi.mock('node:fs', async (load) => ({ ...(await load<typeof import('node:fs')>()), existsSync: () => true }));
vi.mock('../src/core/paths.js', () => ({ paths: { configuration: '/fixture/configuration', catalogs: '/fixture/catalogs', socket: '/fixture/socket', tls: '/fixture/tls' } }));
vi.mock('../src/edge/readiness.js', () => ({ edgeReadiness: async () => { calls.edge++; return false; } }));
vi.mock('../src/supervisor/client.js', () => ({ requestSupervisor: async () => { calls.postgres++; throw new Error('postgres stopped'); } }));
const { hostDoctor } = await import('../src/manager/doctor.js');

describe('host doctor for intentional stop', () => {
	it('reports manager foundation healthy without probing deliberately stopped workloads', async () => {
		calls.edge = 0; calls.postgres = 0;
		const result = await hostDoctor(() => undefined, [], true, true);
		expect(result.healthy).toBe(true);
		expect(result.checks.map(check => check.id)).toEqual(['configuration', 'stable-catalog', 'supervisor', 'manager-ca', 'accepted-plan']);
		expect(calls).toEqual({ edge: 0, postgres: 0 });
	});
	it('still diagnoses absent edge and database during requested running state', async () => {
		calls.edge = 0; calls.postgres = 0;
		const result = await hostDoctor(() => undefined, [], true, false);
		expect(result.healthy).toBe(false);
		expect(result.checks).toEqual(expect.arrayContaining([{ id: 'edge-tls', ok: false }, { id: 'postgres-status', ok: false }]));
		expect(calls).toEqual({ edge: 1, postgres: 1 });
	});
});
