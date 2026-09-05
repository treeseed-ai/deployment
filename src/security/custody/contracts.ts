/** Both custody backends use the same non-secret, exact-scope addressing. */
export interface SecretScope {
	team: string;
	project: string;
	environment: string;
	purpose: string;
	name: string;
}

export interface SecretRecord {
	version: number;
	values: Record<string, string>;
}

export class CustodyError extends Error {
	constructor(public readonly code: string) {
		super(`Secret custody: ${code}`);
		this.name = 'CustodyError';
	}
}

export function secretPath(scope: SecretScope): string {
	const parts = [scope.team, scope.project, scope.environment, scope.purpose, scope.name];
	if (parts.some((part) => typeof part !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(part)))
		throw new CustodyError('invalid_scope');
	return `teams/${parts[0]}/projects/${parts[1]}/environments/${parts[2]}/purposes/${parts[3]}/secrets/${parts[4]}`;
}

export function validateSecretValues(values: unknown): asserts values is Record<string, string> {
	if (!values || typeof values !== 'object' || Array.isArray(values)) throw new CustodyError('invalid_values');
	const entries = Object.entries(values);
	if (!entries.length || entries.length > 128 || entries.some(([key, value]) =>
		!/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/u.test(key) || typeof value !== 'string' || value.includes('\0')))
		throw new CustodyError('invalid_values');
	if (Buffer.byteLength(JSON.stringify(values)) > 1024 * 1024) throw new CustodyError('values_too_large');
}

export function validateVersion(version: number): void {
	if (!Number.isSafeInteger(version) || version < 0) throw new CustodyError('invalid_version');
}
