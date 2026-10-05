const reasons = ['extension-owner', 'permission-denied', 'duplicate-object', 'unsupported-parameter', 'unsupported-archive', 'connection', 'timeout', 'unknown'] as const;
type Reason = typeof reasons[number];
/** Only fixed categories cross the operator boundary, never SQL or stderr. */
export class PostgresProcessFailure extends Error {
  constructor(readonly reason: Reason) { super('PostgreSQL transfer process failed; explicit containment required'); }
}
export function postgresProcessReason(error: unknown): Reason | undefined {
  return error instanceof PostgresProcessFailure ? error.reason : undefined;
}
export function classifyPostgresFailure(line: string): Reason | undefined {
  if (/must be owner of extension/u.test(line)) return 'extension-owner';
  if (/permission denied|must be owner of/u.test(line)) return 'permission-denied';
  if (/already exists|duplicate key/u.test(line)) return 'duplicate-object';
  if (/unrecognized configuration parameter/u.test(line)) return 'unsupported-parameter';
  if (/unsupported version.*file header/u.test(line)) return 'unsupported-archive';
  if (/connection.*failed|could not connect|server closed the connection/u.test(line)) return 'connection';
  if (/statement timeout/u.test(line)) return 'timeout';
  return undefined;
}
