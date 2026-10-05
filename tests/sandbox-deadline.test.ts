import { describe, expect, it } from 'vitest';
import { sandboxDeadline } from '../src/sandbox/runtime.js';

const at = (milliseconds: number) => new Date(milliseconds).toISOString();

describe('Kata assignment termination authority', () => {
	it('identifies the first limiting deadline without mistaking it for guest OOM', () => {
		const now = 1_800_000_000_000;
		expect(sandboxDeadline({ executionDeadline: now + 180_000, leaseExpiresAt: at(now + 75_000), sourceExpiresAt: at(now + 100_000) }, now))
			.toEqual({ reason: 'assignment_lease_expired', remainingMilliseconds: 75_000 });
		expect(sandboxDeadline({ executionDeadline: now + 180_000, leaseExpiresAt: at(now + 120_000), sourceExpiresAt: at(now + 60_000) }, now))
			.toEqual({ reason: 'source_authorization_expired', remainingMilliseconds: 60_000 });
		expect(sandboxDeadline({ executionDeadline: now + 180_000, leaseExpiresAt: at(now + 300_000) }, now))
			.toEqual({ reason: 'execution_deadline', remainingMilliseconds: 180_000 });
	});

	it('reads renewed lease and source authority without extending productive time', () => {
		const now = 1_800_000_000_000;
		const authority = { executionDeadline: now + 180_000, leaseExpiresAt: at(now + 75_000), sourceExpiresAt: at(now + 75_000) };
		expect(sandboxDeadline(authority, now + 74_000).remainingMilliseconds).toBe(1_000);
		authority.leaseExpiresAt = at(now + 300_000);
		authority.sourceExpiresAt = at(now + 300_000);
		expect(sandboxDeadline(authority, now + 75_000))
			.toEqual({ reason: 'execution_deadline', remainingMilliseconds: 105_000 });
	});

	it('fails closed on malformed authorization expiry', () => {
		const now = 1_800_000_000_000;
		expect(sandboxDeadline({ executionDeadline: now + 180_000, leaseExpiresAt: at(now + 300_000), sourceExpiresAt: 'invalid' }, now).reason)
			.toBe('source_authorization_expired');
	});
});
