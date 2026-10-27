import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { expect, it } from 'vitest';
import { nativeWorkflow } from './support/native-workflow.js';

interface Step { name?: string; run?: string; uses?: string; if?: string; env?: Record<string, string>; with?: Record<string, string>; }
interface Job { 'runs-on': string; env?: Record<string, string>; steps: Step[]; }
function job(workflow: string, name: string): Job {
	const source = readFileSync(new URL(`../.github/workflows/${workflow}.yml`, import.meta.url), 'utf8');
	return (parse(source) as { jobs: Record<string, Job> }).jobs[name]!;
}

it.each([['verify', 'verify'], ['publish', 'publish']])('requires the existing native initializer before the complete owning suite in %s', (workflow, name) => {
	const selected = job(workflow, name), steps = nativeWorkflow(readFileSync(new URL(`../.github/workflows/${workflow}.yml`, import.meta.url), 'utf8')).jobs[name].steps as Step[];
	const build = steps.findIndex(step => step.run?.includes('npm run build:deb'));
	const initialize = steps.findIndex(step => step.run?.includes('scripts/verify-native-host.ts'));
	const suite = steps.findIndex(step => step.run?.includes('npm run verify:direct'));
	expect(selected['runs-on']).toBe('ubuntu-26.04');
	expect(build).toBeGreaterThanOrEqual(0);
	expect(initialize).toBeGreaterThan(build);
	expect(suite).toBeGreaterThan(initialize);
	const prepare = steps.findIndex(step => step.with?.repository === 'treeseed-ai/reviewer');
	expect(prepare).toBeGreaterThanOrEqual(0);
	expect(prepare).toBeLessThan(build);
	expect(steps.find(step => step.uses?.startsWith('actions/setup-node@'))?.with?.['node-version']).toBe('24.12.0');
	const prune = steps.findIndex(step => step.run === 'npm prune --ignore-scripts --no-audit --no-fund --workspaces=false');
	expect(prune).toBeGreaterThan(steps.findIndex(step => step.uses?.startsWith('treeseed-ai/sdk/.github/actions/install-exact-sdk@')));
	expect(prune).toBeLessThan(prepare);
	expect(steps[prepare]?.with?.ref).toMatch(/^[a-f0-9]{40}$/u);
	expect(steps.slice(prepare, suite).some(step => step.run === 'npm run --prefix .treeseed/tools/reviewer build:dist')).toBe(true);
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
	for (const selected of steps.filter(step => step.uses === './.github/actions/prepare-reviewer'
		|| step.run === 'npm prune --ignore-scripts --no-audit --no-fund --workspaces=false')) {
		expect(selected.if).toBe('${{ !inputs.resume_apt_only }}');
	}
});

it.each([{ exit: 0, report: true, malformed: false }, { exit: 13, report: true, malformed: false },
	{ exit: 7, report: false, malformed: false }, { exit: 13, report: true, malformed: true }, { exit: 0, report: true, malformed: true }])(
	'reports bounded scene metadata and preserves original failures: $exit/$report/$malformed', ({ exit, report, malformed }) => {
		const root = mkdtempSync(join(tmpdir(), 'treeseed-scene-report-'));
		try {
			const bin = join(root, 'bin'); mkdirSync(bin);
			const sudo = join(bin, 'sudo'); writeFileSync(sudo, '#!/bin/sh\ncase "$1" in --preserve-env=*) exit "$SCENE_EXIT_CODE";; esac\nexec "$@"\n'); chmodSync(sudo, 0o700);
			if (report) {
				const directory = join(root, '.treeseed/guarantees/runs/actions-unit-1'); mkdirSync(directory, { recursive: true });
				writeFileSync(join(directory, 'report.json'), malformed ? '{invalid' : JSON.stringify({ ok: exit === 0, counts: { failed: exit === 0 ? 0 : 1 },
					privateDetail: 'must-not-appear-in-scene-summary', results: [{ id: 'scene', status: exit === 0 ? 'passed' : 'failed',
						steps: [{ id: 'case', status: exit === 0 ? 'passed' : 'failed', diagnostics: [] }] }] }));
			}
			const command = job('verify', 'verify').steps.find(step => step.name === 'Execute coded sandbox component scenes')?.run;
			expect(command).toBeDefined();
			const result = spawnSync('/usr/bin/bash', ['-euo', 'pipefail', '-c', command!], { encoding: 'utf8',
				env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, GITHUB_WORKSPACE: root, GITHUB_RUN_ID: 'unit', GITHUB_RUN_ATTEMPT: '1', SCENE_EXIT_CODE: String(exit) } });
			expect(result.status, result.stderr).toBe(malformed && exit === 0 ? 1 : exit); expect(result.stdout).not.toContain('must-not-appear-in-scene-summary');
			if (report && !malformed) expect(JSON.parse(result.stdout)).toMatchObject({ ok: exit === 0, counts: { failed: exit === 0 ? 0 : 1 },
				results: [{ id: 'scene', status: exit === 0 ? 'passed' : 'failed', failedSteps: exit === 0 ? [] : [{ id: 'case', status: 'failed', diagnostics: [] }] }] });
			else expect(result.stdout).toBe('');
		} finally { rmSync(root, { recursive: true, force: true }); }
	},
);
