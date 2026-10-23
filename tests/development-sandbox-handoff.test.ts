import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ stateRoot: '', sessionId: 'dev-guest-handoff-refusal' }));
vi.mock('../src/manager/development-sessions.js', () => ({
	DevelopmentSessionStore: class {
		load() {
			return { session: { sessionId: fixture.sessionId, status: 'active', repositories: [],
				targets: [{ projectId: 'agent', targetId: 'sandbox', mode: 'candidate' }] } };
		}
	},
}));
vi.mock('../src/core/configuration.js', () => ({ loadHostConfiguration: () => ({}) }));
vi.mock('../src/supervisor/component.js', async importOriginal => ({
	...await importOriginal<typeof import('../src/supervisor/component.js')>(),
	componentStateRoot: () => fixture.stateRoot,
}));
vi.mock('node:fs', async importOriginal => {
	const actual = await importOriginal<typeof import('node:fs')>();
	return { ...actual, existsSync: (path: unknown) => String(path).endsWith('/agent/sandbox/receipt.json') ? false : actual.existsSync(path as string) };
});

import { executeAgentDevelopmentContainer } from '../src/supervisor/development-agent-container.js';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

it('refuses managed guest replacement before image build or trust changes for a live claim', () => {
	const stateRoot = mkdtempSync(resolve(tmpdir(), 'sandbox-handoff-refusal-')); temporary.push(stateRoot);
	fixture.stateRoot = stateRoot;
	mkdirSync(resolve(stateRoot, 'runtime'));
	writeFileSync(resolve(stateRoot, 'runtime/capacity-state.json'), JSON.stringify({ schemaVersion: 1, claims: [{ id: 'live', status: 'running' }] }));
	const effects: string[] = [];
	expect(() => executeAgentDevelopmentContainer({ sessionId: fixture.sessionId, projectId: 'agent', targetId: 'sandbox', action: 'start' },
		(executable, args) => { effects.push(`${executable}:${args.join(' ')}`); return ''; })).toThrow('active or recoverable');
	expect(effects).toEqual([]);
});
