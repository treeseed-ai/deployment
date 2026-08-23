import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { paths } from '../core/paths.js';

export type CertificateCommand = (executable: string, arguments_: readonly string[]) => void;
const run: CertificateCommand = (executable, arguments_) => { execFileSync(executable, [...arguments_], { stdio: 'inherit' }); };

export function generateEdgeCertificate(aliases: readonly string[], command: CertificateCommand = run) {
	if (aliases.length === 0 || aliases.some((alias) => !/^[a-z0-9.-]+\.localhost$/u.test(alias))) throw new Error('Edge certificates require accepted .localhost aliases.');
	const tls = `${paths.edge}/tls`, managerTls = paths.tls;
	mkdirSync(tls, { recursive: true, mode: 0o750 });
	const key = `${tls}/host.key.new`, request = `${tls}/host.csr.new`, certificate = `${tls}/host.crt.new`, extensions = `${tls}/host.ext.new`;
	writeFileSync(extensions, `subjectAltName=${[...new Set(aliases)].sort().map((alias) => `DNS:${alias}`).join(',')}\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
	command('/usr/bin/openssl', ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', key]);
	command('/usr/bin/openssl', ['req', '-new', '-key', key, '-subj', `/CN=${aliases[0]}`, '-out', request]);
	command('/usr/bin/openssl', ['x509', '-req', '-in', request, '-CA', `${managerTls}/ca.crt`, '-CAkey', `${managerTls}/ca.key`, '-CAcreateserial', '-days', '825', '-sha256', '-extfile', extensions, '-out', certificate]);
	for (const alias of aliases) command('/usr/bin/openssl', ['x509', '-in', certificate, '-noout', '-checkhost', alias]);
	renameSync(key, `${tls}/host.key`); renameSync(certificate, `${tls}/host.crt`);
	unlinkSync(request); unlinkSync(extensions);
	copyFileSync(`${managerTls}/ca.crt`, `${tls}/client-ca.crt`);
	for (const path of [`${tls}/host.key`, `${tls}/host.crt`, `${tls}/client-ca.crt`]) chmodSync(path, 0o640);
}
