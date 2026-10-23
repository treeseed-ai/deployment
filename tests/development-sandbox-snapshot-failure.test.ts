import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const snapshotFault = vi.hoisted(() => ({ afterCopy: false }));
vi.mock('node:fs', async importOriginal => {
	const actual = await importOriginal<typeof import('node:fs')>();
	return { ...actual, cpSync: (...args: Parameters<typeof actual.cpSync>) => {
		actual.cpSync(...args);
		if (snapshotFault.afterCopy) throw new Error('simulated snapshot copy interruption');
	} };
});
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
	snapshotFault.afterCopy = true;
	let snapshotFailure: unknown;
	try {
		cpSync(provider, snapshot, { recursive: true, errorOnExist: true, force: false });
	} catch (error) {
		snapshotFailure = error;
	} finally {
		snapshotFault.afterCopy = false;
	}
	expect(snapshotFailure).toBeInstanceOf(Error);
	expect(readFileSync(resolve(snapshot, 'settings.json'))).toEqual(original);
	restoreSandboxProviderDirectory(true, true, false, provider, snapshot);
	expect(existsSync(marker)).toBe(true);
	expect(readFileSync(marker)).toEqual(original);
	expect(existsSync(snapshot)).toBe(false);
});
