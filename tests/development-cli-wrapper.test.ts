import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('uses a persistent selection until it is explicitly cleared', () => {
	const root = mkdtempSync(resolve(tmpdir(), 'treeseed-cli-wrapper-'));
	try {
		const selected = resolve(root, 'live.cjs'), released = resolve(root, 'released.cjs');
		writeFileSync(selected, 'console.log("live")'); writeFileSync(released, 'console.log("released")');
		const wrapper = readFileSync(new URL('../scripts/cli-wrapper.sh', import.meta.url), 'utf8')
			.replaceAll('/usr/lib/treeseed/runtime/bin/node', process.execPath)
			.replaceAll('/usr/lib/treeseed/cli/dist/cli/main.js', released);
		expect(wrapper).not.toMatch(/date \+%s|EXPIRES/);
		const path = resolve(root, 'wrapper.sh'); writeFileSync(path, wrapper);
		const state = resolve(root, 'treeseed/development'); mkdirSync(state, { recursive: true });
		const selection = resolve(state, 'cli-entrypoint');
		const run = () => execFileSync('/bin/sh', [path], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: root } }).trim();
		writeFileSync(selection, `treeseed.development-cli-selection/v2\n${selected}\n`);
		expect(run()).toBe('live'); expect(run()).toBe('live');
		rmSync(selection); expect(run()).toBe('released');
		writeFileSync(selection, `treeseed.development-cli-selection/v1\n9999999999\n${selected}\n`);
		expect(run()).toBe('released');
	} finally { rmSync(root, { recursive: true, force: true }); }
});
