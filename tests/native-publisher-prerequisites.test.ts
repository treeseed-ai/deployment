import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

interface Step { run?: string; uses?: string; if?: string; env?: Record<string, string>; }
interface Job { 'runs-on': string; env?: Record<string, string>; steps: Step[]; }
function job(workflow: string, name: string): Job {
	const source = readFileSync(new URL(`../.github/workflows/${workflow}.yml`, import.meta.url), 'utf8');
	return (parse(source) as { jobs: Record<string, Job> }).jobs[name]!;
}

it.each([['verify', 'verify'], ['publish', 'publish']])('requires the existing native initializer before the complete owning suite in %s', (workflow, name) => {
	const selected = job(workflow, name), steps = selected.steps;
	const build = steps.findIndex(step => step.run?.includes('npm run build:deb'));
	const initialize = steps.findIndex(step => step.run?.includes('scripts/verify-native-host.ts'));
	const suite = steps.findIndex(step => step.run?.includes('npm run verify:direct'));
	expect(selected['runs-on']).toBe('ubuntu-26.04');
	expect(build).toBeGreaterThanOrEqual(0);
	expect(initialize).toBeGreaterThan(build);
	expect(suite).toBeGreaterThan(initialize);
	expect(steps.slice(0, build).some(step => step.uses?.startsWith('treeseed-ai/sdk/.github/actions/install-exact-sdk@'))).toBe(true);
	for (const index of [initialize, suite]) {
		expect(steps[index]?.run).toContain('sudo --preserve-env=');
		expect(steps[index]?.env?.TREESEED_PRIVILEGED_CACHE_TESTS).toBe('1');
	}
	expect(selected.env?.NPM_CONFIG_CACHE).toBe('${{ github.workspace }}/.treeseed/npm-cache');
	expect(steps.slice(suite + 1).some(step => step.run?.includes('sudo chown --no-dereference --recursive'))).toBe(true);
});

it('keeps native installation and the complete suite out of an exact APT-only resume', () => {
	const steps = job('publish', 'publish').steps;
	for (const command of ['npm run build:deb', 'scripts/verify-native-host.ts', 'npm run verify:direct']) {
		const selected = steps.find(step => step.run?.includes(command));
		expect(selected).toBeDefined();
		expect(selected?.if).toBe('${{ !inputs.resume_apt_only }}');
	}
});
