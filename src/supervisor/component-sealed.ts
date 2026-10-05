import { execFileSync } from 'node:child_process';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import type { HostConfiguration } from '@treeseed/sdk/deployment';
import { componentCredential } from '../core/component-credential.js';

type Decrypt = (name: string, sealed: Buffer) => Buffer;
const decrypt: Decrypt = (name, sealed) => execFileSync('/usr/bin/systemd-creds',
	['decrypt', '--refuse-null', `--name=${name}`, '-', '-'],
	{ input: sealed, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 1_048_576 });

export function decodeComponentCredential(id: string, name: string, sealed: Buffer, unseal: Decrypt = decrypt) {
	let plaintext: Buffer | undefined;
	try {
		plaintext = unseal(name, sealed);
		if (!plaintext.length || plaintext.length > 1_048_576 || plaintext.includes(0)) throw new Error();
		return plaintext.toString('utf8');
	} catch { throw new Error(`OS credential ${id} is unavailable or unsafe.`); }
	finally { plaintext?.fill(0); }
}

/** No shell, environment fallback, or plaintext persistence. Errors never contain command output. */
export function readComponentCredential(host: HostConfiguration, id: string, declaredPath?: string, unseal: Decrypt = decrypt) {
	const secret = componentCredential(host, id, declaredPath);
	if (secret.provider === 'file') return readFileSync(secret.reference, 'utf8');
	let fd: number | undefined;
	try {
		fd = openSync(secret.reference, constants.O_RDONLY | constants.O_NOFOLLOW);
		const metadata = fstatSync(fd);
		if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077)
			|| metadata.size < 1 || metadata.size > 1_048_576) throw new Error();
		return decodeComponentCredential(id, secret.name, readFileSync(fd), unseal);
	} catch { throw new Error(`OS credential ${id} is unavailable or unsafe.`); }
	finally { if (fd !== undefined) closeSync(fd); }
}
