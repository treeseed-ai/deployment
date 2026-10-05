import { expect, it, vi } from 'vitest';

vi.mock('../src/manager/update-state.js', () => ({ runtimeStopped: () => true }));
vi.mock('../src/core/development-backup-hold.js', () => ({ assertDevelopmentNotHeld: () => undefined }));
const { resumeDevelopmentAtBoot } = await import('../src/supervisor/development-boot.js');

it('never schedules a development watcher while the host is intentionally stopped', () => {
	const command = vi.fn(() => { throw new Error('must not run'); });
	expect(resumeDevelopmentAtBoot('dev-accepted', command)).toEqual({ ready: true });
	expect(command).not.toHaveBeenCalled();
});
