import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activateHostDevelopment, hostDevelopmentActivationSchema, hostDevelopmentStatus, switchHostDevelopment } from '../src/supervisor/host-development.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';

const digest = `sha256:${'a'.repeat(64)}`;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const activation = {
	generationId: 'dev-1788100000000-deadbeef',
	worktree: '/home/developer/Projects/treeseed/platform/packages/deployment',
	packageSha256: digest,
	files: [
		{ path: 'package.json', size: 100, sha256: digest },
		{ path: 'dist/src/bin/api.js', size: 100, sha256: digest },
		{ path: 'dist/src/bin/sandbox-broker.js', size: 100, sha256: digest },
		{ path: 'dist/src/bin/supervisor.js', size: 100, sha256: digest },
	],
};

describe('host development bridge contracts', () => {
	it('accepts one bounded exact-file generation', () => {
		expect(hostDevelopmentActivationSchema.parse(activation)).toEqual(activation);
		expect(supervisorOperationSchema.parse({ operation: 'host.development.activate', activation })).toEqual({ operation: 'host.development.activate', activation });
	});

	it('rejects source traversal and mutable image tags', () => {
		expect(() => hostDevelopmentActivationSchema.parse({ ...activation, files: [{ ...activation.files[0], path: 'dist/../secrets' }] })).toThrow();
		expect(() => hostDevelopmentActivationSchema.parse({ ...activation, guestImageDigest: 'latest' })).toThrow();
	});

	it('stages an exact generation and rolls back failed service health', () => {
		const fixture = mkdtempSync(resolve(tmpdir(), 'treeseed-host-development-')); roots.push(fixture);
		const worktree = resolve(fixture, 'deployment'), host = resolve(fixture, 'host'), systemd = resolve(fixture, 'systemd');
		mkdirSync(resolve(worktree, 'src/bin'), { recursive: true }); mkdirSync(resolve(worktree, 'dist/src/bin'), { recursive: true });
		writeFileSync(resolve(worktree, 'src/bin/supervisor.ts'), 'source'); writeFileSync(resolve(worktree, 'package.json'), '{"type":"module"}');
		for (const name of ['api.js', 'sandbox-broker.js', 'supervisor.js']) writeFileSync(resolve(worktree, 'dist/src/bin', name), `export const name = '${name}';\n`);
		const exact = (path: string) => { const content = readFileSync(resolve(worktree, path)); return { path, size: content.byteLength, sha256: `sha256:${createHash('sha256').update(content).digest('hex')}` }; };
		const input = { generationId: 'dev-1788100000000-deadbeef', worktree, packageSha256: exact('package.json').sha256, files: ['package.json', 'dist/src/bin/api.js', 'dist/src/bin/sandbox-broker.js', 'dist/src/bin/supervisor.js'].map(exact) };
		const commands: string[] = [], command = (executable: string, arguments_: readonly string[]) => { commands.push(`${executable} ${arguments_.join(' ')}`); };
		expect(activateHostDevelopment(input, command, { host, systemd }).status).toBe('activating');
		expect(existsSync(resolve(systemd, 'treeseed-manager-api.service.d/90-treeseed-host-development.conf'))).toBe(true);
		let rejected = false;
		expect(() => switchHostDevelopment('activate', input.generationId, (executable, arguments_) => {
			if (!rejected && arguments_.includes('is-active') && arguments_.includes('treeseed-sandbox-broker.service')) { rejected = true; throw new Error('broker unhealthy'); }
			commands.push(`${executable} ${arguments_.join(' ')}`);
		}, { host, systemd })).toThrow(/broker unhealthy/u);
		expect(hostDevelopmentStatus(host).status).toBe('rolled-back');
		expect(existsSync(resolve(systemd, 'treeseed-manager-api.service.d/90-treeseed-host-development.conf'))).toBe(false);
		expect(commands.some((entry) => entry.includes('systemd-run'))).toBe(true);
	});
});
