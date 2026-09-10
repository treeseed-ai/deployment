import { spawn } from 'node:child_process';

type Selection = { container: string; database: string; username: string; intentDigest: string };
const identifier = /^[a-z][a-z0-9_]{0,62}$/u;

/** Fixed process transport for already-attested endpoints. The owning transfer
 * adapter must fence writers and revalidate installed custody before invoking
 * this internal module. No shell, supplied command, host address or password.
 */
function start(selection: Selection, mode: 'export' | 'restore', owner?: string) {
  if (process.getuid?.() !== 0 || !/^[a-f0-9]{64}$/u.test(selection.container) ||
    !identifier.test(selection.database) || !identifier.test(selection.username) ||
    !/^sha256:[a-f0-9]{64}$/u.test(selection.intentDigest) || (mode === 'restore' && (!owner || !identifier.test(owner) || owner === selection.username)))
    throw new Error('Attested PostgreSQL transfer process selection required');
  const applicationName = `trsd-transfer-${selection.intentDigest.slice(7, 55)}`;
  const args = mode === 'export'
    ? ['pg_dump', '--format=custom', '--no-tablespaces', '--no-password', '-h', '/var/run/postgresql', '-p', '5432', '-U', selection.username, '-d', selection.database]
    : ['pg_restore', '--no-owner', '--no-acl', '--no-tablespaces', '--exit-on-error', '--single-transaction', '--no-password',
      '-h', '/run/postgres/socket', '-p', '5432', '-U', selection.username, '-d', selection.database, `--role=${owner}`];
  const child = spawn('/usr/bin/docker', ['exec', '-i',
    '--env', `PGAPPNAME=${applicationName}`, '--env', 'PGPASSWORD=', '--env', 'PGPASSFILE=/dev/null',
    '--env', 'PGSERVICE=', '--env', 'PGSERVICEFILE=/dev/null',
    '--env', `PGOPTIONS=-c statement_timeout=600000${mode === 'export' ? ' -c default_transaction_read_only=on' : ''}`,
    selection.container, 'timeout', '-s', 'TERM', '-k', '5', '600', ...args], {
    stdio: ['pipe','pipe','pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
  });
  child.stderr.resume();
  child.stdin.on('error', () => undefined); child.stdout.on('error', () => undefined);
  if (mode === 'export') child.stdin.end(); else child.stdout.resume();
  let exceeded = false;
  const timer = setTimeout(() => { exceeded = true; child.kill('SIGKILL'); }, 615_000);
  const completed = new Promise<void>((resolve, reject) => {
    child.once('error', () => { clearTimeout(timer); reject(new Error('PostgreSQL transfer process unavailable')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (!exceeded && code === 0) resolve();
      else reject(new Error('PostgreSQL transfer process failed; explicit containment required'));
    });
  });
  void completed.catch(() => undefined);
  // Closing Docker's attach process does not prove the in-container process
  // exited. On failure the owner must terminate the exact applicationName
  // database sessions and verify containment, or retain recovery-required.
  const disconnect = () => { child.stdin.destroy(); child.stdout.destroy(); child.kill('SIGTERM'); };
  return { applicationName, output: child.stdout, input: child.stdin, completed, disconnect };
}

export function startPostgresExport(selection: Selection) { return start(selection, 'export'); }
export function startPostgresImport(selection: Selection & { owner: string }) { return start(selection, 'restore', selection.owner); }
