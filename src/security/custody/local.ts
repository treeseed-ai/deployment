import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { constants, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { CustodyError, secretPath, validateSecretValues, validateVersion, type SecretRecord, type SecretScope } from './contracts.js';

/** The caller provisions an owner-only directory and supplies a key from OS custody.
 * No key files, environment fallback, default keys, or plaintext import are supported.
 * The directory must not be writable by another principal (including its ancestors).
 */
export class LocalSecretCustody {
	readonly #root: string;
	#key: Buffer | undefined;

	constructor(root: string) {
		if (!isAbsolute(root) || resolve(root) !== root) throw new CustodyError('invalid_directory');
		this.#root = root;
		this.#checkDirectory();
	}

	#checkDirectory(): void {
		try {
			if (realpathSync(this.#root) !== this.#root) throw new CustodyError('unsafe_directory');
			const stat = lstatSync(this.#root);
			if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.())
				throw new CustodyError('unsafe_directory');
			// Shared sticky temporary directories are safe parents for an owner-only root.
			for (let parent = dirname(this.#root); ; parent = dirname(parent)) {
				const ancestor = lstatSync(parent);
				if ((ancestor.mode & 0o022) && !(ancestor.mode & 0o1000)) throw new CustodyError('unsafe_directory');
				if (parent === dirname(parent)) break;
			}
		} catch { throw new CustodyError('unsafe_directory'); }
	}

	unlock(key: Uint8Array): void {
		if (key.byteLength !== 32) throw new CustodyError('invalid_key');
		this.lock();
		this.#key = Buffer.from(key);
	}

	lock(): void {
		this.#key?.fill(0);
		this.#key = undefined;
	}

	get locked(): boolean { return !this.#key; }

	#location(scope: SecretScope): { path: string; aad: Buffer } {
		if (!this.#key) throw new CustodyError('locked');
		this.#checkDirectory();
		const canonical = secretPath(scope);
		return { path: join(this.#root, `${createHash('sha256').update(canonical).digest('hex')}.enc`),
			aad: Buffer.from(`treeseed.local-secret/v1:${canonical}`) };
	}

	#read(path: string, aad: Buffer): SecretRecord | null {
		let fd: number;
		try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw new CustodyError('unsafe_record');
		}
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.uid !== process.getuid?.() || stat.size > 2 * 1024 * 1024)
				throw new CustodyError('unsafe_record');
			const encoded = readFileSync(fd);
			if (encoded.length < 29) throw new CustodyError('invalid_record');
			const decipher = createDecipheriv('aes-256-gcm', this.#key!, encoded.subarray(0, 12));
			decipher.setAAD(aad);
			decipher.setAuthTag(encoded.subarray(12, 28));
			const plaintext = Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]);
			try {
				const record: SecretRecord = JSON.parse(plaintext.toString('utf8'));
				validateVersion(record.version);
				if (!record.version) throw new CustodyError('invalid_record');
				validateSecretValues(record.values);
				return record;
			} finally { plaintext.fill(0); }
		} catch { throw new CustodyError('invalid_record'); }
		finally { closeSync(fd); }
	}

	read(scope: SecretScope): SecretRecord | null {
		const { path, aad } = this.#location(scope);
		return this.#read(path, aad);
	}

	write(scope: SecretScope, values: Record<string, string>, expectedVersion: number): number {
		validateSecretValues(values);
		validateVersion(expectedVersion);
		const { path, aad } = this.#location(scope), lock = `${path}.lock`;
		let lockFd: number;
		try { lockFd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
		catch { throw new CustodyError('record_busy'); }
		const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`;
		try {
			const current = this.#read(path, aad);
			if ((current?.version ?? 0) !== expectedVersion) throw new CustodyError('version_conflict');
			validateVersion(expectedVersion + 1);
			const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#key!, nonce);
			cipher.setAAD(aad);
			const plaintext = Buffer.from(JSON.stringify({ version: expectedVersion + 1, values }));
			let encrypted: Buffer;
			try { encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]); }
			finally { plaintext.fill(0); }
			const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			try { writeFileSync(fd, Buffer.concat([nonce, cipher.getAuthTag(), encrypted])); fsyncSync(fd); }
			finally { closeSync(fd); }
			renameSync(temporary, path);
			const directoryFd = openSync(this.#root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
			return expectedVersion + 1;
		} catch (error) {
			if (error instanceof CustodyError) throw error;
			throw new CustodyError('write_failed');
		} finally {
			closeSync(lockFd);
			if (existsSync(temporary)) unlinkSync(temporary);
			unlinkSync(lock);
		}
	}
}
