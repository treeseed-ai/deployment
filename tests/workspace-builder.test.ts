import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSourceWorkspace, sourceBuilderGitArgs } from '../src/sandbox/workspace-builder-guest.js';
import { workspaceGuestArguments } from '../src/sandbox/workspace-image-builder.js';

describe('source-only guest workspace builder', () => {
	it('runs each cold source guest as one pinned resource-bounded primary process without sleeping or readiness children', () => {
		const configuration = { runtime: 'io.containerd.kata.v2' as const, guestImages: [{ image: 'treeseed/sandbox-codex', digest: `sha256:${'a'.repeat(64)}` }] };
		const id = 'sandbox-warm-01234567-89ab-4cde-8fab-0123456789ab';
		const directory = '/var/lib/treeseed/agent/workspaces/leases/workspace-lease-01234567-89ab-4cde-8fab-0123456789ab';
		for (const [entry, readOnly, mode] of [['builder.mjs', false, 'build'], ['builder.mjs', true, 'verify'], ['verifier.mjs', true, undefined]] as const) {
			const input = { id, device: '/dev/nbd0', incoming: `${directory}/input`, outgoing: `${directory}/output`, entry, readOnly, ...(mode ? {mode} : {}) };
			const held = structuredClone(input), args = workspaceGuestArguments(configuration, input);
			const mount = entry === 'builder.mjs' ? '/run/treeseed-builder' : '/run/treeseed-verifier';
			expect(args).toEqual(['run', '--rm', '--null-io', '--runtime', configuration.runtime,
				'--label', 'io.kubernetes.cri.container-type=sandbox', '--cpus', '1',
				'--annotation', 'io.katacontainers.config.hypervisor.default_memory=1024', '--memory-limit', '1073741824',
				'--cap-drop', 'CAP_NET_RAW', '--cap-drop', 'CAP_NET_ADMIN', '--user', '65532:65532',
				'--mount', `type=bind,src=/dev/nbd0,dst=/workspace/project,options=${readOnly ? 'ro' : 'rw'}:nodev:nosuid`,
				'--mount', `type=bind,src=${input.incoming},dst=${mount},options=rbind:ro`,
				'--mount', `type=bind,src=${input.outgoing},dst=/run/treeseed-output,options=rbind:rw`,
				`docker.io/treeseed/sandbox-codex@${configuration.guestImages[0]!.digest}`, id, 'node', `${mount}/${entry}`, ...(mode ? [mode] : [])]);
			expect(args).not.toContain('--cni'); expect(args).not.toContain('--detach');
			expect(args).not.toContain('/bin/sleep'); expect(args).not.toContain(`${id}-ready`);
			expect(input).toEqual(held);
		}
	});
	it('denies malformed cold guest ownership device entry mode and write access before forming a native command', () => {
		const configuration = { runtime: 'io.containerd.kata.v2' as const, guestImages: [{ image: 'treeseed/sandbox-codex', digest: `sha256:${'a'.repeat(64)}` }] };
		const input = { id: 'sandbox-warm-01234567-89ab-4cde-8fab-0123456789ab', device: '/dev/nbd0',
			incoming: '/private/input', outgoing: '/private/output', entry: 'verifier.mjs' as const, readOnly: true };
		for (const fields of [{id: ''}, {id: 'foreign'}, {id: `${input.id}-candidate`}, {device: '/dev/sda'},
			{entry: '../verifier.mjs'}, {entry: ''}, {readOnly: false}, {readOnly: undefined}, {mode: 'build'}, {mode: 'unknown'}]) {
			const supplied = Object.assign({}, input, fields), held = structuredClone(supplied);
			expect(() => workspaceGuestArguments(configuration, supplied)).toThrow('guest'); expect(supplied).toEqual(held);
		}
		expect(() => workspaceGuestArguments({...configuration,guestImages:[]},input)).toThrow('guest');
	});
	it('disables background object mutation for builder and verifier commands', () => {
		for (const operation of [['fetch', 'source.bundle'], ['fsck', '--strict'], ['checkout', '--detach', 'HEAD']]) {
			const args = sourceBuilderGitArgs('/workspace/project', operation);
			for (const setting of ['maintenance.auto=false', 'gc.auto=0', 'gc.autoDetach=false']) {
				expect(args[args.indexOf(setting) - 1]).toBe('-c');
				expect(args.indexOf(setting)).toBeLessThan(args.indexOf('-C'));
			}
			expect(args.slice(-operation.length)).toEqual(operation);
		}
	});
	it('constructs exact Git source, preserves history across incremental bundles and rejects dirty parents', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'treeseed-source-builder-'));
		const source = join(directory, 'source'), target = join(directory, 'workspace'), bundle = join(directory, 'source.bundle');
		mkdirSync(source);
		const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', source, ...args], { encoding: 'utf8',
			env: { PATH: '/usr/bin:/bin', HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_AUTHOR_NAME: 'Workspace Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
				GIT_COMMITTER_NAME: 'Workspace Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
		try {
			git('init', '--quiet', '--initial-branch=treeseed-source');
			writeFileSync(join(source, 'code.ts'), 'export const revision = 1;\n'); git('add', 'code.ts'); git('commit', '--quiet', '-m', 'fixture source');
			const first = git('rev-parse', 'HEAD'); git('bundle', 'create', bundle, 'refs/heads/treeseed-source');
			expect((await buildSourceWorkspace({ root: target, bundle, commit: first, parentCommit: null })).clean).toBe(true);
			expect(readFileSync(join(target, 'code.ts'), 'utf8')).toContain('revision = 1');
			for (const [name, value] of [['gc.auto', '1'], ['gc.autoPackLimit', '1'], ['maintenance.auto', 'true']]) {
				execFileSync('/usr/bin/git', ['-C', target, 'config', name!, value!]);
			}
			writeFileSync(join(source, 'code.ts'), 'export const revision = 2;\n'); git('commit', '--quiet', '-am', 'fixture update');
			const second = git('rev-parse', 'HEAD'); git('bundle', 'create', bundle, 'refs/heads/treeseed-source', `^${first}`);
			expect((await buildSourceWorkspace({ root: target, bundle, commit: second, parentCommit: first })).commit).toBe(second);
			expect(execFileSync('/usr/bin/git', ['-C', target, 'rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim()).toBe(first);
			let latest = second;
			for (let revision = 3; revision <= 8; revision++) {
				writeFileSync(join(source, 'code.ts'), `export const revision = ${revision};\n`);
				git('commit', '--quiet', '-am', `fixture revision ${revision}`);
				const next = git('rev-parse', 'HEAD');
				git('bundle', 'create', bundle, 'refs/heads/treeseed-source', `^${latest}`);
				expect((await buildSourceWorkspace({ root: target, bundle, commit: next, parentCommit: latest })).commit).toBe(next);
				latest = next;
			}
			writeFileSync(join(target, 'unexpected.txt'), 'unpublished work');
			await expect(buildSourceWorkspace({ root: target, bundle, commit: latest, parentCommit: latest })).rejects.toThrow('not clean');
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
	it('keeps declared submodules unmaterialized without rejecting the parent source', async () => {
		const directory=mkdtempSync(join(tmpdir(),'treeseed-source-submodule-')),child=join(directory,'child'),source=join(directory,'source'),target=join(directory,'workspace'),bundle=join(directory,'source.bundle');
		const environment={PATH:'/usr/bin:/bin',HOME:directory,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Workspace Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Workspace Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
		const git=(root:string,...args:string[])=>execFileSync('/usr/bin/git',['-C',root,...args],{encoding:'utf8',env:environment,stdio:['ignore','pipe','pipe']}).trim();
		try{
			for(const root of [child,source]){mkdirSync(root);git(root,'init','--quiet','--initial-branch=treeseed-source');}
			writeFileSync(join(child,'fixture.ts'),'export const fixture = true;\n');git(child,'add','.');git(child,'commit','--quiet','-m','fixture');
			git(source,'-c','protocol.file.allow=always','submodule','add','--quiet',child,'.fixtures/fixture');git(source,'commit','--quiet','-m','source with fixture');
			const commit=git(source,'rev-parse','HEAD');git(source,'bundle','create',bundle,'refs/heads/treeseed-source');
			await expect(buildSourceWorkspace({root:target,bundle,commit,parentCommit:null})).resolves.toMatchObject({commit,clean:true,sourceOnly:true});
			expect(readdirSync(join(target,'.fixtures/fixture'))).toEqual([]);
		}finally{rmSync(directory,{recursive:true,force:true});}
	});
});
