import { afterEach, describe, expect, it, vi } from 'vitest';

const child = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', () => ({
	execFile: Object.assign(() => undefined, { [Symbol.for('nodejs.util.promisify.custom')]: child.execute }),
}));
import { runSourceGit, sourceGitFailureDetail } from '../src/sandbox/source-git-transport.js';
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

	it.each([
		[['init'], 'init'], [['fetch'], 'fetch'], [['push'], 'push'], [['fsck'], 'fsck'],
		[['rev-parse'], 'rev_parse'], [['update-ref'], 'update_ref'], [['for-each-ref'], 'for_each_ref'],
		[['ls-remote'], 'ls_remote'], [['bundle', 'create'], 'bundle_create'],
		[['bundle', 'verify'], 'bundle_verify'], [['bundle', 'unbundle'], 'bundle_unbundle'],
		[['-c', 'protocol.file.allow=always', 'fetch'], 'fetch'],
		[['-c', 'one=value', '-c', 'two=value', 'bundle', 'verify'], 'bundle_verify'],
		[['private-arbitrary-command'], 'unknown'], [['bundle', 'private-argument'], 'unknown'],
		[[], 'unknown'], [['-c'], 'unknown'],
	] as [string[], string][])('classifies only the fixed operation for %j', async (args, operation) => {
		child.execute.mockRejectedValue({ code: 128, stderr: 'secret' });
		const error = await runSourceGit('/private/repository.git', args).catch((value: unknown) => value);
		expect(sourceGitFailureDetail(error)).toBe(`source_git_${operation}_exit_128`);
	});

	it.each([
		[{ code: 1 }, 'exit_1'], [{ code: 255 }, 'exit_255'], [{ code: 0 }, 'failed'],
		[{ code: 256 }, 'failed'], [{ code: -1 }, 'failed'], [{ code: 1.5 }, 'failed'],
		...['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EROFS', 'EBUSY', 'ETIMEDOUT'].map(code => [{ code }, code.toLowerCase()]),
		...['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGPIPE'].map(signal => [{ signal }, `signal_${signal.toLowerCase()}`]),
		[{ code: 'private-code', signal: 'private-signal' }, 'failed'], [undefined, 'failed'], ['private-error', 'failed'],
	] as [unknown, string][])('reports the observed child outcome without inventing a cause: %j', async (failure, outcome) => {
		child.execute.mockRejectedValue(failure);
		const error = await runSourceGit('/private/repository.git', ['fetch']).catch((value: unknown) => value);
		expect(sourceGitFailureDetail(error)).toBe(`source_git_fetch_${outcome}`);
	});

	it('rejects malformed or untrusted diagnostic values and keeps successful output unchanged', async () => {
		for (const cause of ['', 'source_git_fetch_exit_0', 'source_git_fetch_exit_256',
			'source_git_private_exit_128', 'source_git_fetch_exit_128\nsecret', { stderr: 'secret' }]) {
			expect(sourceGitFailureDetail(new Error(generic, { cause }))).toBeUndefined();
		}
		expect(sourceGitFailureDetail(new Error('other error', { cause: 'source_git_fetch_exit_128' }))).toBeUndefined();
		expect(sourceGitFailureDetail({ message: generic, cause: 'source_git_fetch_exit_128' })).toBeUndefined();
		child.execute.mockResolvedValue({ stdout: 'exact-output\n', stderr: '' });
		expect(await runSourceGit('/private/repository.git', ['rev-parse', 'HEAD'])).toBe('exact-output');
	});
});
