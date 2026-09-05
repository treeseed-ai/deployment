import { CustodyError, secretPath, validateSecretValues, validateVersion, type SecretRecord, type SecretScope } from './contracts.js';

/** Transport for a short-lived identity. The issuer must enforce these scopes in OpenBao policy too. */
export class OpenBaoCustody {
	readonly #address: string;
	readonly #mount: string;
	readonly #token: string;
	readonly #fetch: typeof fetch;
	readonly #paths: Set<string>;
	#closed = false;

	constructor(options: { address: string; mount: string; token: string; scopes: SecretScope[]; fetchImpl?: typeof fetch }) {
		let url: URL;
		try { url = new URL(options.address); } catch { throw new CustodyError('invalid_address'); }
		if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
			throw new CustodyError('invalid_address');
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(options.mount)) throw new CustodyError('invalid_mount');
		if (!options.token || /[\s\x00-\x1f\x7f]/u.test(options.token)) throw new CustodyError('invalid_token');
		this.#address = url.origin;
		this.#mount = options.mount;
		this.#token = options.token;
		this.#fetch = options.fetchImpl ?? fetch;
		if (!options.scopes.length || options.scopes.length > 128) throw new CustodyError('invalid_scope');
		this.#paths = new Set(options.scopes.map(secretPath));
	}

	#path(scope: SecretScope): string {
		const path = secretPath(scope);
		if (!this.#paths.has(path)) throw new CustodyError('scope_denied');
		return path;
	}

	async #request(path: string, method: string, body?: unknown, missingAllowed = false): Promise<any> {
		if (this.#closed) throw new CustodyError('session_closed');
		try {
			const response = await this.#fetch(`${this.#address}/v1/${path}`, {
				method, redirect: 'error', signal: AbortSignal.timeout(15_000),
				headers: { 'x-vault-token': this.#token, 'content-type': 'application/json' },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			if (response.status === 404 && missingAllowed) return null;
			if (!response.ok) throw new CustodyError(`openbao_http_${response.status}`);
			if (response.status === 204) return null;
			if (!response.body) throw new CustodyError('invalid_response');
			const reader = response.body.getReader(), chunks: Uint8Array[] = [];
			let bytes = 0;
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					bytes += value.byteLength;
					if (bytes > 2 * 1024 * 1024) throw new CustodyError('response_too_large');
					chunks.push(value);
				}
				return JSON.parse(Buffer.concat(chunks).toString('utf8'));
			} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
		} catch (error) {
			// Provider errors and response bodies may contain credentials; never propagate them.
			if (error instanceof CustodyError) throw error;
			throw new CustodyError('openbao_request_failed');
		}
	}

	async read(scope: SecretScope): Promise<SecretRecord | null> {
		const result = await this.#request(`${this.#mount}/data/${this.#path(scope)}`, 'GET', undefined, true);
		if (result === null) return null;
		const values: unknown = result?.data?.data, version: unknown = result?.data?.metadata?.version;
		validateSecretValues(values);
		if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw new CustodyError('invalid_record');
		return { values, version };
	}

	async write(scope: SecretScope, values: Record<string, string>, expectedVersion: number): Promise<number> {
		const path = this.#path(scope);
		validateSecretValues(values);
		validateVersion(expectedVersion);
		const result = await this.#request(`${this.#mount}/data/${path}`, 'POST', { options: { cas: expectedVersion }, data: values });
		if (result?.data?.version !== expectedVersion + 1) throw new CustodyError('invalid_write_receipt');
		return result.data.version;
	}

	/** Only tombstones the selected version, never a concurrently rotated latest version. */
	async tombstone(scope: SecretScope, version: number): Promise<void> {
		validateVersion(version);
		if (version === 0) throw new CustodyError('invalid_version');
		await this.#request(`${this.#mount}/delete/${this.#path(scope)}`, 'POST', { versions: [version] });
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		try { await this.#request('auth/token/revoke-self', 'POST'); }
		finally { this.#closed = true; }
	}
}
