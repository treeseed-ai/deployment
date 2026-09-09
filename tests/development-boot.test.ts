import { describe, expect, it } from 'vitest';
import { captureBootCommand, developmentBootCommand } from '../src/supervisor/development-boot.js';
import type { ManagedDevelopmentSession } from '../src/manager/development-sessions.js';

describe('development boot process custody', () => {
	it('requests captured output rather than inheriting the service journal', () => {
		const runner = (_executable: string, _args: string[], input?: string) => input === '' ? 'loaded\n' : undefined;
		expect(captureBootCommand(runner, '/usr/bin/systemctl', ['show'])).toBe('loaded');
		expect(() => captureBootCommand(() => undefined, '/usr/bin/getent', ['passwd'])).toThrow('no captured output');
	});
	const record = { session: { sessionId: 'dev-example' } } as ManagedDevelopmentSession;
	it('executes only the installed worker under the non-root source owner', () => {
		const args = developmentBootCommand(record, { uid: 1001, gid: 1001, home: '/workspace/developer' });
		expect(args).toContain('--uid=1001');
		expect(args).toContain('--gid=1001');
		expect(args).toContain('--property=RemainAfterExit=yes');
		expect(args.slice(-3)).toEqual(['/usr/lib/treeseed/runtime/bin/node', '/usr/lib/treeseed/cli/dist/cli/development/boot-resume.js', 'dev-example']);
	});
	it('rejects root and malformed session or environment inputs', () => {
		expect(() => developmentBootCommand(record, { uid: 0, gid: 0, home: '/root' })).toThrow();
		expect(() => developmentBootCommand(record, { uid: 1001, gid: 1001, home: '/workspace/\nSECRET=bad' })).toThrow();
		expect(() => developmentBootCommand({ session: { sessionId: '--malicious' } } as ManagedDevelopmentSession, { uid: 1001, gid: 1001, home: '/workspace/user' })).toThrow();
	});
});
