import fs, { type PathLike, type MakeDirectoryOptions, type Mode } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import * as Deployment from '@treeseed-cordis/deployment';
import { CanonicalJson, PlanningBlockedError, type ServicePlan, type PluginRequestRecord } from '@treeseed-cordis/sdk';
/** Inject one real foreign inode immediately before the actual publication syscall. */
class DirectoryRace {
    private readonly originalMkdir = fs.mkdirSync;
    private readonly originalRename = fs.renameSync;
    private identity: {
        dev: number;
        ino: number;
    } | undefined;
    constructor(private readonly destination: string) { }
    install(): void { fs.mkdirSync = this.mkdir.bind(this) as typeof fs.mkdirSync; fs.renameSync = this.rename.bind(this); syncBuiltinESMExports(); }
    restore(): void { fs.mkdirSync = this.originalMkdir; fs.renameSync = this.originalRename; syncBuiltinESMExports(); }
    private matches(path: PathLike): boolean { if (typeof path !== 'string' || basename(path) !== basename(this.destination))
        return false; return fs.realpathSync(dirname(path)) === dirname(this.destination); }
    private insert(path: PathLike): void { if (this.identity || !this.matches(path))
        return; this.originalMkdir(path, { mode: 0o700 }); const stat = fs.lstatSync(path); this.identity = { dev: stat.dev, ino: stat.ino }; }
    private mkdir(path: PathLike, options?: MakeDirectoryOptions | Mode | null): string | undefined { this.insert(path); return this.originalMkdir(path, options as MakeDirectoryOptions); }
    private rename(source: PathLike, target: PathLike): void { this.insert(target); this.originalRename(source, target); }
    preserved(): boolean { if (!this.identity)
        return false; const stat = fs.lstatSync(this.destination); return stat.dev === this.identity.dev && stat.ino === this.identity.ino && stat.isDirectory() && fs.readdirSync(this.destination).length === 0; }
    cleanup(): void { if (!this.preserved())
        throw new Error('FOREIGN_EMPTY_DIRECTORY_REPLACED'); fs.rmdirSync(this.destination); }
}
class CacheReservationProgram {
    private static snapshot(): string { const docker = new Deployment.DockerCommands(), values = []; for (const args of [['ps', '--all', '--format', '{{.ID}}'], ['network', 'ls', '--format', '{{.ID}}'], ['volume', 'ls', '--format', '{{.Name}}']]) {
        const value = docker.execute(args);
        if (value === null)
            throw new Error('Docker prerequisite missing');
        values.push(value.split('\n').sort());
    } return CanonicalJson.stringify(values); }
    static async run(file: string, mode: string): Promise<void> { const configuration = JSON.parse(fs.readFileSync(file, 'utf8')), before = this.snapshot(), plan = await new Deployment.ComposeDeploymentHost().plan(configuration); if (plan.formatVersion !== 3 || !plan.helpers)
        throw new Error('Wrong race fixture'); const store = new Deployment.ServicePlanStore(configuration.installationDirectory), writer = store.writer(); try {
        const registry = new Deployment.PluginRequestStore(plan, writer), initial = registry.begin({ source: '@fixture/cache-race@1.0.0', installationDirectory: configuration.installationDirectory, idempotencyKey: 'cache-race-' + mode, scope: 'installation', target: 'deployment', configuration: {} }, 'a'.repeat(64), null).record, request = registry.append({ ...initial, sequence: 1, stage: 'resolving' }), digest = mode === 'release' ? plan.releaseDigest : CanonicalJson.digest({ releaseIdentity: plan.helpers.releaseIdentity, helper: plan.helpers.helpers[0]! }), destination = join(configuration.installationDirectory, '.cordis/artifacts', mode === 'release' ? 'releases' : 'helpers', digest), race = new DirectoryRace(destination);
        let refused = false;
        race.install();
        try {
            if (mode === 'release') {
                const reader = await new Deployment.ManagedReleaseCache(plan).stage(writer, request);
                reader.close();
            }
            else if (mode === 'helper')
                await new Deployment.ManagedSourceTools(plan, writer, plan.helpers.releaseIdentity).path('bun', request);
            else
                throw new Error('Unknown race mode');
        }
        catch (error) {
            refused = error instanceof PlanningBlockedError;
        }
        finally {
            race.restore();
        }
        if (!race.preserved())
            throw new Error('FOREIGN_EMPTY_DIRECTORY_REPLACED');
        if (!refused)
            throw new Error('FOREIGN_EMPTY_DIRECTORY_NOT_REFUSED');
        race.cleanup();
        if (before !== this.snapshot() || store.current() !== null || fs.existsSync(configuration.installationDirectory + '/.cordis/credentials'))
            throw new Error('Cache race changed runtime');
        process.stdout.write(JSON.stringify({ fixture: true, mode, refused: true, foreignInodePreserved: true, noRuntimeEffects: true }) + '\n');
    }
    finally {
        writer.close();
    } }
}
await CacheReservationProgram.run(process.argv[2]!, process.argv[3]!);
