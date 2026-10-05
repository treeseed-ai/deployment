import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, createReadStream, createWriteStream, fstatSync, openSync, readSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { type Readable, type Writable } from 'node:stream';
import { Parser } from 'tar';
import type { BackupEntry } from './backup-coverage.js';

export const backupKeyId = 'application-backup-kek-v1';
const schemaVersion = 'treeseed.encrypted-backup/v1';
const canonical = (value: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));

export async function encryptBackupStream(source: Readable, path: string, generation: number, key: Buffer) {
	const nonce = randomBytes(12), header = { schemaVersion, algorithm: 'aes-256-gcm', keyId: backupKeyId, generation, nonce: nonce.toString('base64url'), createdAt: new Date().toISOString() };
	const cipher = createCipheriv('aes-256-gcm', key, nonce);
	cipher.setAAD(Buffer.from(canonical(header)));
	const destination = createWriteStream(path, { flags: 'wx', mode: 0o600 });
	destination.write(`${JSON.stringify(header)}\n`);
	await pipeline(source, cipher, destination);
	appendFileSync(path, cipher.getAuthTag());
}

export async function decryptBackupStream(path: string, generation: number, key: Buffer, destination: Writable) {
	const fd = openSync(path, 'r'), prefix = Buffer.alloc(4096), tag = Buffer.alloc(16);
	try {
		const count = readSync(fd, prefix, 0, prefix.length, 0), size = fstatSync(fd).size;
		const newline = prefix.subarray(0, count).indexOf(10);
		if (newline < 1) throw new Error('Encrypted backup header is missing.');
		const header = JSON.parse(prefix.subarray(0, newline).toString('utf8'));
		if (header.schemaVersion !== schemaVersion || header.algorithm !== 'aes-256-gcm' || header.keyId !== backupKeyId || header.generation !== generation) throw new Error('Encrypted backup identity is invalid.');
		const nonce = Buffer.from(String(header.nonce), 'base64url');
		if (nonce.length !== 12 || size <= newline + 17) throw new Error('Encrypted backup is truncated.');
		readSync(fd, tag, 0, 16, size - 16);
		const decipher = createDecipheriv('aes-256-gcm', key, nonce);
		decipher.setAAD(Buffer.from(canonical(header))); decipher.setAuthTag(tag);
		await pipeline(createReadStream(path, { fd, autoClose: false, start: newline + 1, end: size - 17 }), decipher, destination);
		return header;
	} finally { prefix.fill(0); tag.fill(0); closeSync(fd); }
}

export async function inspectBackupStream(path: string, generation: number, key: Buffer) {
	const documents: Record<string, unknown> = {}, entries: BackupEntry[] = [];
	const selected = new Set(['etc/treeseed/platform.json', 'var/lib/treeseed/manager/current-receipt.json', 'var/lib/treeseed/manager/active-components.json']);
	let failure: Error | undefined;
	const parser = new Parser({ strict: true, onReadEntry(entry) {
		if (entries.length >= 1_000_000) { failure = new Error('Backup inventory exceeds its bounded size.'); entry.resume(); return; }
		entries.push({ path: entry.path, type: entry.type, linkpath: entry.linkpath });
		if (!selected.has(entry.path)) { entry.resume(); return; }
		if (entry.type !== 'File' || entry.size > 16 * 1024 * 1024 || entry.path in documents) { failure = new Error('Backup metadata is invalid.'); entry.resume(); return; }
		const chunks: Buffer[] = []; let size = 0;
		entry.on('data', chunk => { size += chunk.length; if (size <= 16 * 1024 * 1024) chunks.push(Buffer.from(chunk)); else failure = new Error('Backup metadata exceeds its bounded size.'); });
		entry.on('end', () => { try { documents[entry.path] = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { failure = new Error('Backup metadata is invalid JSON.'); } });
	} });
	const envelope = await decryptBackupStream(path, generation, key, parser as unknown as Writable);
	if (failure) throw failure;
	if ([...selected].some(name => !(name in documents))) throw new Error('Backup metadata is incomplete.');
	return { envelope, entries, configuration: documents['etc/treeseed/platform.json'], receipt: documents['var/lib/treeseed/manager/current-receipt.json'], components: documents['var/lib/treeseed/manager/active-components.json'] };
}

/** Hash one bounded regular member, but authenticate/drain the complete archive. */
export async function archivedInputDigest(snapshot:string,generation:number,key:Buffer,member:string) {
	let count=0,size=0,invalid=false;
	const hash=createHash('sha256');
	const parser=new Parser({strict:true,onReadEntry(entry){
		if(entry.path!==member){entry.resume();return;}
		count++;
		if(entry.type!=='File' || entry.size>1048576 || count!==1){invalid=true;entry.resume();return;}
		entry.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1048576)invalid=true;else hash.update(chunk);});
	}});
	await decryptBackupStream(snapshot,generation,key,parser as unknown as Writable);
	if(invalid || count!==1) throw new Error('Exact persistent input missing from authenticated recovery archive');
	return hash.digest('hex');
}
