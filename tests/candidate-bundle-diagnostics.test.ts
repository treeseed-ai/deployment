import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { writeBoundedBundle } from '../src/sandbox/workspace-candidate-guest.js';

it('retains the exit code and at most 512 stderr bytes from a real failing Git process', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'candidate-bundle-diagnostic-'));
	try {
		const failure = await writeBoundedBundle(['x'.repeat(4096)], join(directory, 'failed.bundle'), 4096)
			.then(() => undefined, (error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		if (!(failure instanceof Error)) throw new Error('Git failure was discarded.');
		expect(failure.message).toBe(`Candidate bundle creation failed. Git exit code 1: git: '${'x'.repeat(506)}`);
	} finally { await rm(directory, { recursive: true, force: true }); }
});
