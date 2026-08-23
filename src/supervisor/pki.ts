import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { CommandRunner } from './execute.js';
import { paths } from '../core/paths.js';

export interface ClientEnrollment { clientId: string; privateKey: string; certificate: string; certificateAuthority: string }

export function enrollClient(clientId: string, command: CommandRunner): ClientEnrollment {
	const directory = mkdtempSync('/run/treeseed/manager/enrollment-');
	const key = `${directory}/client.key`, request = `${directory}/client.csr`, certificate = `${directory}/client.crt`, extensions = `${directory}/client.ext`;
	try {
		writeFileSync(extensions, 'extendedKeyUsage=clientAuth\n', { mode: 0o600 });
		command('/usr/bin/openssl', ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', key]);
		command('/usr/bin/openssl', ['req', '-new', '-key', key, '-subj', `/CN=${clientId}`, '-out', request]);
		command('/usr/bin/openssl', ['x509', '-req', '-in', request, '-CA', `${paths.tls}/ca.crt`, '-CAkey', `${paths.tls}/ca.key`, '-CAcreateserial', '-days', '365', '-sha256', '-extfile', extensions, '-out', certificate]);
		return { clientId, privateKey: readFileSync(key, 'utf8'), certificate: readFileSync(certificate, 'utf8'), certificateAuthority: readFileSync(`${paths.tls}/ca.crt`, 'utf8') };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
