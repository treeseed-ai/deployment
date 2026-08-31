import { describe, expect, it } from 'vitest';
import { hostInitializationProfileSchema, type ReleaseCatalog } from '@treeseed/sdk/deployment';
import { planHostInitialization, validateHostInitializationInputs } from '../src/manager/initialization.js';

const digest = `sha256:${'a'.repeat(64)}`;
function catalog(): ReleaseCatalog {
	const profile = hostInitializationProfileSchema.parse({ schemaVersion: 'treeseed.host-initialization-profile/v1', id: 'capacity-provider', role: 'capacity-provider', runtime: { management: 'managed', environment: 'track-default' }, components: ['agent'], security: { requirement: 'required' }, inputs: [
		{ name: 'controlPlaneUrl', required: true, sensitive: false, description: 'Control-plane API HTTPS URL' },
		{ name: 'teamRegistrationCode', required: true, sensitive: true, description: 'Team registration code' },
	] });
	return { schemaVersion: 'treeseed.release-catalog/v1', release: '0.1.0~rc183', generation: 144, track: 'development', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: digest, stableBase: { release: '0.1.0', catalogDigest: digest }, components: [], hostProfiles: [profile], createdAt: '2026-08-31T17:30:00.000Z' };
}

describe('host initialization planning', () => {
	it('selects an exact catalog profile without returning values', () => {
		const stable = { ...catalog(), track: 'stable' as const, release: '0.1.0', generation: 36, stableBase: null, hostProfiles: [] };
		const plan = planHostInitialization('capacity-provider', stable, catalog());
		expect(plan).toMatchObject({ mode: 'plan', profile: 'capacity-provider', track: 'development', components: ['agent'], configured: false, mutation: false });
		expect(JSON.stringify(plan)).not.toContain('private-code');
	});

	it('validates all and only declared inputs while returning names only', () => {
		const stable = { ...catalog(), track: 'stable' as const, release: '0.1.0', generation: 36, stableBase: null, hostProfiles: [] };
		const plan = planHostInitialization('capacity-provider', stable, catalog());
		expect(validateHostInitializationInputs(plan, { controlPlaneUrl: 'https://api.example.test', teamRegistrationCode: 'private-code' })).toEqual(['controlPlaneUrl', 'teamRegistrationCode']);
		expect(() => validateHostInitializationInputs(plan, { controlPlaneUrl: 'http://api.example.test', teamRegistrationCode: 'private-code' })).toThrow(/HTTPS/u);
		expect(() => validateHostInitializationInputs(plan, { controlPlaneUrl: 'https://api.example.test', invented: 'value' })).toThrow(/undeclared/u);
	});

	it('fails closed for profiles absent from installed catalogs', () => {
		const stable = { ...catalog(), track: 'stable' as const, release: '0.1.0', generation: 36, stableBase: null, hostProfiles: [] };
		expect(() => planHostInitialization('treeai', stable)).toThrow(/not present/u);
	});
});
