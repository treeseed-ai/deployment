import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createAssignmentProxy } from '../src/sandbox/server.js';
import { sandboxBrokerConfigurationSchema } from '../src/sandbox/protocol.js';

describe('native assignment package proxy', () => {
	it('reads the real immutable release through guest authentication and denies foreign, missing and expired authority', async () => {
		const root = await mkdtemp(join(tmpdir(), 'treeseed-package-proxy-'));
		let ownedRuntime: import('../src/sandbox/runtime.js').KataSandboxRuntime | undefined;
		let ownedProxy: ReturnType<typeof createAssignmentProxy> | undefined;
		try {
			const digest = `sha256:${'a'.repeat(64)}`;
			const parsed = sandboxBrokerConfigurationSchema.parse({ socketPath: '/run/treeseed/sandbox/native-package-proxy.sock',
				containerdAddress: '/run/native-package-proxy-unused.sock', namespace: 'treeseed-sandboxes', runtime: 'io.containerd.kata.v2',
				stateRoot: '/var/lib/treeseed/sandboxes-native-package-proxy', trustedProvidersPath: '/etc/treeseed/sandbox/unused-providers.json',
				relay: { listenHost: '127.0.0.1', port: 7443, publicUrl: 'https://127.0.0.1:7443', certificateFile: '/etc/treeseed/sandbox/unused.crt', privateKeyFile: '/run/credentials/native-package-proxy-unused' },
				guestImages: [{ image: 'package-proxy-no-execution', digest, profiles: ['read'] }],
			});
			// Redirect only this preparation's persistence root; no VM, host config or provider credential is used.
			const configuration = { ...parsed, stateRoot: root };
			const runtimePath = join(process.cwd(), 'dist/src/sandbox/runtime.js');
			const { KataSandboxRuntime } = await import(runtimePath) as typeof import('../src/sandbox/runtime.js');
			const runtime = ownedRuntime = new KataSandboxRuntime(configuration), proxy = ownedProxy = createAssignmentProxy(runtime);
			await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
			const address = proxy.address(); if (!address || typeof address === 'string') throw new Error('Expected TCP proxy');
			const execute = promisify(execFile);
			const prepare = (allowedServices: string[], expiry: number) => runtime.prepare({ schemaVersion: 'treeseed.sandbox-assignment/v1',
				assignmentId: 'package-proxy-' + Math.random().toString(36).slice(2), attempt: 1, runnerId: 'native', providerId: 'native', teamId: 'native', projectId: 'native',
				profile: 'read', guestImage: 'package-proxy-no-execution', guestImageDigest: digest, identityManifestDigest: digest, contextManifestDigest: digest,
				resources: { cpuCores: 1, memoryBytes: 1_073_741_824, diskBytes: 67_108_864, durationSeconds: 30, processLimit: 64, outputBytes: 1_048_576 },
				inputs: [], outputs: [], network: { defaultDeny: true, relayUrl: configuration.relay.publicUrl, allowedServices },
				modelPolicy: { provider: 'openai', model: 'no-model-execution', capabilities: [] }, credentialHandles: [], treeDxHandleIds: [],
				leaseExpiresAt: new Date(expiry).toISOString(), signature: { keyId: 'native', algorithm: 'Ed25519', value: 'direct-owner-preparation-no-wire-authority' },
			});
			const url = 'https://github.com/treeseed-ai/api/releases/download/0.8.0-rc.113/component-release.json';
			const download = (sandboxId: string, token: string, target = url) => execute('/usr/bin/curl', ['--silent', '--show-error', '--fail', '--location', '--max-time', '20',
				'--proxy-anyauth', '--proxy', `http://${sandboxId}:${token}@127.0.0.1:${address.port}`, target],
				{ encoding: 'buffer', timeout: 25_000, maxBuffer: 1_048_576, env: { PATH: '/usr/bin:/bin', HOME: root } });
			const permitted = await prepare(['package-registry'], Date.now() + 60_000);
			const token = (await readFile(join(root, permitted.sandboxId, 'input/operation-token'), 'utf8')).trim();
			const received = await download(permitted.sandboxId, token);
			expect(createHash('sha256').update(received.stdout).digest('hex')).toBe('aa9713961069c0791d5f666c6b1bb3e033d15bcbe45802c6a16f84b7be1b49c5');
			await expect(download(permitted.sandboxId, 'foreign-token')).rejects.toThrow();
			await expect(download('unknown-sandbox', token)).rejects.toThrow();
			await expect(download(permitted.sandboxId, token, 'https://api.github.com/')).rejects.toThrow();
			await expect(download(permitted.sandboxId, token, 'https://github.com:444/')).rejects.toThrow();
			await expect(download(permitted.sandboxId, permitted.operationToken)).rejects.toThrow();
			const denied = await prepare([], Date.now() + 60_000);
			const deniedToken = (await readFile(join(root, denied.sandboxId, 'input/operation-token'), 'utf8')).trim();
			await expect(download(denied.sandboxId, deniedToken)).rejects.toThrow();
			const expiring = await prepare(['package-registry'], Date.now() + 100);
			const expiredToken = (await readFile(join(root, expiring.sandboxId, 'input/operation-token'), 'utf8')).trim();
			await new Promise(resolve => setTimeout(resolve, 120));
			await expect(download(expiring.sandboxId, expiredToken)).rejects.toThrow();
			expect(runtime.inspect(permitted.sandboxId, permitted.operationToken).running).toBe(false);
		} finally {
			ownedProxy?.closeAllConnections();
			if (ownedProxy?.listening) await new Promise<void>((resolve, reject) => ownedProxy!.close(error => error ? reject(error) : resolve()));
			await ownedRuntime?.drainWarmPool(); await rm(root, { recursive: true, force: true });
			await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
		}
	}, 30_000);
});
