import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

it('finishes dependency pruning before restoring the checked SDK in verification and publication', () => {
	for (const [file, job] of [['verify', 'verify'], ['publish', 'publish']]) {
		const workflow = parse(readFileSync(`.github/workflows/${file}.yml`, 'utf8'));
		const steps = workflow.jobs[job].steps as Array<{ run?: string; uses?: string }>;
		const prune = steps.findIndex(step => step.run === 'npm prune --ignore-scripts --no-audit --no-fund --workspaces=false');
		const hydrate = steps.findIndex(step => step.uses === 'treeseed-ai/sdk/.github/actions/install-exact-sdk@cbc03314871d271bce7275c5cee71d950397a0c3');
		expect(prune).toBeGreaterThanOrEqual(0);
		expect(hydrate).toBeGreaterThan(prune);
	}
});

it('declares the checked SDK as a bundled runtime dependency without replacing its source', () => {
	const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
	expect(manifest.bundleDependencies).toContain('@treeseed/sdk');
	expect(manifest.dependencies['@treeseed/sdk']).toBe('git+https://github.com/treeseed-ai/sdk.git#cbc03314871d271bce7275c5cee71d950397a0c3');
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
		const installed = join(root, 'node_modules/@treeseed/deployment');
		expect(existsSync(join(installed, 'src'))).toBe(false);
		const sdkPath = 'node_modules/@treeseed/sdk/dist/configuration/secrets-capability.js';
		expect(readFileSync(join(installed, sdkPath))).toEqual(readFileSync(resolve(sdkPath)));
		expect(JSON.parse(run(process.execPath, ['--input-type=module', '--eval',
			"const runtime = await import('@treeseed/deployment'); console.log(JSON.stringify({ roots: Array.isArray(runtime.agentDevelopmentRuntimeRoots), copy: typeof runtime.copyDevelopmentRuntime }));"])))
			.toEqual({ roots: true, copy: 'function' });
		expect(readFileSync(archive)).toEqual(bytes);
		expect(readFileSync('package.json')).toEqual(manifest);
		expect(readFileSync('package-lock.json')).toEqual(lock);
	} finally {
		rmSync(root, { recursive: true, force: true });
		expect(existsSync(root)).toBe(false);
	}
}, 60_000);
