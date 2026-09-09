import { existsSync } from 'node:fs';
import { paths } from '../core/paths.js';
import { edgeReadiness } from '../edge/readiness.js';

export async function hostDoctor(verifyPlan: () => unknown, aliases: readonly string[]) {
	const checks = [
		{ id: 'configuration', ok: existsSync(paths.configuration) },
		{ id: 'stable-catalog', ok: existsSync(`${paths.catalogs}/stable.json`) },
		{ id: 'supervisor', ok: existsSync(paths.socket) },
		{ id: 'manager-ca', ok: existsSync(`${paths.tls}/ca.crt`) },
	];
	try { verifyPlan(); checks.push({ id: 'accepted-plan', ok: true }); }
	catch { checks.push({ id: 'accepted-plan', ok: false }); }
	checks.push({ id: 'edge-tls', ok: await edgeReadiness(aliases) });
	return { healthy: checks.every(check => check.ok), checks };
}
