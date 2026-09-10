import { composeProjectContainerIds, type CommandRunner } from './compose-runtime.js';
import { postgresStartupDiagnostic } from '../postgres/startup-diagnostic.js';

function safeDiagnosticText(value: unknown) {
	if (typeof value !== 'string') return null;
	return value
		.replace(/(authorization|password|secret|token|key)(["' ]*[:=]["' ]*)[^\s,;}]+/giu, '$1$2<redacted>')
		.replace(/Bearer\s+[^\s,;}]+/giu, 'Bearer <redacted>')
		.slice(0, 500);
}

function agentHealthDiagnostic(output: unknown) {
	if (typeof output !== 'string' || !output.trim()) return null;
	try {
		const logs = JSON.parse(output) as Array<{ Output?: unknown }>;
		for (const entry of logs.slice().reverse()) {
			if (typeof entry.Output !== 'string' || !entry.Output.trim()) continue;
			try {
				const payload = JSON.parse(entry.Output) as Record<string, unknown>;
				const broker = payload.broker && typeof payload.broker === 'object' && !Array.isArray(payload.broker) ? payload.broker as Record<string, unknown> : undefined;
				const disk = payload.disk && typeof payload.disk === 'object' && !Array.isArray(payload.disk) ? payload.disk as Record<string, unknown> : undefined;
				return {
					...(typeof payload.status === 'string' ? { status: payload.status.slice(0, 64) } : {}),
					...(typeof payload.dataDirWritable === 'boolean' ? { dataDirWritable: payload.dataDirWritable } : {}),
					...(typeof payload.manifestVersion === 'number' ? { manifestVersion: payload.manifestVersion } : {}),
					...(broker ? { broker: { required: broker.required === true, ready: broker.ready === true, reason: safeDiagnosticText(broker.reason) } } : {}),
					...(disk ? { disk: { ok: disk.ok === true, reason: safeDiagnosticText(disk.reason) } } : {}),
					...(typeof payload.error === 'string' ? { error: safeDiagnosticText(payload.error) } : {}),
				};
			} catch { /* only structured Agent health payloads are eligible */ }
		}
	} catch { /* malformed Docker inspection output is not operator evidence */ }
	return null;
}

function agentCrashDiagnostic(output: unknown) {
	if (typeof output !== 'string' || !output.trim()) return null;
	const lines = output.trim().split(/\r?\n/u);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		try {
			const payload = JSON.parse(lines.slice(index).join('\n')) as Record<string, unknown>;
			const error = safeDiagnosticText(payload.error);
			if (payload.ok === false && error) return { code: 'agent_startup_failed', error };
		} catch { /* scan only for the final complete structured Agent crash record */ }
	}
	return null;
}

export function composeFailureDiagnostics(componentId: string, projectName: string, command: CommandRunner, captureCommand: CommandRunner) {
	const diagnostics: Array<Record<string, unknown>> = [];
	let ids: string[];
	try { ids = composeProjectContainerIds(projectName, command); }
	catch { return diagnostics; }
	for (const id of ids) {
		try {
			const raw = String(command('/usr/bin/docker', ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.service"}}\t{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\t{{.State.ExitCode}}', id], '') ?? '').trim();
			const [service = '', state = '', health = '', exitCode = ''] = raw.split('\t');
			if (!/^[a-z][a-z0-9.-]{0,127}$/u.test(service) || !/^[a-z]+$/u.test(state) || !/^(?:none|starting|healthy|unhealthy)$/u.test(health)) continue;
			const code = Number(exitCode);
			let diagnostic: Record<string, unknown> | null = componentId === 'agent' && health !== 'none'
				? agentHealthDiagnostic(command('/usr/bin/docker', ['inspect', '--format', '{{json .State.Health.Log}}', id], '')) : null;
			if (componentId === 'agent' && health !== 'none' && !diagnostic) {
				try {
					const direct = command('/usr/bin/docker', ['exec', id, '/app/docker-entrypoint.sh', 'doctor', '--json'], '');
					diagnostic = agentHealthDiagnostic(JSON.stringify([{ Output: String(direct ?? '') }]));
				} catch { /* retain the safe service summary when the bounded probe cannot run */ }
			}
			if (componentId === 'agent' && !diagnostic) {
				try { diagnostic = agentCrashDiagnostic(captureCommand('/usr/bin/docker', ['logs', '--tail', '8', id], '')); }
				catch { /* raw logs are never emitted; retain the safe service summary */ }
			}
			if (componentId === 'postgres' && !diagnostic && (state !== 'running' || health !== 'healthy')) {
				try {
					const started = String(command('/usr/bin/docker', ['inspect', '--format', '{{.State.StartedAt}}', id], '') ?? '').trim();
					if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(started))
						diagnostic = postgresStartupDiagnostic(captureCommand('/usr/bin/docker', ['logs', '--since', started, '--tail', '80', id], ''));
				}
				catch { /* Never emit raw PostgreSQL logs, even when classification fails. */ }
			}
			diagnostics.push({ service, state, health, ...(Number.isInteger(code) ? { exitCode: code } : {}), ...(diagnostic ? { diagnostic } : {}) });
		} catch { /* retain any other safe service summaries */ }
	}
	return diagnostics;
}
