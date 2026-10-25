import { openSync, closeSync, fstatSync, lstatSync, readSync, constants, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { valid } from 'semver';
import { PlatformSchemas } from '@treeseed-cordis/sdk';
import { ArchiveMetadata } from './artifacts.js';
import { SafeDirectory, PlanningFailure as Check } from './filesystem.js';
export interface PackageArchiveFile { readonly path: string; readonly sha256: string; readonly size: number; readonly mode: number; }
export interface PackageArchiveIndex { readonly metadata: Readonly<Record<string, unknown>>; readonly files: readonly PackageArchiveFile[]; }
class PinnedPackageArchive {
    private readonly fd: number; private readonly stat: Stats; readonly bytes: Buffer;
    constructor(private readonly directory: SafeDirectory, private readonly name: string, digest: string) {
        this.fd = openSync(directory.childPath(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            this.stat = fstatSync(this.fd); SafeDirectory.owner(this.stat, false); Check.require(this.stat.isFile() && this.stat.nlink === 1 && this.stat.size <= 64 * 1024 * 1024, 'INVALID_PACKAGE_ARCHIVE');
            this.bytes = Buffer.alloc(this.stat.size); let position = 0;
            while (position < this.bytes.length) { const count = readSync(this.fd, this.bytes, position, this.bytes.length - position, position); Check.require(count > 0, 'INVALID_PACKAGE_ARCHIVE'); position += count; }
            this.verify(); Check.require(createHash('sha256').update(this.bytes).digest('hex') === digest, 'INVALID_PACKAGE_ARCHIVE');
        } catch (error) { closeSync(this.fd); throw error; }
    }
    verify(): void { const current = fstatSync(this.fd), linked = lstatSync(this.directory.childPath(this.name)), before = this.stat; SafeDirectory.owner(current, false); Check.require(current.isFile() && current.nlink === 1 && current.dev === before.dev && current.ino === before.ino && current.size === before.size && current.mtimeMs === before.mtimeMs && current.ctimeMs === before.ctimeMs && !linked.isSymbolicLink() && linked.dev === before.dev && linked.ino === before.ino, 'INVALID_PACKAGE_ARCHIVE'); this.directory.verify(); }
    close(): void { closeSync(this.fd); }
}
/** Read-only artifact inspection shared by owner runtime/image auditors. No extraction or imports. */
export class PackageArchiveInspector {
    static async inspect(path: string, sha256: string): Promise<PackageArchiveIndex> {
        try {
            Check.require(path.startsWith('/') && resolve(path) === path && PlatformSchemas.digest.safeParse(sha256).success, 'INVALID_PACKAGE_ARCHIVE');
            const directory = SafeDirectory.open(dirname(path));
            try {
                const pinned = new PinnedPackageArchive(directory, basename(path), sha256);
                try {
                const reader = new ArchiveMetadata(pinned.bytes, false, { bytes: 64 * 1024 * 1024, entries: 8192, files: 4096, file: 8 * 1024 * 1024 }), metadata = await reader.read();
                Check.require(PlatformSchemas.packageName.safeParse(metadata.name).success && typeof metadata.version === 'string' && valid(metadata.version), 'INVALID_PACKAGE_ARCHIVE');
                const files: PackageArchiveFile[] = [];
                for (const path of [...reader.hashes.keys()].sort()) {
                    Check.require(path.startsWith('package/') && PlatformSchemas.relative.safeParse(path).success, 'INVALID_PACKAGE_ARCHIVE');
                    files.push(Object.freeze({ path: path.slice('package/'.length), sha256: reader.hashes.get(path)!, size: reader.sizes.get(path)!, mode: reader.modes.get(path)! }));
                }
                pinned.verify(); directory.verify(); return Object.freeze({ metadata: Object.freeze(metadata), files: Object.freeze(files) });
                } finally { pinned.close(); }
            } finally { directory.close(); }
        } catch { return Check.block('INVALID_PACKAGE_ARCHIVE'); }
    }
}
