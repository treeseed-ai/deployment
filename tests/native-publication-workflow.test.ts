import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { expandNativeSteps, nativeVerificationAction } from './fixtures/native-verification-steps.js';

it('shares the complete original native prerequisites suites and scenes before verification or release packaging', () => {
	const held = new Map<string, Buffer>();
	for (const [name, job] of [['verify', 'verify'], ['publish', 'publish']]) {
		const path = `.github/workflows/${name}.yml`, bytes = readFileSync(path); held.set(path, bytes);
		const workflow = parse(bytes.toString()), owner = workflow.jobs[job!];
		const declared = owner.steps as { uses?: string; if?: string }[];
		const shared = declared.filter(step => step.uses === nativeVerificationAction);
		expect(shared, name).toHaveLength(1);
		const directSdk = declared.filter(step => step.uses?.startsWith('treeseed-ai/sdk/.github/actions/install-exact-sdk@'));
		expect(directSdk, name).toHaveLength(1);
		expect(declared.indexOf(directSdk[0]!)).toBeLessThan(declared.indexOf(shared[0]!));
		expect(owner['runs-on']).toBe('ubuntu-26.04');
		expect(owner.env.NPM_CONFIG_CACHE).toBe('${{ github.workspace }}/.treeseed/npm-cache');
		if (name === 'publish') {
			expect(shared[0]!.if).toBe('${{ !inputs.resume_apt_only }}');
			expect(workflow.permissions.actions).toBe('read');
		}
		const steps = expandNativeSteps(owner.steps) as { name?: string; run?: string; env?: Record<string, string> }[];
		const installed = steps.findIndex(step => step.name === 'Initialize disposable native capacity host');
		const complete = steps.findIndex(step => step.run?.includes('npm run verify:direct'));
		const scenes = steps.findIndex(step => step.name === 'Execute coded sandbox component scenes');
		const packaging = steps.findIndex(step => step.run === 'npm run verify:deb');
		expect(installed).toBeGreaterThan(-1); expect(complete).toBeGreaterThan(installed);
		expect(scenes).toBeGreaterThan(complete); expect(packaging).toBeGreaterThan(scenes);
		expect(steps[complete]!.run).toContain('sudo --preserve-env=');
		expect(steps[complete]!.env?.TREESEED_PRIVILEGED_CACHE_TESTS).toBe('1');
		expect(steps[scenes]!.run).toContain('guarantee.deployment.golden.component-boundaries');
		expect(steps.filter(step => step.run?.includes('npm run verify:direct'))).toHaveLength(1);
	}
	const path = '.github/actions/verify-native/action.yml', bytes = readFileSync(path); held.set(path, bytes);
	const action = parse(bytes.toString()); expect(action.inputs).toBeUndefined();
	for (const step of action.runs.steps) if (step.run) expect(step.shell).toBe('bash');
	for (const step of action.runs.steps) if (step.uses?.startsWith('treeseed-ai/sdk/.github/actions/install-exact-sdk@')) {
		expect(typeof step.with?.commit).toBe('string'); expect(step.with.commit.trim().length).toBeGreaterThan(0);
	}
	for (const [path, bytes] of held) expect(readFileSync(path)).toEqual(bytes);
});
