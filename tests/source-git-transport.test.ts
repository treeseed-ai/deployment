import { afterEach, describe, expect, it, vi } from 'vitest';

const child = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', () => ({
	execFile: Object.assign(() => undefined, { [Symbol.for('nodejs.util.promisify.custom')]: child.execute }),
}));
import { runSourceGit } from '../src/sandbox/source-git-transport.js';
import { sourceFailureCode } from '../src/sandbox/source-diagnostics.js';

const generic = 'Authorized source Git operation failed. Check repository access, exact revision, storage capacity, and fetch timeout.';
afterEach(() => vi.resetAllMocks());

describe('bounded source Git failure classification', () => {
	it('retains the generic external category and exposes only a safe operation and observed child outcome', async () => {
		const secret = 'synthetic-secret-token';
		child.execute.mockRejectedValue(Object.assign(new Error(`private stderr https://invalid/${secret} /private/source.bundle`),
			{ code: 128, stdout: secret, stderr: secret, cmd: secret }));
		const error = await runSourceGit('/private/repository.git', ['bundle', 'unbundle', '/private/source.bundle'],
			{ username: 'fixture', token: secret }).catch((value: unknown) => value);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(generic);
		expect((error as Error).cause).toBe('source_git_bundle_unbundle_exit_128');
		expect(sourceFailureCode(error)).toBe('source_git_failed');
		expect(JSON.stringify(error)).not.toMatch(/synthetic-secret-token|private|https:|stderr|stdout|cmd/u);
		expect(child.execute.mock.calls[0]?.[2].env.TREESEED_SOURCE_GIT_HEADER).toBeUndefined();
	});
});
