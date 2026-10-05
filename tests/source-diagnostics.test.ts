import { expect, it } from 'vitest';
import { sourceFailureCode } from '../src/sandbox/source-diagnostics.js';
it('retains actionable fixed categories without reflecting child output or credentials', () => {
  expect(sourceFailureCode({ cmd: '/usr/bin/mount private-secret', code: 32, stderr: 'credential' })).toBe('source_cache_mount_exit_32');
  expect(sourceFailureCode({ code: 'EACCES', path: '/private-secret' })).toBe('source_preparation_eacces');
  expect(sourceFailureCode(new Error('Source acquisition is already owned or awaiting recovery.'))).toBe('source_cache_fenced');
  expect(sourceFailureCode({ message: 'secret', cmd: 'secret', code: 'secret' })).toBe('source_preparation_failed');
});
