import { describe, expect, it, vi } from 'vitest';
import { KataSandboxRuntime } from '../src/sandbox/runtime.js';

function fixture() {
  const sandbox = { assignment: { network: { allowedServices: ['treedx-relay'] }, treeDxHandleIds: ['assigned-handle'],
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }, toolRequests: [] as Record<string, unknown>[], toolWaiters: new Map() };
  const runtime = { authorizedGuest: vi.fn(() => sandbox), authorized: vi.fn(() => sandbox), emit: vi.fn(async () => {}) };
  return { sandbox, runtime: runtime as unknown as KataSandboxRuntime };
}

describe('assignment review relay', () => {
  it.each(['treeseed_publish_review', 'treeseed_publish_proposal', 'treeseed_publish_execution_plan'])('forwards %s only through the authenticated guest queue and returns the host receipt', async tool => {
    const { sandbox, runtime } = fixture();
    const pending = KataSandboxRuntime.prototype.requestTreeDxTool.call(runtime, 'sandbox', 'guest-token', {
      tool, arguments: { kind: 'concern', title: 'Review', body: 'Evidence' },
    });
    await Promise.resolve();
    expect(sandbox.toolRequests).toHaveLength(1);
    const request = sandbox.toolRequests[0];
    if (!request) throw new Error('Expected queued review request');
    expect(request.tool).toBe(tool);
    await KataSandboxRuntime.prototype.completeToolRequest.call(runtime, 'sandbox', 'host-token', String(request.id), { result: { receiptId: 'verified' } });
    await expect(pending).resolves.toEqual({ receiptId: 'verified' });
    expect(sandbox.toolWaiters.size).toBe(0);
  });
  it('registers completion authority before the request becomes pollable', async () => {
    const { sandbox, runtime } = fixture();
    let releaseEvent!: () => void;
    const eventPersisted = new Promise<void>((resolve) => { releaseEvent = resolve; });
    (runtime as unknown as { emit: ReturnType<typeof vi.fn> }).emit.mockImplementationOnce(async () => eventPersisted);
    const pending = KataSandboxRuntime.prototype.requestTreeDxTool.call(runtime, 'sandbox', 'guest-token', {
      tool: 'treeseed_time_status', arguments: {},
    });
    await vi.waitFor(() => expect(sandbox.toolRequests).toHaveLength(1));
    const request = KataSandboxRuntime.prototype.nextToolRequest.call(runtime, 'sandbox', 'host-token').request;
    if (!request) throw new Error('Expected queued timing request');
    await expect(KataSandboxRuntime.prototype.completeToolRequest.call(runtime, 'sandbox', 'host-token', request.id,
      { result: { remainingSeconds: 30 } })).resolves.toEqual({ completed: true });
    releaseEvent();
    await expect(pending).resolves.toEqual({ remainingSeconds: 30 });
  });
  it.each(['expired', 'no-relay', 'no-handle', 'unknown-tool'])('denies %s without enqueuing', async boundary => {
    const { sandbox, runtime } = fixture();
    if (boundary === 'expired') sandbox.assignment.leaseExpiresAt = new Date(0).toISOString();
    if (boundary === 'no-relay') sandbox.assignment.network.allowedServices = [];
    if (boundary === 'no-handle') sandbox.assignment.treeDxHandleIds = [];
    await expect(KataSandboxRuntime.prototype.requestTreeDxTool.call(runtime, 'sandbox', 'guest-token', {
      tool: boundary === 'unknown-tool' ? 'arbitrary_admin_operation' : 'treeseed_publish_review', arguments: {},
    })).rejects.toThrow();
    expect(sandbox.toolRequests).toHaveLength(0);
  });
});
