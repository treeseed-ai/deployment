import { canonicalSecretPath, type SecretScope } from '@treeseed/sdk/secrets-capability';
export type { SecretScope } from '@treeseed/sdk/secrets-capability';

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
	try { return canonicalSecretPath(scope); } catch { throw new CustodyError('invalid_scope'); }
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
