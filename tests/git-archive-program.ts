import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as Deployment from '@treeseed-cordis/deployment';
import { CanonicalJson, PlanningBlockedError, ServiceSchemas, type ServicePlan, type PluginRequestRecord, type PluginInstallRequest, type PluginPackageDescriptor } from '@treeseed-cordis/sdk';
import { RegistryFixture } from './source-registry-fixture.js';
import { GitRegistryFixture, type GitFixtureIdentity } from './git-source-fixture.js';
interface GitArchive {
    path: string;
    sha256: string;
    size: number;
    descriptor: PluginPackageDescriptor;
}
interface GitRuntime {
    begin(source: string, key: string, target?: PluginInstallRequest['target']): PluginRequestRecord;
    resolve(record: PluginRequestRecord): Promise<PluginRequestRecord>;
    fetch(record: PluginRequestRecord): Promise<GitArchive>;
    acquire(record:PluginRequestRecord):Promise<PluginRequestRecord>;
    close(timeout?: number): Promise<void>;
}
class GitArchiveProgram {
    private static async refused(runtime: GitRuntime, record: PluginRequestRecord, code: string): Promise<void> { try {
        await runtime.fetch(record);
    }
    catch (error) {
        if (error instanceof PlanningBlockedError)
            for (const blocker of error.blockers)
                if (blocker.code === code)
                    return;
        throw error;
    } throw new Error('GIT_ARCHIVE_ACCEPTED_BLOCKER:' + code); }
    static async run(file: string,mode='archive'): Promise<void> {
        const closure=mode.startsWith('closure');
        const Runtime = Reflect.get(Deployment, 'GitSourceRuntime') as {
            start(plan: ServicePlan): Promise<GitRuntime>;
        };
        const input = JSON.parse(readFileSync(file, 'utf8')) as {
            root: string;
            configuration: unknown;
            identity: GitFixtureIdentity;
        }, configuration = ServiceSchemas.configuration.parse(input.configuration), registry = new GitRegistryFixture(input.root, input.identity);
        let runtime: GitRuntime | undefined;let dependencies:RegistryFixture|undefined;
        await registry.listen();
        try {
            const path = join(configuration.release.directory, 'release.json'), release = ServiceSchemas.release.parse(JSON.parse(readFileSync(path, 'utf8'))), certificate = readFileSync(join(configuration.release.directory, 'source-ca.pem'));
            if(closure){dependencies=new RegistryFixture(input.root,configuration.installationDirectory);await dependencies.listen();}
            release.acquisitionPolicy = { formatVersion: 1, helperReleaseIdentity: release.helpers!.releaseIdentity, npm: dependencies?[{registry:dependencies.origin(),packages:[mode==='closure-denied'?'@fixture/forbidden':'@fixture/runtime'],targets:['deployment'],certificateAuthority:{path:'source-ca.pem',sha256:createHash('sha256').update(certificate).digest('hex')}}]:[], git: [{ origin: registry.locator(), packages: ['@fixture/git-source'], targets: ['deployment'], certificateAuthority: { path: 'source-ca.pem', sha256: createHash('sha256').update(certificate).digest('hex') } }], builds: [] };
            const bytes = CanonicalJson.stringify(release) + '\n';
            writeFileSync(path, bytes);
            configuration.release.manifestDigest = createHash('sha256').update(bytes).digest('hex');
            const plan = await new Deployment.ComposeDeploymentHost().plan(configuration);
            if (plan.formatVersion !== 3)
                throw new Error('Wrong source plan format');
            runtime = await Runtime.start(plan);
            const locator = registry.locator() + '#main', record = await runtime.resolve(runtime.begin(locator, 'git-archive'));
            registry.move();
            const archive = await runtime.fetch(record);
            if (archive.descriptor.package.name !== '@fixture/git-source' || archive.descriptor.package.version !== '1.0.0' || archive.descriptor.providers.length !== 2)
                throw new Error('GIT_NATIVE_DESCRIPTOR_NOT_VERIFIED');
            if (createHash('sha256').update(readFileSync(archive.path)).digest('hex') !== archive.sha256)
                throw new Error('GIT_ARCHIVE_NOT_PINNED');
            const index = await Deployment.PackageArchiveInspector.inspect(archive.path, archive.sha256), files = new Map(index.files.map(GitArchiveProgram.entry));
            if (files.get('revision.txt') !== createHash('sha256').update('first exact commit\n').digest('hex'))
                throw new Error('GIT_ARCHIVE_FOLLOWED_MOVED_REF');
            if(mode==='closure-denied'){let denied=false;try{await runtime.acquire(record);}catch(error){if(error instanceof PlanningBlockedError)for(const blocker of error.blockers)if(blocker.code==='NPM_SOURCE_NOT_APPROVED')denied=true;}if(!denied||dependencies!.requests!==0||dependencies!.archiveRequests!==0)throw new Error('GIT_CLOSURE_DEPENDENCY_GRANT_BYPASSED');process.stdout.write(JSON.stringify({fixtureOnly:true,dependencyDenied:true,noFetch:true,noActivation:true})+'\n');return;}
            if(closure){const acquired=await runtime.acquire(record),receipt=acquired.sourceReceipt;if(acquired.stage!=='acquired'||receipt?.kind!=='git'||receipt.commit!==input.identity.first||receipt.name!=='@fixture/git-source'||receipt.version!=='1.0.0'||receipt.archiveDigest!==archive.sha256||receipt.buildPolicyDigest!==null||receipt.helperDigests.length!==2)throw new Error('EXACT_GIT_CLOSURE_RECEIPT_MISSING');const root=join(configuration.installationDirectory,'.cordis/artifacts/closures',receipt.closureDigest),manifest=JSON.parse(readFileSync(join(root,'receipt.json'),'utf8')) as {manifest:{packages:Array<{name:string;version:string;path:string}>}};let found=false;for(const dependency of manifest.manifest.packages)if(dependency.name==='@fixture/runtime'&&dependency.version==='1.0.0')found=true;if(!found||dependencies!.archiveRequests!==1)throw new Error('GIT_RUNTIME_DEPENDENCY_NOT_VERIFIED');await registry.close();await dependencies!.close();await runtime.close();runtime=await Runtime.start(plan);const offline=await runtime.acquire(await runtime.resolve(runtime.begin(locator,'git-archive')));if(CanonicalJson.stringify(offline)!==CanonicalJson.stringify(acquired))throw new Error('GIT_CLOSURE_SOURCE_FREE_CHANGED');const dependency=manifest.manifest.packages.find(GitArchiveProgram.runtimeDependency);if(!dependency)throw new Error('MISSING_RUNTIME_FIXTURE');const dependencyPath=join(root,dependency.path);chmodSync(dependencyPath,0o600);writeFileSync(dependencyPath,'tampered dependency');chmodSync(dependencyPath,0o400);let tampered=false;try{await runtime.acquire(offline);}catch(error){if(error instanceof PlanningBlockedError)for(const blocker of error.blockers)if(blocker.code==='ARTIFACT_INTEGRITY')tampered=true;}if(!tampered)throw new Error('GIT_CLOSURE_TAMPER_ACCEPTED');if(existsSync(join(input.root,'MUST_NOT_RUN'))||existsSync(join(input.root,'SCRIPT_CANARY'))||existsSync(join(configuration.installationDirectory,'.cordis/credentials')))throw new Error('GIT_CLOSURE_EXECUTED_OR_ACTIVATED');process.stdout.write(JSON.stringify({fixtureOnly:true,native:true,exact:true,sourceFree:true,closure:true,dependency:true,noScripts:true,noActivation:true})+'\n');return;}
            for (const [ref, commit, code] of [['unsafe-symlink', input.identity.symlink, 'UNSUPPORTED_GIT_TREE'], ['unsafe-attributes', input.identity.attributes, 'UNSUPPORTED_GIT_ATTRIBUTES'], ['unsafe-size', input.identity.oversized, 'GIT_TREE_BUDGET']]) {
                const bad = await runtime.resolve(runtime.begin(registry.locator() + '#' + commit, 'git-' + ref));
                await this.refused(runtime, bad, code!);
                const before = registry.requests;
                await this.refused(runtime, bad, 'GIT_ARCHIVE_INCOMPLETE');
                if (registry.requests !== before)
                    throw new Error('Uncertain Git archive reacquired');
            }
            const linked = await runtime.resolve(runtime.begin(registry.locator() + '#' + input.identity.second, 'git-linked')), cache = join(configuration.installationDirectory, '.cordis/artifacts/git-packages'), key = CanonicalJson.digest({ formatVersion: 1, installationId: configuration.installationId, installationDirectory: configuration.installationDirectory, policyDigest: linked.policyDigest, resolution: linked.resolution });
            symlinkSync(input.root, join(cache, key));
            await this.refused(runtime, linked, 'UNSAFE_PATH');
            unlinkSync(join(cache, key));
            await registry.close();
            await runtime.close();
            runtime = await Runtime.start(plan);
            const saved = await runtime.fetch(await runtime.resolve(runtime.begin(locator, 'git-archive')));
            if (CanonicalJson.stringify(saved) !== CanonicalJson.stringify(archive))
                throw new Error('GIT_ARCHIVE_SOURCE_FREE_CHANGED');
            chmodSync(archive.path, 0o600);
            writeFileSync(archive.path, 'tampered fixture');
            chmodSync(archive.path, 0o400);
            let refused = false;
            try {
                await runtime.fetch(record);
            }
            catch (error) {
                refused = error instanceof PlanningBlockedError;
            }
            if (!refused)
                throw new Error('GIT_ARCHIVE_TAMPER_ACCEPTED');
            if (registry.authorization || existsSync(join(input.root, 'MUST_NOT_RUN')) || existsSync(join(input.root, 'SCRIPT_CANARY')) || existsSync(join(configuration.installationDirectory, '.cordis/credentials')))
                throw new Error('Git archive acquisition ran scripts or activated');
            await runtime.close();
            runtime = undefined;
            const store = new Deployment.ServicePlanStore(configuration.installationDirectory), writer = store.writer();
            try {
                const work = join(configuration.installationDirectory, '.cordis/artifacts/git-budget-fixture');
                mkdirSync(work, { mode: 0o700 });
                const tools = new Deployment.ManagedSourceTools(plan, writer, plan.helpers!.releaseIdentity);
                let bounded = false;
                try {
                    await tools.run('bun', ['--eval', "import{writeFileSync,truncateSync}from'node:fs';class BudgetCanary{static run(){writeFileSync('growing.bin','');truncateSync('growing.bin',64*1024*1024+1);setTimeout(BudgetCanary.wait,10000);}static wait(){writeFileSync('budget-completed','unexpected');}}BudgetCanary.run();"], work, record, true);
                }
                catch (error) {
                    if(error instanceof PlanningBlockedError)for(const blocker of error.blockers)if(blocker.code==='SOURCE_WORK_BUDGET')bounded=true;
                }
                if (!bounded || existsSync(join(work, 'budget-completed')))
                    throw new Error('GIT_WORK_BUDGET_NOT_ENFORCED');
            }
            finally {
                writer.close();
            }
            process.stdout.write(JSON.stringify({ fixtureOnly: true, native: true, exact: true, sourceFree: true, tamperRefused: true, noScripts: true, noActivation: true }) + '\n');
        }
        finally {
            await runtime?.close(120000);
            await registry.close();await dependencies?.close();
        }
    }
    private static runtimeDependency(value:{name:string}):boolean{return value.name==='@fixture/runtime';}
    static failed(error: unknown): never { if (error instanceof PlanningBlockedError) {
        const codes: string[] = [];
        for (const blocker of error.blockers)
            codes.push(blocker.code);
        process.stderr.write(codes.join(',') + '\n');
    } throw error; }
    private static entry(file: {
        path: string;
        sha256: string;
    }): [
        string,
        string
    ] { return [file.path, file.sha256]; }
}
await GitArchiveProgram.run(process.argv[2]!,process.argv[3]??'archive').catch(GitArchiveProgram.failed);
