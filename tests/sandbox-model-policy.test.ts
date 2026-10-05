import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostConfiguration } from '@treeseed/sdk/deployment';
import { describe, expect, it } from 'vitest';
import { reconcileSandboxModelPolicy } from '../src/supervisor/sandbox-model-policy.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';

const host = { security: { sandbox: { modelGateway: { provider: 'openai', upstreamBaseUrl: 'https://api.openai.com', allowedModels: ['test-model'] } } } } as HostConfiguration;
const broker = { socketPath: '/run/treeseed/sandbox/broker.sock', containerdAddress: '/run/containerd/containerd.sock', namespace: 'treeseed-sandboxes', runtime: 'io.containerd.kata.v2', stateRoot: '/var/lib/treeseed/sandboxes', trustedProvidersPath: '/etc/treeseed/sandbox/providers.json',
	relay: { listenHost: '10.89.0.1', port: 7443, publicUrl: 'https://10.89.0.1:7443', certificateFile: '/etc/treeseed/sandbox/relay.crt', privateKeyFile: '/run/credentials/relay-tls-key' }, guestImages: [{ image: 'treeseed/sandbox-codex', digest: `sha256:${'a'.repeat(64)}`, profiles: ['read'] }],
	modelGateway: { upstreamBaseUrl: 'https://api.openai.com', authenticationMode: 'codex-subscription', credentialFile: '/run/credentials/execution-provider-codex-auth', allowedProviders: ['openai'], allowedModels: ['old-model'] } };

describe('managed sandbox model policy', () => {
	it('updates policy without replacing credential custody or guest trust and repeats noop', () => {
		const directory = mkdtempSync(join(tmpdir(), 'treeseed-model-policy-')), path = join(directory, 'broker.json');
		const calls: unknown[] = [];
		try {
			writeFileSync(path, JSON.stringify(broker));
			expect(reconcileSandboxModelPolicy(host, (...args) => { calls.push(args); }, path)).toEqual({ changed: true, active: true });
			const next = JSON.parse(readFileSync(path, 'utf8'));
			expect(next).toEqual({ ...broker, modelGateway: { ...broker.modelGateway, allowedModels: ['test-model'] } });
			expect(calls).toEqual([['/usr/bin/systemctl', ['restart', 'treeseed-sandbox-broker.service']]]);
			expect(reconcileSandboxModelPolicy(host, (...args) => { calls.push(args); }, path)).toEqual({ changed: false, active: true });
			expect(calls).toHaveLength(1);
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
	it('does not enroll an absent credential gateway', () => {
		const directory = mkdtempSync(join(tmpdir(), 'treeseed-model-policy-')), path = join(directory, 'broker.json');
		const command = () => { throw new Error('No command expected'); };
		try {
			expect(reconcileSandboxModelPolicy(host, command, path)).toEqual({ changed: false, active: false });
			const { modelGateway: _gateway, ...unenrolled } = broker;
			writeFileSync(path, JSON.stringify(unenrolled));
			expect(reconcileSandboxModelPolicy(host, command, path)).toEqual({ changed: false, active: false });
			expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(unenrolled);
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
	it('exposes no caller-supplied path or credentials at the supervisor boundary', () => {
		expect(supervisorOperationSchema.parse({ operation: 'sandbox.model-policy.reconcile' })).toEqual({ operation: 'sandbox.model-policy.reconcile' });
		expect(() => supervisorOperationSchema.parse({ operation: 'sandbox.model-policy.reconcile', path: '/tmp/broker.json' })).toThrow();
	});
});
