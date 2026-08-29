import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SandboxAssignment, SandboxLeaseRenewal } from '@treeseed/sdk/capacity-provider';
import { z } from 'zod';

const registrySchema = z.object({ schemaVersion: z.literal(1), providers: z.record(z.object({ publicJwk: z.object({
	crv: z.literal('Ed25519'), kty: z.literal('OKP'), x: z.string().min(1),
}).strict(), providerId: z.string().min(1), teamId: z.string().min(1) }).strict()) }).strict();

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
	return JSON.stringify(value);
}

export function verifySandboxAssignment(assignment: SandboxAssignment, registryPath: string) {
	const registry = registrySchema.parse(JSON.parse(readFileSync(registryPath, 'utf8')));
	const trusted = registry.providers[assignment.signature.keyId];
	if (!trusted) throw new Error('Sandbox assignment signing key is not trusted.');
	if (trusted.providerId !== assignment.providerId || trusted.teamId !== assignment.teamId) throw new Error('Sandbox assignment provider or team identity is outside the trusted signing-key scope.');
	const { signature, ...unsigned } = assignment;
	const key = createPublicKey({ key: trusted.publicJwk as JsonWebKey, format: 'jwk' });
	if (!verify(null, Buffer.from(canonical(unsigned)), key, Buffer.from(signature.value, 'base64url'))) throw new Error('Sandbox assignment signature is invalid.');
}

export function verifySandboxLeaseRenewal(renewal: SandboxLeaseRenewal, registryPath: string) {
	const registry = registrySchema.parse(JSON.parse(readFileSync(registryPath, 'utf8'))), trusted = registry.providers[renewal.signature.keyId];
	if (!trusted || trusted.providerId !== renewal.providerId || trusted.teamId !== renewal.teamId) throw new Error('Sandbox lease renewal signing identity is not trusted for this provider and team.');
	const { signature, ...unsigned } = renewal, key = createPublicKey({ key: trusted.publicJwk as JsonWebKey, format: 'jwk' });
	if (!verify(null, Buffer.from(canonical(unsigned)), key, Buffer.from(signature.value, 'base64url'))) throw new Error('Sandbox lease renewal signature is invalid.');
}
