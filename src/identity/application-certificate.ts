import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { OsSecretCustody } from '../security/custody/os.js';

/** The certificate must be stable across reconciliation. Only public metadata
 * is stored here; the corresponding private key stays in its original sealed
 * component reference. Drift/expiry require deliberate rotation, not overwrite.
 */
export function ensureApplicationCertificate(options: {
  stateRoot: string; environment: 'staging' | 'production'; clientId: string; privateKey: string;
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
      const certificate = execFileSync('/usr/bin/openssl', ['req', '-new', '-x509', '-key', '/dev/stdin',
        '-days', '365', '-subj', '/CN=treeseed-application'], { input: options.privateKey,
        stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10_000, maxBuffer: 16_384 });
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
