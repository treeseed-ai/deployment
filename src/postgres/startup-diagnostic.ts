/** Categorize a bounded startup log without exporting paths, SQL, environment
 * values or arbitrary log text. Safe for operator receipts and CI evidence. */
export function postgresStartupDiagnostic(output: unknown) {
  if (typeof output !== 'string') return null;
  const text = output.slice(-65536);
  const patterns: Array<[string, RegExp]> = [
    ['tls-key-unavailable', /could not (?:load|open|access).*private key|key\.pem.*Permission denied/iu],
    ['tls-certificate-unavailable', /could not (?:load|open|access).*certificate/iu],
    ['data-version-incompatible', /database files are incompatible with server/iu],
    ['data-directory-not-empty', /directory .+ exists but is not empty/iu],
    ['data-directory-ownership', /data directory .+ has wrong ownership/iu],
    ['data-directory-permissions', /data directory .+ has invalid permissions/iu],
    ['configuration-unavailable', /could not (?:open|access).*configuration file|could not load pg_hba\.conf/iu],
    ['password-bootstrap-unavailable', /Database is uninitialized and superuser password is not specified|bootstrap-password.*Permission denied/iu],
    ['permission-denied', /Permission denied|Operation not permitted/iu],
    ['disk-full', /No space left on device/iu],
    ['read-only-filesystem', /Read-only file system/iu],
    ['locale-unavailable', /invalid locale name|locale .+ is not supported/iu],
    ['startup-fatal', /\b(?:FATAL|PANIC):/u],
  ];
  const codes = patterns.filter(([, pattern]) => pattern.test(text)).map(([code]) => code);
  return codes.length ? { code: 'postgres_startup_failed', reasons: codes } : null;
}
