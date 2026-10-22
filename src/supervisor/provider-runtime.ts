import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function diagnostic(value: unknown) {
	if (typeof value !== 'string') return null;
	return value.replace(/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/gu, '<redacted>')
		.replace(/(?:Bearer\s+)?eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '<redacted>')
		.replace(/(authorization|password|secret|token|key|credential|registrationCode|"d")(["' ]*[:=]["' ]*)[^\s,;}]+/giu, '$1$2<redacted>')
		.replace(/Bearer\s+[^\s,;}]+/giu, 'Bearer <redacted>')
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gu, '$1<redacted>@').slice(0, 500);
}

function runtimeRecord(root: string, name: 'manager' | 'runner' | 'capacity-state', owner: number, maximumBytes: number) {
	const directory = join(root, 'runtime');
	for (const path of [root, directory]) {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owner || (stat.mode & 0o077) || realpathSync(path) !== resolve(path)) throw new Error();
	}
	const fd = openSync(join(directory, `${name}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== owner || (stat.mode & 0o077) || stat.size > maximumBytes) throw new Error();
		return record(JSON.parse(readFileSync(fd, 'utf8')));
	} finally { closeSync(fd); }
}
function recoveryStatus(root: string, owner: number) {
	try {
		const state = runtimeRecord(root, 'capacity-state', owner, 16 * 1024 * 1024);
		if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || Number(state.revision) < 0 || !Array.isArray(state.claims)) throw new Error();
		const identity = (value: unknown, optional = false) => {
			if (value === undefined && optional) return null;
			if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/u.test(value)) throw new Error();
			return value;
		};
		const clock = (value: unknown) => {
			if (value === undefined) return null;
			if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/u.test(value) || !Number.isFinite(Date.parse(value))) throw new Error();
			return value;
		};
		const claims = state.claims.slice(0, 128).map(entry => {
			const claim = record(entry), output = record(claim.closeoutOutput), teardown = record(output.teardown);
			if (!['polling', 'ready', 'running', 'recovery', 'unresolved'].includes(String(claim.status))) throw new Error();
			return { id: identity(claim.id), assignmentId: identity(claim.assignmentId, true), status: String(claim.status),
				activeStartedAt: clock(claim.activeStartedAt), activeFinishedAt: clock(claim.activeFinishedAt), accountedThrough: clock(claim.accountedThrough),
				closeoutRecorded: Object.hasOwn(claim, 'closeoutOutput'), sandboxId: identity(output.sandboxId, true),
				teardownVerified: typeof teardown.verified === 'boolean' ? teardown.verified : null, teardownCompletedAt: clock(teardown.completedAt) };
		});
		return { observed: true, revision: state.revision, complete: state.claims.length <= 128, claimCount: state.claims.length, claims };
	} catch (error) {
		return { observed: false, complete: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_observed' : 'unsafe_or_invalid_record' };
	}
}

/** Fixed records and allowlisted recovery facts only; no lease credentials or output bodies. */
export function providerRuntimeStatus(root: string, owner = 65_532, now = Date.now()) {
	return { recovery: recoveryStatus(root, owner), roles: (['manager', 'runner'] as const).map(role => {
		const missing = { role, observed: false, fresh: false, ok: false };
		try {
			const value = runtimeRecord(root, role, owner, 65_536);
			if (value.schemaVersion !== 1 || value.role !== role || typeof value.updatedAt !== 'string') throw new Error();
			const updated = Date.parse(value.updatedAt), fresh = Number.isFinite(updated) && now >= updated && now - updated < 120_000;
			const result = record(value.result);
			const connections = Array.isArray(result.connections) ? result.connections : [];
			const results = Array.isArray(result.results) ? result.results : [];
			const observations = results.slice(0, 32).flatMap(entry => {
				const item = record(entry);
				if (!['idle', 'running', 'completed', 'returned', 'error'].includes(String(item.status))) return [];
				const reason = ['no_assignment', 'local_capacity_exhausted', 'assignment_adapter_unavailable', 'executor_unavailable'].includes(String(item.reason))
					? String(item.reason) : null;
				return [{ status: String(item.status), reason }];
			});
			const errors = [value.error, ...[...connections, ...results].slice(0, 32).map(entry => {
				const item = record(entry);
				return item.error ?? (item.ok === false || item.status === 'error' ? 'connection_reconciliation_failed' : undefined);
			})].map(diagnostic).filter(Boolean);
			if (result.ok === false && errors.length === 0) errors.push('runtime_operation_failed');
			if (role === 'manager' && Array.isArray(result.connections) && connections.length === 0) errors.push('no_provider_connections');
			return { role, observed: true, fresh, ok: fresh && value.ok === true && errors.length === 0, updatedAt: new Date(updated).toISOString(), errors, observations };
		} catch (error) {
			return { ...missing, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_observed' : 'unsafe_or_invalid_record' };
		}
	}) };
}
