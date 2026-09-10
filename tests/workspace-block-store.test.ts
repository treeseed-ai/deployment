import { describe, expect, it } from 'vitest';
import { attachWorkspaceDisk, createWorkspaceDisk, detachWorkspaceDisk, workspaceImagePath } from '../src/sandbox/workspace-block-store.js';
describe('workspace storage boundary', () => {
	it('only addresses canonical image IDs under managed encrypted storage', () => {
		expect(workspaceImagePath('a'.repeat(64))).toBe(`/var/lib/treeseed/agent/workspaces/images/${'a'.repeat(64)}.qcow2`);
		for (const id of ['../escape', 'file:///tmp/disk', 'a'.repeat(63)]) expect(() => workspaceImagePath(id)).toThrow('identity');
	});
	it('rejects invalid quotas before touching host resources', async () => {
		for (const size of [-1, 0, Number.NaN, Number.MAX_SAFE_INTEGER]) await expect(createWorkspaceDisk(null, size)).rejects.toThrow('quota');
	});
	it('rejects caller-selected paths and teardown without stopped-guest evidence', async () => {
		const disk = { id: 'unowned', directory: '/tmp/disk', image: '/tmp/image', device: '/dev/sda', unit: 'unrelated.service' };
		await expect(attachWorkspaceDisk(disk)).rejects.toThrow('custody');
		await expect(detachWorkspaceDisk(disk, false)).rejects.toThrow('stopped');
		await expect(detachWorkspaceDisk(disk, true)).rejects.toThrow('ownership');
	});
});
