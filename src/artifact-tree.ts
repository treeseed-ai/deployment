import { open, type FileHandle } from 'node:fs/promises';
import { constants, fstatSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { InstallationStore } from './installed.js';
import { SafeDirectory, PlanningFailure as Check } from './filesystem.js';

export interface ArtifactFile {
    path: string;
    sha256: string;
    size: number;
    mode: 0o400 | 0o500;
}
/** Descriptor-anchored bounded copying; neither extraction nor package execution. */
export class ArtifactTree {
    static yield(done: (value: void) => void): void { setImmediate(done); }
    private static parent(root: SafeDirectory, path: string, create: boolean): { directory: SafeDirectory; name: string } {
        const parts = SafeDirectory.relative(path), name = parts.pop()!;
        Check.require(parts.length <= 32, 'PREPARED_TREE_LIMIT');
        let directory = root;
        try {
            for (const part of parts) {
                const child = create && !directory.entries().includes(part) ? InstallationStore.mkdir(directory, part) : directory.directory(part);
                if (directory !== root) directory.close();
                directory = child;
            }
            return { directory, name };
        } catch (error) { if (directory !== root) directory.close(); throw error; }
    }
    static async copy(source: SafeDirectory, destination: SafeDirectory, file: ArtifactFile): Promise<void> {
        const from = this.parent(source, file.path, false);
        let to: ReturnType<typeof ArtifactTree.parent> | undefined;
        let input: FileHandle | undefined, output: FileHandle | undefined;
        try {
            to = this.parent(destination, file.path, true);
            input = await open(from.directory.childPath(from.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const before = await input.stat();
            Check.require(before.isFile() && before.nlink === 1 && before.uid === process.getuid?.() && before.size === file.size && (before.mode & 0o777) === file.mode, 'PREPARED_SOURCE_IDENTITY');
            output = await open(to.directory.childPath(to.name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            const buffer = Buffer.alloc(1024 * 1024), hash = createHash('sha256');
            let position = 0;
            while (position < before.size) {
                const read = await input.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
                Check.require(read.bytesRead > 0, 'PREPARED_SOURCE_IDENTITY');
                const bytes = buffer.subarray(0, read.bytesRead);
                hash.update(bytes); await output.writeFile(bytes); position += read.bytesRead;
                await new Promise(this.yield);
            }
            const after = await input.stat(), linked = lstatSync(from.directory.childPath(from.name));
            Check.require(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && linked.dev === before.dev && linked.ino === before.ino && hash.digest('hex') === file.sha256, 'PREPARED_SOURCE_IDENTITY');
            from.directory.verify(); await output.chmod(file.mode); await output.sync(); to.directory.verify();
        } finally {
            await output?.close(); await input?.close();
            if (from.directory !== source) from.directory.close();
            if (to && to.directory !== destination) to.directory.close();
        }
    }
    static async seal(directory: SafeDirectory): Promise<void> {
        for (const name of directory.entries()) {
            const stat = lstatSync(directory.childPath(name));
            Check.require(!stat.isSymbolicLink() && stat.uid === process.getuid?.(), 'PREPARED_TREE_IDENTITY');
            if (stat.isDirectory()) { const child = directory.directory(name); try { await this.seal(child); } finally { child.close(); } }
            else Check.require(stat.isFile() && stat.nlink === 1 && [0o400, 0o500].includes(stat.mode & 0o777), 'PREPARED_TREE_PERMISSIONS');
        }
        const handle = await open('/proc/self/fd/' + directory.fd, constants.O_RDONLY | constants.O_DIRECTORY);
        try { await handle.chmod(0o500); await handle.sync(); } finally { await handle.close(); }
        directory.verify();
    }
    static async verify(directory: SafeDirectory, files: readonly ArtifactFile[], prefix = ''): Promise<void> {
        Check.require(fstatSync(directory.fd).uid === process.getuid?.() && (fstatSync(directory.fd).mode & 0o777) === 0o500, 'PREPARED_TREE_PERMISSIONS');
        const expected = new Map<string, ArtifactFile>(), children = new Set<string>();
        for (const file of files) { SafeDirectory.relative(file.path); Check.require(!expected.has(file.path), 'PREPARED_TREE_INVENTORY'); expected.set(file.path, file); if (file.path.startsWith(prefix)) children.add(file.path.slice(prefix.length).split('/')[0]!); }
        Check.require(directory.entries().join(',') === [...children].sort().join(','), 'PREPARED_TREE_INVENTORY');
        for (const name of directory.entries()) {
            const path = prefix + name, stat = lstatSync(directory.childPath(name));
            Check.require(!stat.isSymbolicLink() && stat.uid === process.getuid?.(), 'PREPARED_TREE_IDENTITY');
            if (stat.isDirectory()) { const child = directory.directory(name); try { await this.verify(child, files, path + '/'); } finally { child.close(); } continue; }
            const file = expected.get(path);
            Check.require(file && stat.isFile() && stat.nlink === 1 && stat.size === file.size && (stat.mode & 0o777) === file.mode, 'PREPARED_TREE_IDENTITY');
            const input = await open(directory.childPath(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const before = await input.stat(), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
                Check.require(before.dev === stat.dev && before.ino === stat.ino, 'PREPARED_TREE_IDENTITY');
                let position = 0;
                while (position < before.size) { const read = await input.read(buffer, 0, Math.min(buffer.length, before.size - position), position); Check.require(read.bytesRead > 0, 'PREPARED_TREE_IDENTITY'); hash.update(buffer.subarray(0, read.bytesRead)); position += read.bytesRead; await new Promise(this.yield); }
                const after = await input.stat(), linked = lstatSync(directory.childPath(name));
                Check.require(after.dev === before.dev && after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && linked.ino === before.ino && linked.dev === before.dev && hash.digest('hex') === file.sha256, 'PREPARED_TREE_IDENTITY');
            } finally { await input.close(); }
        }
        directory.verify();
    }
}
