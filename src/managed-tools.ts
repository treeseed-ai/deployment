import {ManagedReleaseCache} from './release-cache.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, writeFileSync, fsyncSync, fchmodSync, chmodSync, lstatSync, readdirSync, constants } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { Parser, type ReadEntry } from 'tar';
import { CanonicalJson, ServiceSchemas, SourceToolSchemas, type ServicePlan, type SourceToolDefinition, type PluginRequestRecord } from '@treeseed-cordis/sdk';
import { ArchiveMetadata } from './artifacts.js';
import { ServicePlanStore } from './service-plan.js';
import { PluginRequestStore } from './plugin-registry.js';
import { InstallationStore, type InstallationWriter } from './installed.js';
import { SafeDirectory, PlanningFailure as Check } from './filesystem.js';
class HelperArchiveContents {
    private readonly parser: Parser;
    private readonly files = new Map<string, Buffer>();
    private accept: ((files: Map<string, Buffer>) => void) | undefined;
    private reject: ((error: Error) => void) | undefined;
    constructor(private readonly bytes: Buffer, private readonly helper: SourceToolDefinition) { this.parser = new Parser({ strict: true, maxMetaEntrySize: 1024 * 1024, maxDecompressionRatio: 1000, onReadEntry: this.entry.bind(this) }); }
    async read(): Promise<Map<string, Buffer>> { const inspector = new ArchiveMetadata(this.bytes, true, { bytes: 512 * 1024 * 1024, entries: 16384, files: 8192, file: 256 * 1024 * 1024 }); await inspector.read(); Check.require(inspector.hashes.size === this.helper.files.length, 'HELPER_INTEGRITY'); for (const file of this.helper.files)
        Check.require(file.path !== '.helper.json' && inspector.hashes.get(file.path) === file.sha256 && inspector.modes.get(file.path) === file.mode, 'HELPER_INTEGRITY'); for (const path of inspector.paths) {
        Check.require(path.split('/').every(SafeDirectory.segment), 'HELPER_INTEGRITY');
        let declared = false;
        for (const file of this.helper.files)
            if (file.path === path || file.path.startsWith(path + '/'))
                declared = true;
        Check.require(declared, 'HELPER_INTEGRITY');
    } return new Promise(this.start.bind(this)); }
    private start(accept: (files: Map<string, Buffer>) => void, reject: (error: Error) => void): void { this.accept = accept; this.reject = reject; this.parser.once('error', this.failed.bind(this)); this.parser.once('end', this.end.bind(this)); this.parser.end(this.bytes); }
    private entry(entry: ReadEntry): void { if (entry.type === 'Directory') {
        entry.resume();
        return;
    } new HelperArchiveFile(entry, this.files).read(); }
    private end(): void { try {
        Check.require(this.files.size === this.helper.files.length, 'HELPER_INTEGRITY');
        for (const file of this.helper.files)
            Check.require(createHash('sha256').update(this.files.get(file.path)!).digest('hex') === file.sha256, 'HELPER_INTEGRITY');
        this.accept!(this.files);
    }
    catch (error) {
        this.reject!(error as Error);
    } }
    private failed(): void { this.reject!(new Error('HELPER_ARCHIVE_FAILED')); }
}
class HelperArchiveFile {
    private readonly chunks: Buffer[] = [];
    constructor(private readonly entry: ReadEntry, private readonly files: Map<string, Buffer>) { }
    read(): void { this.entry.on('data', this.data.bind(this)); this.entry.once('end', this.end.bind(this)); }
    private data(bytes: Buffer): void { this.chunks.push(bytes); }
    private end(): void { this.files.set(this.entry.path, Buffer.concat(this.chunks)); }
}
/** A private helper work tree has a hard postcondition and a monitored in-flight disk budget. */
class SourceWorkBudget {
    static verify(directory:SafeDirectory,inFlight=false):void{const counts={bytes:0,entries:0};this.walk(directory,counts,inFlight);directory.verify();}
    private static walk(directory:SafeDirectory,counts:{bytes:number;entries:number},inFlight:boolean):void{for(const name of directory.entries()){
        let stat;try{stat=lstatSync(directory.childPath(name));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
        Check.require(++counts.entries<=8192&&!stat.isSymbolicLink()&&stat.uid===process.getuid?.(),'SOURCE_WORK_BUDGET');
        if(stat.isDirectory()){let child;try{child=directory.directory(name);}catch(error){if(!directory.entries().includes(name))continue;throw error;}try{this.walk(child,counts,inFlight);}finally{child.close();}}
        else{Check.require(stat.isFile()&&(inFlight||stat.nlink===1)&&stat.size<=64*1024*1024,'SOURCE_WORK_BUDGET');counts.bytes+=stat.size;Check.require(counts.bytes<=128*1024*1024,'SOURCE_WORK_BUDGET');}
    }}
}
class ManagedToolProcess {
    private child: ChildProcess | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private monitor: ReturnType<typeof setInterval> | undefined;
    private budgetFailure:Error|undefined;
    private failed = false;
    private count = 0;
    private chunks: Buffer[] = [];
    private accept: ((bytes: Buffer) => void) | undefined;
    private reject: ((error: Error) => void) | undefined;
    constructor(private readonly executable: string, private readonly args: string[], private readonly cwd: string, private readonly environment: Record<string, string>,private readonly budget?:SafeDirectory) { }
    run(): Promise<Buffer> { return new Promise(this.start.bind(this)); }
    private start(accept: (bytes: Buffer) => void, reject: (error: Error) => void): void { this.accept = accept; this.reject = reject; this.child = spawn(this.executable, this.args, { cwd: this.cwd, env: this.environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); this.child.stdout?.on('data', this.output.bind(this)); this.child.stderr?.on('data', this.stderr.bind(this)); this.child.once('error', this.fail.bind(this)); this.child.once('close', this.closed.bind(this)); this.timer = setTimeout(this.fail.bind(this), 120000);if(this.budget)this.monitor=setInterval(this.inspect.bind(this),25); }
    private inspect():void{try{SourceWorkBudget.verify(this.budget!,true);}catch(error){this.budgetFailure=error as Error;this.fail();}}
    private output(bytes: Buffer): void { this.count += bytes.length; if (this.count > 8 * 1024 * 1024) {
        this.fail();
        return;
    } if (!this.failed)
        this.chunks.push(bytes); }
    private stderr(bytes: Buffer): void { this.count += bytes.length; if (this.count > 8 * 1024 * 1024)
        this.fail(); }
    private fail(): void { this.failed = true; try {
        if (this.child?.pid)
            process.kill(-this.child.pid, 'SIGKILL');
    }
    catch {
        this.child?.kill('SIGKILL');
    } }
    private closed(code: number | null): void { clearTimeout(this.timer);clearInterval(this.monitor); if (this.child?.pid) {
        let live = false;
        try {
            process.kill(-this.child.pid, 0);
            live = true;
        }
        catch { }
        if (live)
            this.fail();
    } if(this.budgetFailure)this.reject!(this.budgetFailure);
    else if (this.failed || code !== 0)
        this.reject!(new Error('SOURCE_TOOL_FAILED'));
    else
        this.accept!(Buffer.concat(this.chunks)); }
}
/** Host-private source tooling; installed providers never receive its writer or capability. */
export class ManagedSourceTools {
    private readonly plan: ServicePlan;
    constructor(plan: ServicePlan, private readonly writer: InstallationWriter, private readonly approvedReleaseIdentity: string) { this.plan = ServiceSchemas.plan.parse(plan); Check.require(this.plan.helpers && this.plan.helpers.releaseIdentity === approvedReleaseIdentity, 'UNAPPROVED_HELPER_RELEASE'); SourceToolSchemas.helperInventory.parse(this.plan.helpers); Check.require(CanonicalJson.digest({ formatVersion: 1, helpers: this.plan.helpers.helpers }) === approvedReleaseIdentity, 'UNAPPROVED_HELPER_RELEASE'); this.writer.assert(this.plan.configuration.installationDirectory); }
    private authorize(request: PluginRequestRecord): void { this.writer.assert(this.plan.configuration.installationDirectory); let current: PluginRequestRecord | undefined; for (const record of new PluginRequestStore(this.plan, this.writer).records())
        if (record.requestId === request.requestId)
            current = record; Check.require(current && CanonicalJson.stringify(current) === CanonicalJson.stringify(request) && ['resolving', 'resolved'].includes(current.stage), 'ACCEPTED_ACQUISITION_REQUIRED'); }
    private helper(id: string): SourceToolDefinition { for (const helper of this.plan.helpers!.helpers)
        if (helper.id === id)
            return helper; return Check.block('SOURCE_HELPER_UNAVAILABLE'); }
    private identity(helper: SourceToolDefinition): {
        releaseIdentity: string;
        helper: SourceToolDefinition;
    } { return { releaseIdentity: this.approvedReleaseIdentity, helper }; }
    private verify(directory: SafeDirectory, helper: SourceToolDefinition): void { const expected = new Map<string, {
        sha256: string;
        mode: number;
    }>(); for (const file of helper.files)
        expected.set(file.path, file); const manifest = CanonicalJson.stringify(this.identity(helper)) + '\n'; expected.set('.helper.json', { sha256: createHash('sha256').update(manifest).digest('hex'), mode: 0o400 }); this.walk(directory, '', expected); Check.require(expected.size === 0, 'HELPER_INTEGRITY'); directory.verify(); }
    private walk(directory: SafeDirectory, prefix: string, expected: Map<string, {
        sha256: string;
        mode: number;
    }>): void { const stat = fstatSync(directory.fd); Check.require(stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o500, 'HELPER_PERMISSIONS'); for (const name of directory.entries()) {
        const path = prefix + name, stat = lstatSync(directory.childPath(name));
        Check.require(!stat.isSymbolicLink() && stat.uid === process.getuid?.(), 'HELPER_INTEGRITY');
        if (stat.isDirectory()) {
            let declared = false;
            for (const file of expected.keys())
                if (file.startsWith(path + '/'))
                    declared = true;
            Check.require(declared, 'HELPER_INTEGRITY');
            const child = directory.directory(name);
            try {
                this.walk(child, path + '/', expected);
            }
            finally {
                child.close();
            }
        }
        else {
            const file = expected.get(path);
            Check.require(file && stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === file.mode, 'HELPER_INTEGRITY');
            directory.hash(name, file.sha256);
            expected.delete(path);
        }
    } directory.verify(); }
    private immutable(directory: SafeDirectory): void { for (const name of directory.entries()) {
        const stat = lstatSync(directory.childPath(name));
        if (stat.isDirectory()) {
            const child = directory.directory(name);
            try {
                this.immutable(child);
            }
            finally {
                child.close();
            }
        }
    } chmodSync('/proc/self/fd/' + directory.fd, 0o500); fsyncSync(directory.fd); }
    private output(root: SafeDirectory, path: string, bytes: Buffer, mode: number): void { const parts = SafeDirectory.relative(path), name = parts.pop()!; let directory = root; try {
        for (const part of parts) {
            let child: SafeDirectory;
            if (directory.entries().includes(part))
                child = directory.directory(part, true);
            else
                child = InstallationStore.mkdir(directory, part);
            if (directory !== root)
                directory.close();
            directory = child;
        }
        const fd = openSync(directory.childPath(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
            writeFileSync(fd, bytes);
            fchmodSync(fd, mode);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        fsyncSync(directory.fd);
    }
    finally {
        if (directory !== root)
            directory.close();
    } }
    private reserve(directory: SafeDirectory, identity: string): SafeDirectory {
        try { return InstallationStore.mkdir(directory, identity); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') Check.block('HELPER_PUBLICATION_CONFLICT');
            throw error;
        }
    }
    private async prepare(id: string, request: PluginRequestRecord): Promise<{
        directory: SafeDirectory;
        helper: SourceToolDefinition;
    }> {
        this.authorize(request);
        const helper = this.helper(id), artifacts = new ServicePlanStore(this.plan.configuration.installationDirectory).directory('artifacts', this.writer);
        let cache: SafeDirectory | undefined;
        try {
            cache = artifacts.entries().includes('helpers') ? artifacts.directory('helpers', true) : InstallationStore.mkdir(artifacts, 'helpers');
            for (const name of cache.entries())
                Check.require(/^[a-f0-9]{64}$/.test(name), 'INCOMPLETE_HELPER_CACHE');
            const identity = CanonicalJson.digest(this.identity(helper));
            if (cache.entries().includes(identity)) {
                const directory = cache.directory(identity);
                try {
                    this.verify(directory, helper);
                    return { directory, helper };
                }
                catch (error) {
                    directory.close();
                    throw error;
                }
            }
            Check.require(helper.path, 'SOURCE_HELPER_UNAVAILABLE');
            const retained=new ManagedReleaseCache(this.plan).open();let bytes:Buffer;if(retained){try{bytes=retained.read(helper.path);}finally{retained.close();}}else{const release=SafeDirectory.open(this.plan.configuration.release.directory);try{bytes=release.file(helper.path,helper.sha256,512*1024*1024);}finally{release.close();}}Check.require(bytes.length===helper.size,'HELPER_INTEGRITY');
            const files = await new HelperArchiveContents(bytes, helper).read();
            this.authorize(request);
            const working = this.reserve(cache, identity);
            try {
                for (const file of helper.files)
                    this.output(working, file.path, files.get(file.path)!, file.mode);
                this.output(working, '.helper.json', Buffer.from(CanonicalJson.stringify(this.identity(helper)) + '\n'), 0o400);
                this.immutable(working);
                this.verify(working, helper);
                this.authorize(request);
                cache.verify();
                fsyncSync(cache.fd);
            }
            finally {
                working.close();
            }
            const directory = cache.directory(identity);
            try {
                this.verify(directory, helper);
                return { directory, helper };
            }
            catch (error) {
                directory.close();
                throw error;
            }
        }
        finally {
            cache?.close();
            artifacts.close();
        }
    }
    async path(id: string, request: PluginRequestRecord): Promise<string> { const selected = await this.prepare(id, request); try {
        return join(selected.directory.path, selected.helper.entry);
    }
    finally {
        selected.directory.close();
    } }
    async version(id: string, request: PluginRequestRecord): Promise<string> { this.authorize(request); const working = new ServicePlanStore(this.plan.configuration.installationDirectory).directory('artifacts', this.writer); try {
        return (await this.run(id, ['--version'], working.path, request)).toString('utf8').trim();
    }
    finally {
        working.close();
    } }
    async run(id: string, args: string[], cwd: string, request: PluginRequestRecord, boundedWork=false): Promise<Buffer> { Check.require(args.length > 0 && args.length <= 128, 'SOURCE_TOOL_ARGUMENTS'); for (const argument of args)
        Check.require(typeof argument === 'string' && argument.length <= 4096 && !argument.includes('\0'), 'SOURCE_TOOL_ARGUMENTS'); const selected = await this.prepare(id, request); let work: SafeDirectory | undefined; let parent: SafeDirectory | undefined; let fd: number | undefined; try {
        Check.require(resolve(cwd) === cwd && (cwd === join(this.plan.configuration.installationDirectory, '.cordis/artifacts') || cwd.startsWith(join(this.plan.configuration.installationDirectory, '.cordis/artifacts') + '/')), 'SOURCE_TOOL_DIRECTORY');
        work = SafeDirectory.open(cwd);
        SafeDirectory.owner(fstatSync(work.fd), true);
        const parts = SafeDirectory.relative(selected.helper.entry), name = parts.pop()!;
        parent = parts.length ? selected.directory.directory(parts.join('/')) : selected.directory;
        fd = openSync(parent.childPath(name), constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = fstatSync(fd);
        Check.require(before.isFile() && before.uid === process.getuid?.() && (before.mode & 0o777) === 0o500, 'HELPER_INTEGRITY');
        this.verify(selected.directory, selected.helper);
        this.authorize(request);
        const root = selected.directory.path, environment: Record<string, string> = { PATH: join(root, selected.helper.executableDirectory ?? dirname(selected.helper.entry)), HOME: work.path, XDG_CONFIG_HOME: work.path, BUN_INSTALL_CACHE_DIR: join(work.path, '.bun-cache'), NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_IGNORE_SCRIPTS: 'true', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
        if (selected.helper.executableDirectory)
            environment.GIT_EXEC_PATH = join(root, selected.helper.executableDirectory);
        if (selected.helper.libraryDirectories.length) {
            const paths = [];
            for (const path of selected.helper.libraryDirectories)
                paths.push(join(root, path));
            environment.LD_LIBRARY_PATH = paths.join(':');
        }
        const bytes = await new ManagedToolProcess('/proc/' + process.pid + '/fd/' + fd, args, '/proc/' + process.pid + '/fd/' + work.fd, environment,boundedWork?work:undefined).run();
        if(boundedWork)SourceWorkBudget.verify(work);
        this.authorize(request);
        const after = fstatSync(fd), linked = lstatSync(parent.childPath(name));
        Check.require(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && linked.dev === before.dev && linked.ino === before.ino, 'HELPER_INTEGRITY');
        this.verify(selected.directory, selected.helper);
        work.verify();
        return bytes;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
        if (parent && parent !== selected.directory)
            parent.close();
        work?.close();
        selected.directory.close();
    } }
}
