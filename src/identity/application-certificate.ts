import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OsSecretCustody } from '../security/custody/os.js';

/** The certificate must be stable across reconciliation. Only public metadata
 * is stored here; the corresponding private key stays in its original sealed
 * component reference. Drift/expiry require deliberate rotation, not overwrite.
 */
export function ensureApplicationCertificate(options: {
  stateRoot: string; runtimeRoot?: string; environment: 'staging' | 'production'; clientId: string; privateKey: string;
}) {
  const key = createPrivateKey(options.privateKey);
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
    throw new Error('Invalid Identity application signing key');
  const fingerprint = createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('hex');
  const store = new OsSecretCustody(join(options.stateRoot, 'identity-os'), false);
  if (!store.initialized) throw new Error('Managed Identity bootstrap must exist before application enrollment');
  const scope = { team: 'host', project: 'identity', environment: options.environment, purpose: 'application-certificate',
    name: `app-${createHash('sha256').update(options.clientId).digest('hex').slice(0,48)}` };
  return store.run(custody => {
    let saved = custody.read(scope);
    if (!saved) {
      const runtime = options.runtimeRoot ?? '/run/treeseed/identity';
      const stat = lstatSync(runtime);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022))
        throw new Error('Unsafe Identity certificate runtime directory');
      const temporary = mkdtempSync(join(runtime, 'application-certificate-'));
      let certificate: string;
      try {
        // OpenSSL cannot reopen Node's socket-backed /dev/stdin as a key file.
        // Materialize only in private runtime storage and remove on every exit.
        const path = join(temporary, 'key.pem');
        writeFileSync(path, options.privateKey, { mode: 0o400, flag: 'wx' });
        certificate = execFileSync('/usr/bin/openssl', ['req', '-new', '-x509', '-key', path,
          '-days', '365', '-subj', '/CN=treeseed-application'], {
          stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10_000, maxBuffer: 16_384 });
      } catch { throw new Error('Identity application certificate creation failed'); }
      finally { rmSync(temporary, { recursive: true }); }
      custody.write(scope, { clientId: options.clientId, fingerprint, certificate }, 0);
      saved = custody.read(scope);
    }
    if (!saved || saved.values.clientId !== options.clientId || saved.values.fingerprint !== fingerprint)
      throw new Error('Identity application certificate drift requires a rotation plan');
    const certificate = new X509Certificate(saved.values.certificate!);
    if (!certificate.checkPrivateKey(key) || Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now())
      throw new Error('Identity application certificate renewal required');
    return certificate.raw.toString('base64');
  }, true);
}
