import { describe, expect, it, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { componentManagedFiles } from '../src/core/component-files.js';
import { installedComponentRelease } from '../src/supervisor/component-release.js';
import { managedRuntimeInputEnvironment } from '../src/manager/runtime-inputs.js';
import { component, host } from './fixtures.js';

vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), lstatSync: vi.fn(), readFileSync: vi.fn() }));

function release() {
	const value = component('api', 'development', 'a');
	value.runtime.configuration.files = [{ id: 'policy.yaml', path: '/etc/treeseed/components/api/policy.yaml', required: true, sensitive: false, default: 'current' }];
	return value;
}

describe('package-owned managed file defaults', () => {
	afterEach(() => vi.restoreAllMocks());
	it('uses current release defaults without creating host overrides', () => {
		const current = release(), configuration = host();
		configuration.components.api!.configuration = {};
		expect(managedRuntimeInputEnvironment(configuration, current)).toEqual({});
		expect(componentManagedFiles(current)).toEqual({ 'policy.yaml': 'current' });
		current.runtime.configuration.files[0]!.default = 'next';
		expect(componentManagedFiles(current)).toEqual({ 'policy.yaml': 'next' });
		expect(configuration.components.api!.configuration).toEqual({});
	});
	it('preserves explicit overrides, including empty content', () => {
		expect(componentManagedFiles(release(), { 'policy.yaml': 'custom' })).toEqual({ 'policy.yaml': 'custom' });
		expect(componentManagedFiles(release(), { 'policy.yaml': '' })).toEqual({ 'policy.yaml': '' });
	});
	it('rejects missing required content, undeclared files, invalid content and paths', () => {
		const current = release();
		expect(() => componentManagedFiles(current, { other: 'value' })).toThrow(/Undeclared/);
		expect(() => componentManagedFiles(current, { 'policy.yaml': null })).toThrow(/content/);
		delete current.runtime.configuration.files[0]!.default;
		expect(() => componentManagedFiles(current)).toThrow(/Required/);
		current.runtime.configuration.files[0]!.required = false;
		expect(componentManagedFiles(current)).toEqual({});
		current.runtime.configuration.files[0]!.path = '/tmp/policy.yaml';
		expect(() => componentManagedFiles(current)).toThrow(/path/);
	});
	function custody(current = release()) {
		vi.spyOn(fs, 'lstatSync').mockImplementation((path: any) => ({ uid: 0, mode: 0o755, size: 100, isSymbolicLink: () => false, isFile: () => String(path).endsWith('.json'), isDirectory: () => !String(path).endsWith('.json') }) as any);
		vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(current));
		return current;
	}
	it('reads only the requested root-owned installed release and checks identity', () => {
		const current = custody();
		expect(installedComponentRelease('api', current.release).release).toBe(current.release);
		expect(fs.readFileSync).toHaveBeenCalledWith(`/usr/share/treeseed/components/api/${current.release}/component-release.json`, 'utf8');
		expect(() => installedComponentRelease('agent', current.release)).toThrow(/identity mismatch/);
		expect(() => installedComponentRelease('api', '../escape')).toThrow(/identity/);
	});
	it.each(['symlink', 'writable', 'owner'])('rejects unsafe installed custody: %s', (kind) => {
		const current = custody();
		vi.mocked(fs.lstatSync).mockReturnValue({ uid: kind === 'owner' ? 1000 : 0, mode: kind === 'writable' ? 0o777 : 0o755, isSymbolicLink: () => kind === 'symlink', isDirectory: () => true } as any);
		expect(() => installedComponentRelease('api', current.release)).toThrow(/custody/);
		expect(fs.readFileSync).not.toHaveBeenCalled();
	});
});
