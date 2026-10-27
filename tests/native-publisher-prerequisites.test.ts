import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

interface Step { name?: string; run?: string; uses?: string; if?: string; env?: Record<string, string>; }
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

it.each([{ exit: 0, report: true }, { exit: 13, report: true }, { exit: 7, report: false }])(
	'reports bounded scene metadata without replacing the original command status: $exit/$report', ({ exit, report }) => {
		const root = mkdtempSync(join(tmpdir(), 'treeseed-scene-report-'));
		try {
			const bin = join(root, 'bin'); mkdirSync(bin);
			const sudo = join(bin, 'sudo'); writeFileSync(sudo, '#!/bin/sh\ncase "$1" in --preserve-env=*) exit "$SCENE_EXIT_CODE";; esac\nexec "$@"\n'); chmodSync(sudo, 0o700);
			if (report) {
				const directory = join(root, '.treeseed/guarantees/runs/actions-unit-1'); mkdirSync(directory, { recursive: true });
				writeFileSync(join(directory, 'report.json'), JSON.stringify({ ok: exit === 0, counts: { failed: exit === 0 ? 0 : 1 },
					privateDetail: 'must-not-appear-in-scene-summary', results: [{ id: 'scene', status: exit === 0 ? 'passed' : 'failed',
						steps: [{ id: 'case', status: exit === 0 ? 'passed' : 'failed', diagnostics: [] }] }] }));
			}
			const command = job('verify', 'verify').steps.find(step => step.name === 'Execute coded sandbox component scenes')?.run;
			expect(command).toBeDefined();
			const result = spawnSync('/usr/bin/bash', ['-euo', 'pipefail', '-c', command!], { encoding: 'utf8',
				env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, GITHUB_WORKSPACE: root, GITHUB_RUN_ID: 'unit', GITHUB_RUN_ATTEMPT: '1', SCENE_EXIT_CODE: String(exit) } });
			expect(result.status, result.stderr).toBe(exit); expect(result.stdout).not.toContain('must-not-appear-in-scene-summary');
			if (report) expect(JSON.parse(result.stdout)).toMatchObject({ ok: exit === 0, counts: { failed: exit === 0 ? 0 : 1 },
				results: [{ id: 'scene', status: exit === 0 ? 'passed' : 'failed', failedSteps: exit === 0 ? [] : [{ id: 'case', status: 'failed', diagnostics: [] }] }] });
			else expect(result.stdout).toBe('');
		} finally { rmSync(root, { recursive: true, force: true }); }
	},
);
