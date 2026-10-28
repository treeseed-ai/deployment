import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('declares one exact prebuilt SDK release matching its locked registry package', () => {
	const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
	const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
	const version = manifest.dependencies['@treeseed/sdk'];
	expect(version).toMatch(/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u);
	expect(lock.packages['node_modules/@treeseed/sdk'].version).toBe(version);
	expect(lock.packages['node_modules/@treeseed/sdk'].resolved).toBe(`https://registry.npmjs.org/@treeseed/sdk/-/sdk-${version}.tgz`);
});

it('fresh production archive installation loads the public runtime with its exact compiled SDK and scripts disabled', () => {
	const root = mkdtempSync(join(tmpdir(), 'deployment-runtime-install-'));
	const manifest = readFileSync('package.json'), lock = readFileSync('package-lock.json');
	const run = (command: string, args: string[], cwd = root) => execFileSync(command, args, {
		cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 4_194_304,
		env: { ...process.env, NODE_OPTIONS: '' },
	});
	try {
		const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], process.cwd())) as Array<{ filename: string; integrity: string }>;
		expect(packed).toBeDefined();
		if (!packed) throw new Error('Deployment archive was not produced.');
		const archive = join(root, packed.filename), bytes = readFileSync(archive);
		expect(`sha512-${createHash('sha512').update(bytes).digest('base64')}`).toBe(packed.integrity);
		run('npm', ['install', '--prefix', root, '--omit=dev', '--ignore-scripts', '--package-lock=false', '--no-save', '--no-audit', '--no-fund', archive]);
		run('npm', ['ls', '--all', '--omit=dev', '--json']);
		expect(JSON.parse(run(process.execPath, ['--input-type=module', '--eval',
			"const runtime = await import('@treeseed/deployment'); console.log(JSON.stringify({ roots: Array.isArray(runtime.agentDevelopmentRuntimeRoots), copy: typeof runtime.copyDevelopmentRuntime }));"])))
			.toEqual({ roots: true, copy: 'function' });
		const installed = join(root, 'node_modules/@treeseed/deployment');
		for (const path of ['src', 'node_modules/@treeseed/sdk']) expect(existsSync(join(installed, path))).toBe(false);
		const sdkPath = 'node_modules/@treeseed/sdk/dist/configuration/secrets-capability.js';
		expect(readFileSync(join(root, sdkPath))).toEqual(readFileSync(resolve(sdkPath)));
		expect(readFileSync(archive)).toEqual(bytes);
		expect(readFileSync('package.json')).toEqual(manifest);
		expect(readFileSync('package-lock.json')).toEqual(lock);
	} finally {
		rmSync(root, { recursive: true, force: true });
		expect(existsSync(root)).toBe(false);
	}
}, 60_000);
