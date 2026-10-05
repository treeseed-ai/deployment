import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importProviderEnvironmentValues, listProviderEnvironmentProfiles, parseProviderEnvironmentFile, rotateProviderEnvironmentValue, setProviderEnvironmentValue, showProviderEnvironmentProfile, unsetProviderEnvironmentValue } from '../src/security/provider-environment.js';

const roots: string[] = [];
function root() { const value = mkdtempSync(resolve(tmpdir(), 'treeseed-provider-environment-')); roots.push(value); return value; }
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe('provider environment custody', () => {
	it('stores values under restrictive provider custody while returning only descriptors', () => {
		const directory = root(), secret = 'private-provider-value';
		const created = setProviderEnvironmentValue('runtime', 'API_TOKEN', secret, directory);
		expect(created).toMatchObject({ schemaVersion: 'treeseed.provider-environment-profile/v1', id: 'runtime', generation: 1, variables: [{ name: 'API_TOKEN', available: true }] });
		expect(JSON.stringify(created)).not.toContain(secret);
		expect(JSON.stringify(listProviderEnvironmentProfiles(directory))).not.toContain(secret);
		expect(readFileSync(resolve(directory, 'runtime/values/API_TOKEN'), 'utf8')).toBe(secret);
		expect(statSync(resolve(directory, 'runtime/values/API_TOKEN')).mode & 0o777).toBe(0o600);
		expect(readFileSync(resolve(directory, 'runtime/profile.json'), 'utf8')).not.toContain(secret);
	});

	it('is idempotent for unchanged set and import but rotation always advances generation', () => {
		const directory = root();
		expect(setProviderEnvironmentValue('runtime', 'API_TOKEN', 'first', directory).generation).toBe(1);
		expect(setProviderEnvironmentValue('runtime', 'API_TOKEN', 'first', directory).generation).toBe(1);
		expect(importProviderEnvironmentValues('runtime', 'API_TOKEN=first\nMODEL_ID=model-a\n', directory).generation).toBe(2);
		expect(importProviderEnvironmentValues('runtime', 'API_TOKEN=first\nMODEL_ID=model-a\n', directory).generation).toBe(2);
		expect(rotateProviderEnvironmentValue('runtime', 'API_TOKEN', 'first', directory).generation).toBe(3);
		expect(unsetProviderEnvironmentValue('runtime', 'MODEL_ID', directory).generation).toBe(4);
		expect(unsetProviderEnvironmentValue('runtime', 'MODEL_ID', directory).generation).toBe(4);
	});

	it('rejects malformed, duplicate, empty, and NUL-bearing env-file input', () => {
		expect(() => parseProviderEnvironmentFile('lower=value\n')).toThrow();
		expect(() => parseProviderEnvironmentFile('TOKEN=one\nTOKEN=two\n')).toThrow(/duplicate/u);
		expect(() => parseProviderEnvironmentFile('# only comments\n')).toThrow(/no values/u);
		expect(() => parseProviderEnvironmentFile('TOKEN=bad\0value\n')).toThrow(/NUL/u);
	});

	it('fails closed on symlinked profiles and never follows a value symlink', () => {
		const directory = root(), outside = root(); symlinkSync(outside, resolve(directory, 'runtime'));
		expect(() => setProviderEnvironmentValue('runtime', 'TOKEN', 'secret', directory)).toThrow(/symbolic links/u);
		expect(() => showProviderEnvironmentProfile('runtime', directory)).toThrow();
	});
});
