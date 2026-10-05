import { expect, it } from 'vitest';
import { postgresPasswordVerifier } from '../src/postgres/activation.js';
import { postgresPasswordMatches } from '../src/postgres/runtime-state.js';

it('compares generated credentials without rotating their salted verifiers', () => {
  const password = 'a'.repeat(64), verifier = postgresPasswordVerifier(password);
  expect(postgresPasswordMatches(password, verifier)).toBe(true);
  expect(postgresPasswordMatches('b'.repeat(64), verifier)).toBe(false);
});
it.each([null, '', 'SCRAM-SHA-256$999999999:a$b:c', 'md5legacy', 'secret=must-not-throw'])('rejects malformed or unbounded verifiers without leaking them', verifier => {
  expect(postgresPasswordMatches('a'.repeat(64), verifier)).toBe(false);
});
