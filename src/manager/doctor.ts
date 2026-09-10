import { existsSync } from 'node:fs';
import { paths } from '../core/paths.js';
import { edgeReadiness } from '../edge/readiness.js';
import { requestSupervisor } from '../supervisor/client.js';

export async function hostDoctor(verifyPlan: () => unknown, aliases: readonly string[], postgresEnabled = false) {
	const checks = [
		{ id: 'configuration', ok: existsSync(paths.configuration) },
		{ id: 'stable-catalog', ok: existsSync(`${paths.catalogs}/stable.json`) },
		{ id: 'supervisor', ok: existsSync(paths.socket) },
		{ id: 'manager-ca', ok: existsSync(`${paths.tls}/ca.crt`) },
	];
	try { verifyPlan(); checks.push({ id: 'accepted-plan', ok: true }); }
	catch { checks.push({ id: 'accepted-plan', ok: false }); }
	checks.push({ id: 'edge-tls', ok: await edgeReadiness(aliases) });
	let postgres: { present: boolean; running: boolean; diagnostics?: Array<{ state?: string; health?: string }> } | undefined;
	try { postgres = await requestSupervisor({ operation: 'compose.status', projectName: 'treeseed-postgres' }); }
	catch { if (postgresEnabled) checks.push({ id: 'postgres-status', ok: false }); }
	if (postgresEnabled && postgres) checks.push({ id: 'postgres', ok: postgres.present && postgres.running
		&& Boolean(postgres.diagnostics?.length) && postgres.diagnostics!.every(item => item.state === 'running' && item.health === 'healthy') });
	return { healthy: checks.every(check => check.ok), checks, ...(postgres?.present ? { postgres } : {}) };
}
