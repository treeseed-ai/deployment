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

/** Fixed role records only: never expose assignments, outputs, credentials, or arbitrary paths. */
export function providerRuntimeStatus(root: string, owner = 65_532, now = Date.now()) {
	return { roles: (['manager', 'runner'] as const).map(role => {
		const missing = { role, observed: false, fresh: false, ok: false };
		let fd: number | undefined;
		try {
			const directory = join(root, 'runtime');
			for (const path of [root, directory]) {
				const stat = lstatSync(path);
				if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owner || (stat.mode & 0o077) || realpathSync(path) !== resolve(path)) throw new Error();
			}
			fd = openSync(join(directory, `${role}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== owner || (stat.mode & 0o077) || stat.size > 65_536) throw new Error();
			const value = record(JSON.parse(readFileSync(fd, 'utf8')));
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
		} finally { if (fd !== undefined) closeSync(fd); }
	}) };
}
