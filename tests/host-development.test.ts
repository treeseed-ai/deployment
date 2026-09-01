import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activateHostDevelopment, hostDevelopmentActivationSchema, hostDevelopmentStatus, recordHostDevelopmentGuestImage, switchHostDevelopment } from '../src/supervisor/host-development.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';

const digest = `sha256:${'a'.repeat(64)}`;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const activation = {
	generationId: 'dev-1788100000000-deadbeef',
	worktree: '/workspace/treeseed/platform/packages/deployment',
	packageSha256: digest,
	files: [
		{ path: 'package.json', size: 100, sha256: digest },
		{ path: 'dist/src/bin/api.js', size: 100, sha256: digest },
		{ path: 'dist/src/bin/sandbox-broker.js', size: 100, sha256: digest },
		{ path: 'dist/src/bin/supervisor.js', size: 100, sha256: digest },
		{ path: 'dist/src/bin/reconcile.js', size: 100, sha256: digest },
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
		for (const name of ['api.js', 'sandbox-broker.js', 'supervisor.js', 'reconcile.js', 'host-development-switch.js']) writeFileSync(resolve(worktree, 'dist/src/bin', name), `export const name = '${name}';\n`);
		const exact = (path: string) => { const content = readFileSync(resolve(worktree, path)); return { path, size: content.byteLength, sha256: `sha256:${createHash('sha256').update(content).digest('hex')}` }; };
		const input = { generationId: 'dev-1788100000000-deadbeef', worktree, packageSha256: exact('package.json').sha256, files: ['package.json', 'dist/src/bin/api.js', 'dist/src/bin/sandbox-broker.js', 'dist/src/bin/supervisor.js', 'dist/src/bin/reconcile.js', 'dist/src/bin/host-development-switch.js'].map(exact) };
		const commands: string[] = [], command = (executable: string, arguments_: readonly string[]) => { commands.push(`${executable} ${arguments_.join(' ')}`); };
		expect(activateHostDevelopment(input, command, { host, systemd }).status).toBe('activating');
		expect(existsSync(resolve(systemd, 'treeseed-manager-api.service.d/90-treeseed-host-development.conf'))).toBe(false);
		let rejected = false;
		expect(() => switchHostDevelopment('activate', input.generationId, (executable, arguments_) => {
			if (!rejected && arguments_.includes('is-active') && arguments_.includes('treeseed-sandbox-broker.service')) { rejected = true; throw new Error('broker unhealthy'); }
			commands.push(`${executable} ${arguments_.join(' ')}`);
		}, { host, systemd, network: { cni: resolve(fixture, 'cni/20-treeseed-sandboxes.conflist'), nft: resolve(fixture, 'sandbox/network.nft') } })).toThrow(/broker unhealthy/u);
		expect(hostDevelopmentStatus(host).status).toBe('rolled-back');
		expect(existsSync(resolve(systemd, 'treeseed-manager-api.service.d/90-treeseed-host-development.conf'))).toBe(false);
		expect(commands.some((entry) => entry.includes(`/generations/${input.generationId}/dist/src/bin/host-development-switch.js`))).toBe(true);
	});

	it('persists an imported guest digest in the active development generation', () => {
		const fixture = mkdtempSync(resolve(tmpdir(), 'treeseed-host-development-')); roots.push(fixture);
		mkdirSync(fixture, { recursive: true });
		writeFileSync(resolve(fixture, 'state.json'), `${JSON.stringify({
			schemaVersion: 'treeseed.host-development-generation/v1', generationId: 'dev-1788100000000-deadbeef', status: 'active',
			worktree: '/tmp/deployment', manifestDigest: digest, guestImageDigest: null, message: null, updatedAt: new Date().toISOString(),
		})}\n`);
		expect(recordHostDevelopmentGuestImage(digest, fixture).guestImageDigest).toBe(digest);
		expect(hostDevelopmentStatus(fixture).guestImageDigest).toBe(digest);
	});

	it('retains the imported guest digest when replacing an active development generation', () => {
		const fixture = mkdtempSync(resolve(tmpdir(), 'treeseed-host-development-')); roots.push(fixture);
		const worktree = resolve(fixture, 'deployment'), host = resolve(fixture, 'host'), systemd = resolve(fixture, 'systemd');
		mkdirSync(resolve(worktree, 'src/bin'), { recursive: true }); mkdirSync(resolve(worktree, 'dist/src/bin'), { recursive: true }); mkdirSync(host, { recursive: true });
		writeFileSync(resolve(worktree, 'src/bin/supervisor.ts'), 'source'); writeFileSync(resolve(worktree, 'package.json'), '{"type":"module"}');
		for (const name of ['api.js', 'sandbox-broker.js', 'supervisor.js', 'reconcile.js', 'host-development-switch.js']) writeFileSync(resolve(worktree, 'dist/src/bin', name), `export const name = '${name}';\n`);
		writeFileSync(resolve(host, 'state.json'), `${JSON.stringify({ schemaVersion: 'treeseed.host-development-generation/v1', generationId: 'dev-1788099999999-cafebabe', status: 'active', worktree, manifestDigest: digest, guestImageDigest: digest, message: null, updatedAt: new Date().toISOString() })}\n`);
		const exact = (path: string) => { const content = readFileSync(resolve(worktree, path)); return { path, size: content.byteLength, sha256: `sha256:${createHash('sha256').update(content).digest('hex')}` }; };
		const input = { generationId: 'dev-1788100000000-deadbeef', worktree, packageSha256: exact('package.json').sha256, files: ['package.json', 'dist/src/bin/api.js', 'dist/src/bin/sandbox-broker.js', 'dist/src/bin/supervisor.js', 'dist/src/bin/reconcile.js', 'dist/src/bin/host-development-switch.js'].map(exact) };
		activateHostDevelopment(input, () => undefined, { host, systemd });
		expect(hostDevelopmentStatus(host).guestImageDigest).toBe(digest);
	});
});
