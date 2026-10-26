import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as Deployment from '@treeseed-cordis/deployment';
import { CanonicalJson, PlanningBlockedError, ServiceSchemas, type ServicePlan, type PluginRequestRecord, type PluginInstallRequest } from '@treeseed-cordis/sdk';
import { GitRegistryFixture, type GitFixtureIdentity } from './git-source-fixture.js';
interface GitRuntime {
    begin(source:string,key:string,target?:PluginInstallRequest['target']):PluginRequestRecord;
    resolve(record:PluginRequestRecord):Promise<PluginRequestRecord>;
    close(timeout?:number):Promise<void>;
}
class GitSourceProgram {
    private static async blocked(runtime:GitRuntime,record:PluginRequestRecord,code:string):Promise<void>{try{await runtime.resolve(record);}catch(error){if(error instanceof PlanningBlockedError)for(const blocker of error.blockers)if(blocker.code===code)return;throw error;}throw new Error('GIT_SOURCE_ACCEPTED_BLOCKER:'+code);}
    static async run(file:string):Promise<void>{
        const Runtime=Reflect.get(Deployment,'GitSourceRuntime') as {start(plan:ServicePlan):Promise<GitRuntime>}|undefined;
        if(!Runtime)throw new Error('NATIVE_GIT_SOURCE_UNAVAILABLE');
        const input=JSON.parse(readFileSync(file,'utf8')) as {root:string;configuration:unknown;identity:GitFixtureIdentity},configuration=ServiceSchemas.configuration.parse(input.configuration),registry=new GitRegistryFixture(input.root,input.identity);let runtime:GitRuntime|undefined;
        await registry.listen();
        try{
            const path=join(configuration.release.directory,'release.json'),release=ServiceSchemas.release.parse(JSON.parse(readFileSync(path,'utf8'))),certificate=readFileSync(join(configuration.release.directory,'source-ca.pem'));
            release.acquisitionPolicy={formatVersion:1,helperReleaseIdentity:release.helpers!.releaseIdentity,npm:[],git:[{origin:registry.locator(),packages:['@fixture/git-source'],targets:['deployment'],certificateAuthority:{path:'source-ca.pem',sha256:createHash('sha256').update(certificate).digest('hex')}}],builds:[]};
            const bytes=CanonicalJson.stringify(release)+'\n';writeFileSync(path,bytes);configuration.release.manifestDigest=createHash('sha256').update(bytes).digest('hex');const plan=await new Deployment.ComposeDeploymentHost().plan(configuration);if(plan.formatVersion!==3)throw new Error('Wrong source plan format');
            runtime=await Runtime.start(plan);
            const locator=registry.locator()+'#main',first=await runtime.resolve(runtime.begin(locator,'git-first'));
            if(first.stage!=='resolved'||first.resolution?.kind!=='git'||first.resolution.commit!==input.identity.first||first.resolution.helperDigests.length!==2)throw new Error('EXACT_GIT_COMMIT_NOT_SAVED');
            registry.move();const count=registry.requests,repeated=await runtime.resolve(runtime.begin(locator,'git-first'));if(CanonicalJson.stringify(repeated)!==CanonicalJson.stringify(first)||registry.requests!==count)throw new Error('Accepted Git retry resolved moved source');
            const moved=await runtime.resolve(runtime.begin(locator,'git-moved'));if(moved.resolution?.kind!=='git'||moved.resolution.commit!==input.identity.second)throw new Error('New Git key failed to resolve moved ref');
            const tagged=await runtime.resolve(runtime.begin(registry.locator()+'#release','git-tag'));if(tagged.resolution?.kind!=='git'||tagged.resolution.commit!==input.identity.first)throw new Error('Annotated tag was not peeled to its commit');
            await this.blocked(runtime,runtime.begin(registry.locator()+'#twin','git-ambiguous'),'GIT_REF_AMBIGUOUS');
            const denied=registry.requests;await this.blocked(runtime,runtime.begin(locator,'git-target-denied','api'),'GIT_SOURCE_NOT_APPROVED');await this.blocked(runtime,runtime.begin('https://127.0.0.1:1/repository.git','git-origin-denied'),'GIT_SOURCE_NOT_APPROVED');if(registry.requests!==denied)throw new Error('Denied Git grant reached source');
            const explicit=await runtime.resolve(runtime.begin(registry.locator()+'#'+input.identity.first,'git-pinned'));if(explicit.resolution?.kind!=='git'||explicit.resolution.commit!==input.identity.first)throw new Error('Explicit Git commit changed');
            await this.blocked(runtime,runtime.begin(registry.locator()+'#missing-ref','git-missing'),'GIT_REF_NOT_FOUND');
            const trustRace=runtime.begin(locator,'git-trust-race');registry.tamperDirectory=CanonicalJson.digest({requestId:trustRace.requestId,intentDigest:trustRace.intentDigest,policyDigest:trustRace.policyDigest});await this.blocked(runtime,trustRace,'SOURCE_CA_CHANGED');if(registry.tamperDirectory!==null)throw new Error('Git trust race did not reach the held CA');
            registry.fail=true;const interrupted=runtime.begin(locator,'git-interrupted');let failed=false;try{await runtime.resolve(interrupted);}catch{failed=true;}if(!failed)throw new Error('Unavailable Git source unexpectedly resolved');const afterFailure=registry.requests;await this.blocked(runtime,interrupted,'GIT_SOURCE_RESOLUTION_UNCERTAIN');if(registry.requests!==afterFailure)throw new Error('Uncertain Git lookup retried');registry.fail=false;
            await registry.close();await runtime.close();runtime=await Runtime.start(plan);const offline=await runtime.resolve(runtime.begin(locator,'git-first'));if(CanonicalJson.stringify(offline)!==CanonicalJson.stringify(first))throw new Error('Stopped-owner Git resolution readback changed');
            if(registry.authorization||existsSync(join(input.root,'MUST_NOT_RUN'))||existsSync(join(configuration.installationDirectory,'.cordis/credentials')))throw new Error('Git resolution read credentials or activated services');
            process.stdout.write(JSON.stringify({fixtureOnly:true,native:true,exact:true,moved:true,sourceFree:true,ambiguous:true,denied:true,noActivation:true})+'\n');
        }finally{await runtime?.close(120000);await registry.close();}
    }
}
await GitSourceProgram.run(process.argv[2]!);
