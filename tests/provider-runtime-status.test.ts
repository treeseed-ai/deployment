import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerRuntimeStatus } from '../src/supervisor/provider-runtime.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';

const roots: string[] = [], now = Date.parse('2026-09-01T12:00:00Z');
function fixture(extra: Record<string, unknown> = {}) {
	const root = mkdtempSync(join(tmpdir(), 'provider-runtime-')); roots.push(root);
	mkdirSync(join(root, 'runtime'), { mode: 0o700 });
	writeFileSync(join(root, 'runtime/manager.json'), JSON.stringify({ schemaVersion: 1, role: 'manager', updatedAt: new Date(now).toISOString(), ok: true, ...extra }), { mode: 0o600 });
	return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('bounded provider runtime observation', () => {
	it('reports fixed idle reasons without reflecting arbitrary status or reason text', () => {
		const root = fixture({ result: { results: [
			{ status: 'idle', reason: 'no_assignment', assignment: 'never-output' },
			{ status: 'idle', reason: 'local_capacity_exhausted' },
			{ status: 'idle', reason: 'private-value' }, { status: 'private-status', reason: 'private-value' },
		] } });
		const status = providerRuntimeStatus(root, process.getuid!(), now).roles[0];
		expect(status).toMatchObject({ observations: [
			{ status: 'idle', reason: 'no_assignment' }, { status: 'idle', reason: 'local_capacity_exhausted' }, { status: 'idle', reason: null },
		] });
		expect(JSON.stringify(status)).not.toMatch(/private-value|private-status|never-output/u);
	});
	it('exposes freshness and failures but not assignment outputs or credential fields', () => {
		const root = fixture({ result: { accessToken: 'never-output', outputs: ['never-output'], results: [{ status: 'error', error: 'authorization=private-token password=private-password Bearer private-bearer' }] } });
		const result = providerRuntimeStatus(root, process.getuid!(), now);
		expect(result.roles[0]).toMatchObject({ observed: true, fresh: true, ok: false });
		expect(JSON.stringify(result)).not.toMatch(/never-output|private-token|private-password|private-bearer/u);
		expect(result.roles[1]).toMatchObject({ observed: false, reason: 'not_observed' });
	});
	it('does not hide failed connection results or stale loop records', () => {
		const root = fixture({ result: { results: [{ ok: false, status: 'error' }] } });
		expect(providerRuntimeStatus(root, process.getuid!(), now + 130_000).roles[0]).toMatchObject({ fresh: false, ok: false, errors: ['connection_reconciliation_failed'] });
	});
	it('rejects path injection, symlinks, wrong owners and permissive records', () => {
		expect(supervisorOperationSchema.safeParse({ operation: 'provider.runtime.status', path: '/etc/shadow' }).success).toBe(false);
		const root = fixture();
		expect(providerRuntimeStatus(root, process.getuid!() + 1, now).roles[0]).toMatchObject({ observed: false });
		chmodSync(join(root, 'runtime/manager.json'), 0o644);
		expect(providerRuntimeStatus(root, process.getuid!(), now).roles[0]).toMatchObject({ observed: false });
		symlinkSync(join(root, 'runtime/manager.json'), join(root, 'runtime/runner.json'));
		expect(providerRuntimeStatus(root, process.getuid!(), now).roles[1]).toMatchObject({ observed: false });
	});
	it('projects actual multi-team connection failures without exposing connection payloads', () => {
		const root = fixture({ result: { ok: false, connections: [{ ok: false, status: 'error', accessToken: 'never-output', error: 'token=private-token' }] } });
		const status = providerRuntimeStatus(root, process.getuid!(), now).roles[0];
		expect(status).toMatchObject({ observed: true, fresh: true, ok: false });
		expect(JSON.stringify(status)).not.toMatch(/never-output|private-token/u);
	});
	it('does not equate a healthy loop with a connected provider', () => {
		const root = fixture({ result: { ok: true, connections: [] } });
		expect(providerRuntimeStatus(root, process.getuid!(), now).roles[0]).toMatchObject({ ok: false, errors: ['no_provider_connections'] });
	});
	it('respects aggregate failure and stale successful records', () => {
		const failed = fixture({ result: { ok: false } });
		expect(providerRuntimeStatus(failed, process.getuid!(), now).roles[0]).toMatchObject({ ok: false, errors: ['runtime_operation_failed'] });
		const stale = fixture({ result: { ok: true } });
		expect(providerRuntimeStatus(stale, process.getuid!(), now + 130_000).roles[0]).toMatchObject({ fresh: false, ok: false });
	});
});
