import { readFileSync, writeFileSync, existsSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as Deployment from '@treeseed-cordis/deployment';
import { CanonicalJson, PlanningBlockedError, ServiceSchemas, type ServicePlan, type PluginRequestRecord, type PluginPackageDescriptor } from '@treeseed-cordis/sdk';
import { GitRegistryFixture, type GitFixtureIdentity } from './git-source-fixture.js';
interface BuiltArchive {
    path: string;
    sha256: string;
    size: number;
    descriptor: PluginPackageDescriptor;
    tree: string;
    buildPolicyDigest: string;
}
interface Builder {
    build(record: PluginRequestRecord): Promise<BuiltArchive>;
    close(timeout?: number): Promise<void>;
}
/** Fixture-only fault in the actual Docker create command; all engine I/O remains genuine. */
class BuildIsolationFault {
    static readonly original = Deployment.LocalDockerCommands.prototype.run;
    static run(this: Deployment.LocalDockerCommands, engine: ServicePlan['expectedEngine'], args: string[], timeout?: number): Promise<string> { const changed = [...args]; if (changed[0] === 'container' && changed[1] === 'create') {
        const offset = changed.indexOf('--network=none');
        if (offset >= 0)
            changed[offset] = '--network=bridge';
    } return BuildIsolationFault.original.call(this, engine, changed, timeout); }
}
class GitBuildProgram {
    static resources(): string { const result = spawnSync('docker', ['ps', '--all', '--no-trunc', '--format', '{{.ID}}'], { encoding: 'utf8' }); if (result.status !== 0)
        throw new Error('Docker prerequisite missing'); return result.stdout.split('\n').sort().join('\n'); }
    static async run(file: string, mode = 'approved'): Promise<void> { const Runtime = Reflect.get(Deployment, 'PluginBuildRuntime') as {
        start(plan: ServicePlan): Promise<Builder>;
    } | undefined; if (!Runtime)
        throw new Error('NATIVE_PLUGIN_BUILD_UNAVAILABLE'); const input = JSON.parse(readFileSync(file, 'utf8')) as {
        root: string;
        configuration: unknown;
        identity: GitFixtureIdentity;
        build: {
            commit: string;
            entryDigest: string;
        };
        image: string;
    }, configuration = ServiceSchemas.configuration.parse(input.configuration), registry = new GitRegistryFixture(input.root, input.identity); let source: Deployment.GitSourceRuntime | undefined, builder: Builder | undefined; await registry.listen(); try {
        const path = join(configuration.release.directory, 'release.json'), release = ServiceSchemas.release.parse(JSON.parse(readFileSync(path, 'utf8'))), certificate = readFileSync(join(configuration.release.directory, 'source-ca.pem')), recipe = { origin: registry.locator(), commit: input.build.commit, entry: 'build.ts', entryDigest: mode === 'entry' ? '0'.repeat(64) : input.build.entryDigest, packageDirectory: 'out/package', image: input.image, helperReleaseIdentity: release.helpers!.releaseIdentity, network: 'none' as const, timeoutMs: mode === 'timeout' ? 1 : 30000 }, policy = { id: CanonicalJson.digest(recipe), ...recipe };
        release.acquisitionPolicy = { formatVersion: 1, helperReleaseIdentity: release.helpers!.releaseIdentity, npm: [], git: [{ origin: registry.locator(), packages: ['@fixture/git-source'], targets: ['deployment'], certificateAuthority: { path: 'source-ca.pem', sha256: createHash('sha256').update(certificate).digest('hex') }, ...(mode === 'missing' ? {} : { buildPolicyDigest: policy.id }) }], builds: mode === 'missing' ? [] : [policy] };
        const bytes = CanonicalJson.stringify(release) + '\n';
        writeFileSync(path, bytes);
        configuration.release.manifestDigest = createHash('sha256').update(bytes).digest('hex');
        const plan = await new Deployment.ComposeDeploymentHost().plan(configuration);
        if (plan.formatVersion !== 3)
            throw new Error('Wrong plan format');
        source = await Deployment.GitSourceRuntime.start(plan);
        const locator = registry.locator() + '#' + input.build.commit, record = await source.resolve(source.begin(locator, 'source-build'));
        if(mode==='closure'){const before=this.resources(),acquired=await source.acquire(record),receipt=acquired.sourceReceipt;if(acquired.stage!=='acquired'||receipt?.kind!=='git'||receipt.commit!==input.build.commit||receipt.buildPolicyDigest!==policy.id)throw new Error('BUILT_GIT_CLOSURE_NOT_ADMITTED');if(this.resources()!==before)throw new Error('BUILD_CLOSURE_RETAINED_CONTAINER');await registry.close();renameSync(configuration.release.directory,configuration.release.directory+'-offline');await source.close();source=await Deployment.GitSourceRuntime.start(plan);const offline=await source.acquire(await source.resolve(source.begin(locator,'source-build')));if(CanonicalJson.stringify(offline)!==CanonicalJson.stringify(acquired)||this.resources()!==before)throw new Error('BUILD_CLOSURE_REBUILT_OR_CHANGED');await source.close();source=undefined;builder=await Runtime.start(plan);const artifact=await builder.build(offline);await builder.close();builder=undefined;source=await Deployment.GitSourceRuntime.start(plan);chmodSync(artifact.path,0o600);writeFileSync(artifact.path,'tampered admitted build');chmodSync(artifact.path,0o400);let refused=false;try{await source.acquire(offline);}catch(error){if(error instanceof PlanningBlockedError)for(const blocker of error.blockers)if(blocker.code==='ARTIFACT_INTEGRITY')refused=true;}if(!refused||this.resources()!==before)throw new Error('BUILD_CLOSURE_TAMPER_ACCEPTED_OR_REBUILT');process.stdout.write(JSON.stringify({fixtureOnly:true,native:true,buildClosure:true,sourceFree:true,noActivation:true})+'\n');return;}
        await source.close();
        source = undefined;
        const before = this.resources();
        if (mode === 'isolation')
            Deployment.LocalDockerCommands.prototype.run = BuildIsolationFault.run;
        builder = await Runtime.start(plan);
        if (mode !== 'approved') {
            let refused = false;
            try {
                await builder.build(record);
            }
            catch (error) {
                if (mode === 'timeout')
                    refused = error instanceof Error && error.message === 'ENGINE_OPERATION_FAILED';
                else if (error instanceof PlanningBlockedError)
                    for (const blocker of error.blockers)
                        if (blocker.code === (mode === 'missing' ? 'BUILD_REQUIRED' : mode === 'isolation' ? 'BUILD_ISOLATION_REQUIRED' : 'BUILD_ENTRY_IDENTITY'))
                            refused = true;
            }
            if (!refused || this.resources() !== before)
                throw new Error('BUILD_REFUSAL_OR_CLEANUP_FAILED');
            process.stdout.write(JSON.stringify({ fixtureOnly: true, mode, refused: true, cleaned: true, noActivation: true }) + '\n');
            return;
        }
        const built = await builder.build(record);
        if (built.buildPolicyDigest !== policy.id || built.descriptor.package.name !== '@fixture/git-source' || built.descriptor.providers.length !== 2)
            throw new Error('EXACT_NATIVE_BUILD_NOT_VERIFIED');
        const index = await Deployment.PackageArchiveInspector.inspect(built.path, built.sha256);
        let proof = false;
        for (const entry of index.files)
            if (entry.path === 'built.txt' && entry.sha256 === createHash('sha256').update('genuine isolated TypeScript build').digest('hex'))
                proof = true;
        if (!proof)
            throw new Error('SOURCE_BUILD_NOT_OBSERVED');
        if (this.resources() !== before)
            throw new Error('BUILD_CONTAINER_NOT_REMOVED');
        await registry.close();
        await builder.close();
        builder = await Runtime.start(plan);
        const saved = await builder.build(record);
        if (CanonicalJson.stringify(saved) !== CanonicalJson.stringify(built) || this.resources() !== before)
            throw new Error('BUILD_SOURCE_FREE_CHANGED');
        chmodSync(built.path, 0o600);
        writeFileSync(built.path, 'tampered build');
        chmodSync(built.path, 0o400);
        let refused = false;
        try {
            await builder.build(record);
        }
        catch (error) {
            refused = error instanceof PlanningBlockedError;
        }
        if (!refused)
            throw new Error('BUILD_TAMPER_ACCEPTED');
        if (existsSync(join(input.root, 'MUST_NOT_RUN')) || existsSync(join(input.root, 'SCRIPT_CANARY')) || existsSync(join(configuration.installationDirectory, '.cordis/credentials')))
            throw new Error('BUILD_ESCAPED_OR_ACTIVATED');
        process.stdout.write(JSON.stringify({ fixtureOnly: true, native: true, isolated: true, built: true, sourceFree: true, tamperRefused: true, noActivation: true }) + '\n');
    }
    finally {
        Deployment.LocalDockerCommands.prototype.run = BuildIsolationFault.original;
        await source?.close(120000);
        await builder?.close(120000);
        await registry.close();
    } }
    static failed(error: unknown): never { if (error instanceof PlanningBlockedError) {
        const codes: string[] = [];
        for (const blocker of error.blockers)
            codes.push(blocker.code);
        process.stderr.write(codes.join(',') + '\n');
    } throw error; }
}
await GitBuildProgram.run(process.argv[2]!, process.argv[3] ?? 'approved').catch(GitBuildProgram.failed);
