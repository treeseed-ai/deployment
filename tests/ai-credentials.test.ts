import { createPublicKey, scryptSync } from 'node:crypto';
import { expect, it } from 'vitest';
import { aiCredentialNames, provisionAiCredentialGraph, type EnsureAiCredential } from '../src/supervisor/ai-credentials.js';

it('generates a complete scoped graph and reuses exact records on repeated initialization', () => {
	const values = new Map<string, string>();
	let writes = 0;
	const ensure: EnsureAiCredential = (id, create) => { if (!values.has(id)) { values.set(id, create()); writes++; } return values.get(id)!; };
	provisionAiCredentialGraph(ensure);
	expect(writes).toBe(Object.keys(aiCredentialNames).length);
	const before = [...values]; provisionAiCredentialGraph(ensure);
	expect([...values]).toEqual(before); expect(writes).toBe(before.length);
	for (const role of ['inference', 'training']) {
		const url = new URL(values.get(`ai-${role}-database-url`)!);
		expect(url.password).toBe(values.get(`ai-${role}-postgres-password`));
		expect(url.hostname).toBe(`${role}-postgres`);
		const records = JSON.parse(values.get(`ai-${role}-api-keys`)!);
		const [, id, secret] = /^ak_([^_]+)_(.+)$/u.exec(values.get(`factory-${role}-key`)!)!;
		const record = records.find((item: any) => item.id === id);
		const [, salt, hash] = record.hash.split(':');
		expect(scryptSync(secret!, salt, 32).toString('hex')).toBe(hash);
		expect(records.every((item: any) => !item.scopes.includes('*'))).toBe(true);
	}
	const source = JSON.parse(values.get('artifact-source-registry')!);
	expect(source.trustedPublicKey).toBe(createPublicKey(values.get('artifact-signing-key')!).export({ type: 'spki', format: 'pem' }).toString());
	expect(source.store).toMatchObject({ backend: 'filesystem', root: '/training-artifacts' });
});

it('resumes a partial initialization without replacing previously created keys', () => {
	const values = new Map<string, string>();
	const ensure: EnsureAiCredential = (id, create) => { if (!values.has(id)) values.set(id, create()); return values.get(id)!; };
	let count = 0;
	expect(() => provisionAiCredentialGraph((id, create) => { if (++count === 8) throw new Error('interrupted'); return ensure(id, create); })).toThrow('interrupted');
	const before = [...values]; provisionAiCredentialGraph(ensure);
	for (const [id, value] of before) expect(values.get(id)).toBe(value);
	expect(values.size).toBe(Object.keys(aiCredentialNames).length);
});
