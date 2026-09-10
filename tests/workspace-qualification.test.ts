import { describe, expect, it } from 'vitest';
import { qualificationArguments } from '../src/sandbox/workspace-qualification.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';

describe('workspace block qualification boundary', () => {
	it('accepts only the fixed operator operation, never caller-selected host paths or guest commands', () => {
		expect(supervisorOperationSchema.safeParse({ operation: 'sandbox.workspace.qualify' }).success).toBe(true);
		for (const field of ['device', 'image', 'command', 'directory', 'credentials']) {
			expect(supervisorOperationSchema.safeParse({ operation: 'sandbox.workspace.qualify', [field]: '/untrusted' }).success).toBe(false);
		}
	});
	it('joins only the selected warm sandbox while retaining a per-execution source mount', () => {
		const args = qualificationArguments({ address: '/run/containerd/containerd.sock', namespace: 'treeseed-sandboxes',
			runtime: 'io.containerd.kata.v2', image: 'trusted@sha256:fixture', id: 'probe', device: '/dev/nbd0',
			input: '/fixture/input', output: '/fixture/output', readOnly: true, warmSandboxId: 'probe-warm' });
		expect(args).toContain('io.kubernetes.cri.container-type=container');
		expect(args).toContain('io.kubernetes.cri.sandbox-id=probe-warm');
		expect(supervisorOperationSchema.safeParse({ operation: 'sandbox.workspace.qualify', mode: 'reused' }).success).toBe(false);
	});
	it.each([true, false])('uses a block mount and separate credential-free, unprivileged guest for readOnly=%s', readOnly => {
		const args = qualificationArguments({ address: '/run/containerd/containerd.sock', namespace: 'treeseed-sandboxes',
			runtime: 'io.containerd.kata.v2', image: 'trusted@sha256:fixture', id: 'probe', device: '/dev/nbd0',
			input: '/fixture/input', output: '/fixture/output', readOnly });
		expect(args).toContain(`type=bind,src=/dev/nbd0,dst=/workspace/project,options=${readOnly ? 'ro' : 'rw'}:nodev:nosuid`);
		expect(args).toContain('--null-io'); expect(args).toContain('--rm'); expect(args).toContain('65532:65532');
		expect(args).not.toContain('--cni'); expect(args).not.toContain('--net-host');
		expect(args.at(-1)).toBe(readOnly ? 'read-only' : 'private-write');
	});
});
