import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as Deployment from '@treeseed-cordis/deployment';
import { CanonicalJson, PlanningBlockedError, ServiceSchemas, type ServicePlan, type PluginRequestRecord, type PluginInstallRequest, type PluginPackageDescriptor } from '@treeseed-cordis/sdk';
import { GitRegistryFixture, type GitFixtureIdentity } from './git-source-fixture.js';
interface GitArchive {path:string;sha256:string;size:number;descriptor:PluginPackageDescriptor;}
interface GitRuntime {begin(source:string,key:string,target?:PluginInstallRequest['target']):PluginRequestRecord;resolve(record:PluginRequestRecord):Promise<PluginRequestRecord>;fetch(record:PluginRequestRecord):Promise<GitArchive>;close(timeout?:number):Promise<void>;}
class GitArchiveProgram {
    static async run(file:string):Promise<void>{
        const Runtime=Reflect.get(Deployment,'GitSourceRuntime') as {start(plan:ServicePlan):Promise<GitRuntime>};
        const input=JSON.parse(readFileSync(file,'utf8')) as {root:string;configuration:unknown;identity:GitFixtureIdentity},configuration=ServiceSchemas.configuration.parse(input.configuration),registry=new GitRegistryFixture(input.root,input.identity);let runtime:GitRuntime|undefined;
        await registry.listen();
        try{
            const path=join(configuration.release.directory,'release.json'),release=ServiceSchemas.release.parse(JSON.parse(readFileSync(path,'utf8'))),certificate=readFileSync(join(configuration.release.directory,'source-ca.pem'));
            release.acquisitionPolicy={formatVersion:1,helperReleaseIdentity:release.helpers!.releaseIdentity,npm:[],git:[{origin:registry.locator(),packages:['@fixture/git-source'],targets:['deployment'],certificateAuthority:{path:'source-ca.pem',sha256:createHash('sha256').update(certificate).digest('hex')}}],builds:[]};
            const bytes=CanonicalJson.stringify(release)+'\n';writeFileSync(path,bytes);configuration.release.manifestDigest=createHash('sha256').update(bytes).digest('hex');const plan=await new Deployment.ComposeDeploymentHost().plan(configuration);if(plan.formatVersion!==3)throw new Error('Wrong source plan format');
            runtime=await Runtime.start(plan);const locator=registry.locator()+'#main',record=await runtime.resolve(runtime.begin(locator,'git-archive'));
            registry.move();const archive=await runtime.fetch(record);if(archive.descriptor.package.name!=='@fixture/git-source'||archive.descriptor.package.version!=='1.0.0'||archive.descriptor.providers.length!==2)throw new Error('GIT_NATIVE_DESCRIPTOR_NOT_VERIFIED');
            if(createHash('sha256').update(readFileSync(archive.path)).digest('hex')!==archive.sha256)throw new Error('GIT_ARCHIVE_NOT_PINNED');
            const index=await Deployment.PackageArchiveInspector.inspect(archive.path,archive.sha256),files=new Map(index.files.map(GitArchiveProgram.entry));if(files.get('revision.txt')!==createHash('sha256').update('first exact commit\n').digest('hex'))throw new Error('GIT_ARCHIVE_FOLLOWED_MOVED_REF');
            await registry.close();await runtime.close();runtime=await Runtime.start(plan);const saved=await runtime.fetch(await runtime.resolve(runtime.begin(locator,'git-archive')));if(CanonicalJson.stringify(saved)!==CanonicalJson.stringify(archive))throw new Error('GIT_ARCHIVE_SOURCE_FREE_CHANGED');
            chmodSync(archive.path,0o600);writeFileSync(archive.path,'tampered fixture');chmodSync(archive.path,0o400);let refused=false;try{await runtime.fetch(record);}catch(error){refused=error instanceof PlanningBlockedError;}if(!refused)throw new Error('GIT_ARCHIVE_TAMPER_ACCEPTED');
            if(registry.authorization||existsSync(join(input.root,'MUST_NOT_RUN'))||existsSync(join(configuration.installationDirectory,'.cordis/credentials')))throw new Error('Git archive acquisition ran scripts or activated');
            process.stdout.write(JSON.stringify({fixtureOnly:true,native:true,exact:true,sourceFree:true,tamperRefused:true,noScripts:true,noActivation:true})+'\n');
        }finally{await runtime?.close(120000);await registry.close();}
    }
    private static entry(file:{path:string;sha256:string}):[string,string]{return[file.path,file.sha256];}
}
await GitArchiveProgram.run(process.argv[2]!);
