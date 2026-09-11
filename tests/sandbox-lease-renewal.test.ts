import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxLeaseRenewal } from '@treeseed/sdk/capacity-provider/sandbox';
import { KataSandboxRuntime } from '../src/sandbox/runtime.js';

const now = Date.parse('2026-09-11T16:00:00Z');
const time = (offset: number) => new Date(now + offset).toISOString();
function fixture() {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const sandbox = { assignment: { assignmentId: 'assignment', providerId: 'provider', teamId: 'team', leaseExpiresAt: time(480_000) } };
  const runtime = { authorized: vi.fn(() => sandbox) } as unknown as KataSandboxRuntime;
  const renewal = (expires: number, issued = 0) => ({ schemaVersion: 'treeseed.sandbox-lease-renewal/v1',
    sandboxId: 'sandbox', assignmentId: 'assignment', providerId: 'provider', teamId: 'team',
    leaseExpiresAt: time(expires), issuedAt: time(issued),
    signature: { keyId: 'test', algorithm: 'Ed25519', value: 'verified-at-server-boundary' },
  } as SandboxLeaseRenewal);
  const apply = (value: SandboxLeaseRenewal) => KataSandboxRuntime.prototype.renewLease.call(runtime, 'sandbox', 'host-token', value);
  return { sandbox, renewal, apply };
}
afterEach(() => vi.restoreAllMocks());
describe('deadline-bounded sandbox renewal', () => {
  it('accepts shorter and unchanged hard deadlines and exact replay', () => {
    const { sandbox, renewal, apply } = fixture();
    apply(renewal(300_000));
    apply(renewal(300_000, 10_000));
    apply(renewal(300_000, 10_000));
    expect(sandbox.assignment.leaseExpiresAt).toBe(time(300_000));
  });
  it('still accepts a fresh authorized extension', () => {
    const { sandbox, renewal, apply } = fixture();
    apply(renewal(500_000)); expect(sandbox.assignment.leaseExpiresAt).toBe(time(500_000));
  });
  it('rejects older or conflicting replay after shortening', () => {
    const { renewal, apply } = fixture(); apply(renewal(300_000, 10_000));
    expect(() => apply(renewal(480_000))).toThrow('replay');
    expect(() => apply(renewal(480_000, 10_000))).toThrow('replay');
  });
  it.each(['expired-current', 'expired-next', 'stale-issued', 'too-long', 'wrong-team'])('rejects %s', boundary => {
    const { sandbox, renewal, apply } = fixture(); const value = renewal(300_000);
    if (boundary === 'expired-current') sandbox.assignment.leaseExpiresAt = time(-1);
    if (boundary === 'expired-next') value.leaseExpiresAt = time(-1);
    if (boundary === 'stale-issued') value.issuedAt = time(-61_000);
    if (boundary === 'too-long') value.leaseExpiresAt = time(3_600_001);
    if (boundary === 'wrong-team') value.teamId = 'another-team';
    expect(() => apply(value)).toThrow();
  });
});
