import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { restoreSandboxProviderDirectory } from '../src/supervisor/development-agent-container.js';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

it('preserves the selected provider directory when its preselection snapshot copy fails', () => {
	const root = mkdtempSync(resolve(tmpdir(), 'sandbox-provider-snapshot-'));
	temporary.push(root);
	const provider = resolve(root, 'provider');
	const snapshot = resolve(root, 'provider-prior');
	const marker = resolve(provider, 'settings.json');
	const original = Buffer.from('{"provider":"prior"}');
	mkdirSync(provider);
	writeFileSync(marker, original);
	mkdirSync(snapshot);
	writeFileSync(resolve(snapshot, 'settings.json'), 'preexisting snapshot');
	let snapshotFailure: unknown;
	try {
		cpSync(provider, snapshot, { recursive: true, errorOnExist: true, force: false });
	} catch (error) {
		snapshotFailure = error;
	}
	expect(snapshotFailure).toBeInstanceOf(Error);
	restoreSandboxProviderDirectory(true, true, false, provider, snapshot);
	expect(existsSync(marker)).toBe(true);
	expect(readFileSync(marker)).toEqual(original);
});
