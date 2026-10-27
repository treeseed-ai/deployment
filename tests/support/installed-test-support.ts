import {test,expect} from 'bun:test';
import {ComposeDeploymentHost} from '../../src/diagnose.js';
import {InstallationStore,PreparedProviderStager} from '../../src/installed.js';
import {PreparedReleaseFixture} from './release-fixture.js';
import {InstalledSchemas,InstalledDeclarations,PlatformSchemas,CanonicalJson,PlanningBlockedError,type InstalledPlan,type DeploymentPlan} from '@treeseed-cordis/sdk';
import {PlanStore} from '../../src/filesystem.js';
import {mkdirSync,readFileSync,statSync,existsSync,symlinkSync,writeFileSync,chmodSync,readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
export class InstalledTests {
 async fixture():Promise<{fixture:PreparedReleaseFixture;plan:InstalledPlan}>{const fixture=await new PreparedReleaseFixture().prepare(),hash='a'.repeat(64),services=[];for(const role of ['database','identity','api','edge'] as const)services.push({role,definition:{role,service:{user:'image-default',workerSocket:false,volumes:[],secrets:[],portTarget:null},slots:{},readiness:{kind:'http-json',path:'/ready',expected:{}}},provider:InstalledDeclarations.service(role,'container.'+role,['deployment.engine']),imageId:role,package:null,entry:null});const payload={formatVersion:2 as const,configuration:fixture.configuration,recipe:fixture.recipe,pluginBindings:[],composition:{profile:'first-installed',assetDigest:hash,worker:{path:'trsd',sha256:hash,size:1},services},configurationDigest:CanonicalJson.digest(fixture.configuration),releaseDigest:fixture.configuration.release.manifestDigest,recipeDigest:fixture.inventory.recipe.sha256,lockDigest:fixture.inventory.lockfile.sha256,expectedEngine:{context:'default',endpoint:'unix:///var/run/docker.sock',daemonId:'test-fixture',os:'linux',architecture:'amd64'},expectedComposition:null,projectName:'cordis-'+CanonicalJson.digest({installationId:fixture.configuration.installationId,installationDirectory:fixture.installation}).slice(0,16),artifacts:[],effects:[],blockers:[]};const digest=CanonicalJson.digest(payload);return {fixture,plan:InstalledSchemas.plan.parse({...payload,id:'plan-'+digest,digest})};}
 protected writable(path:string):void{const stat=lstatSync(path);if(stat.isSymbolicLink())return;if(stat.isDirectory()){chmodSync(path,0o700);for(const name of readdirSync(path))this.writable(join(path,name));}else chmodSync(path,0o600);}
}
