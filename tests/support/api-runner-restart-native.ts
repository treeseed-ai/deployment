import assert from 'node:assert/strict';
import { chmodSync, chownSync, existsSync, lchownSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { deploymentDigest, postgresTopologySchema } from '@treeseed/sdk/deployment';
import { developmentRuntimeSchema } from '@treeseed/sdk/development';
import { apiIdentityFixture } from '../identity-api-fixture.js';
import { DevelopmentSessionStore } from '../../src/manager/development-sessions.js';
import { executeDevelopmentContainer } from '../../src/supervisor/development-container.js';
import { developmentRuntimeStatus } from '../../src/supervisor/development-runtime-copy.js';
import { supervisorConnectionHandler } from '../../src/supervisor/server.js';
import { requestSupervisor } from '../../src/supervisor/client.js';
import { paths } from '../../src/core/paths.js';

// The original supervisor and immutable copier run in a disposable filesystem.
// Docker transport observations are controlled; this does not claim live readiness.
assert.equal(process.env.TREESEED_HANDOFF_DISPOSABLE,'1');
const shape=process.argv[2]??'restart';
const sessionId='dev-api-restart-regression',source='/fixture/workspace/api';
const directory=`/run/treeseed/development-containers/${sessionId}/operations-runner`;
const make=(path:string,value:string)=>{mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path,value);};
make(`${source}/treeseed.package.yaml`,'id: api');mkdirSync(`${source}/.git`);
make(`${source}/package.json`,'{}');make(`${source}/dist/main.js`,'first-runtime');
mkdirSync(`${source}/node_modules`);mkdirSync(`${source}/drizzle`);
function own(path:string) {chownSync(path,1000,1000);for(const entry of readdirSync(path,{withFileTypes:true})) {
 const child=resolve(path,entry.name);if(entry.isDirectory())own(child);else lchownSync(child,1000,1000);
}}
own('/fixture');
const {configuration,release,descriptor}=apiIdentityFixture();
descriptor.applications=[];
descriptor.issuer='https://identity.treeseed.localhost/realms/treeseed';descriptor.resource='https://api.treeseed.localhost';
configuration.components.api!.aliases={'api.api.http':'api.treeseed.localhost'};
configuration.components.identity={...configuration.components.api!,aliases:{'identity.identity.https':'identity.treeseed.localhost'},configuration:{}};
configuration.components.postgres={...configuration.components.api!,aliases:{},configuration:{}};
for(const id of ['api-migration','api-runtime'])configuration.secrets[id]={provider:'systemd-credential',reference:`/etc/treeseed/credentials/${id}.cred`};
configuration.postgres=postgresTopologySchema.parse({schemaVersion:'treeseed.postgres-topology/v1',installationId:'test',environment:'production',
 servers:[{id:'shared',installationId:'test',environment:'production',mode:'shared',hostname:'postgres',port:5432,major:17,extensions:[],tls:{mode:'verify-full',trustReference:'postgres-ca'}}],
 requirements:[{id:'api',componentId:'api',enabled:true,supportedMajors:[17],extensions:[],runtimeConnectionLimit:10}],
 allocations:[{requirementId:'api',serverId:'shared',database:'api',ownerRole:'api_owner',migrationRole:'api_migrator',runtimeRole:'api_runtime',migrationCredentialReference:'api-migration',runtimeCredentialReference:'api-runtime',onDisable:'preserve'}]});
release.runtimeDigest=deploymentDigest(release.runtime);
make('/etc/treeseed/platform.json',JSON.stringify(configuration));
make('/var/lib/treeseed/manager/active-components.json',JSON.stringify([release]));
for(const path of ['/run/treeseed/openbao/client/identity.json','/run/treeseed/openbao/client/ca.pem',
 '/run/treeseed/component-credentials/api/credentials','/run/treeseed/component-credentials/api/diagnostics'])make(path,'disposable-fixture');
for(const path of ['/run/treeseed/postgres-clients/api/api/runtime/url','/run/treeseed/identity-clients/api/runtime.json']) {
 make(path,'disposable-fixture');chmodSync(path,0o400);chownSync(path,65532,65532);
}
const runtime=developmentRuntimeSchema.parse({schemaVersion:'treeseed.development-runtime/v2',project:{id:'api',repository:'treeseed-ai/api'},defaults:{restoreOnFailure:true},
 targets:[{id:'operations-runner',kind:'rebuild-restart',executionCustody:'manager',platforms:['linux-amd64'],sourceRoots:['dist'],
 operations:{start:{command:'manager-runtime',args:[],environment:{}}},ready:{kind:'process',graceSeconds:0},statePolicy:'shared-compatible',migrationPolicy:'explicit-review',
 shutdown:{graceSeconds:30,activeWorkPolicy:'block'},promotion:{liveAdmissible:false,candidateRequiresVerification:true}}]});
new DevelopmentSessionStore().save({session:{schemaVersion:'treeseed.development-session/v2',sessionId,actor:'fixture',hostId:'fixture',createdAt:new Date().toISOString(),status:'active',
 repositories:[{projectId:'api',repository:'treeseed-ai/api',worktree:source,commit:'a'.repeat(40),branch:'staging',dirty:false,dirtyDigest:null,recipeDigest:`sha256:${'a'.repeat(64)}`}],
 targets:[{projectId:'api',targetId:'operations-runner',mode:'candidate',generation:1,health:'ready'}],leases:[],restoredReceiptId:null,blockers:[]},runtimes:[runtime],routes:[],candidates:[]});
let running=false,starts=0,drains=0,releasedRunning=true,failing=false;
const image=`sha256:${'a'.repeat(64)}`;
const transport=(_exe:string,args:readonly string[])=>{
 if(args[0]==='image')return image;
 if(args[0]==='ps'&&args.includes('label=com.docker.compose.project=treeseed-api'))return 'fixture-vault';
 if(args[0]==='inspect'&&args[1]==='--format')return 'openbao\trunning\thealthy\tfixture-image';
 if(args[0]==='compose'&&args.includes('config'))return JSON.stringify({services:{openbao:{image:'fixture-image'}}});
 if(args[0]==='ps'&&args.includes('name=^/treeseed-api-operations-runner-1$'))return 'treeseed-api-operations-runner-1';
 if(args[0]==='ps')return running?`treeseed-${sessionId}-api-operations-runner`:'';
 if(args[0]==='inspect'&&args[1]==='treeseed-api-operations-runner-1')return JSON.stringify({Config:{User:'65532:65532',Labels:{'com.docker.compose.project':'treeseed-api','com.docker.compose.service':'operations-runner'}},State:{Running:releasedRunning}});
 if(args[0]==='inspect')return JSON.stringify({Config:{Labels:{'org.treeseed.development.session':failing&&shape==='foreign-owner'?'dev-foreign':sessionId,'org.treeseed.development.target':'api.operations-runner'}},State:{Running:running}});
 if(args[0]==='kill'){
  if(args.at(-1)==='treeseed-api-operations-runner-1')releasedRunning=false;
  else {running=false;drains++;}return '';
 }
 if(args[0]==='wait')return failing&&shape==='drain-failure'?'137':'0';
 if(args[0]==='start'){releasedRunning=true;return '';}
 if(args[0]==='compose'&&args.includes('logs'))return 'fixture startup failure';
 if(args[0]==='compose'&&args.includes('down')){
  if(failing&&shape==='cleanup-failure')throw new Error('fixture cleanup unavailable');
  running=false;return '';
 }
 if(args[0]==='compose'&&args.includes('up')) {
  assert.equal(running,false,'selection must follow successful drain');assert.equal(releasedRunning,false);
  if(failing&&(shape==='readiness-failure'||shape==='cleanup-failure'))throw new Error('fixture readiness unavailable');
  starts++;running=true;return '';
 }
 throw new Error(`Unexpected Docker fixture operation: ${args[0]}`);
};
const input={operation:'development.container' as const,sessionId,projectId:'api' as const,targetId:'operations-runner' as const,action:'start' as const};
assert.deepEqual(executeDevelopmentContainer(input,transport),{started:true});
const first=developmentRuntimeStatus(directory);
make(`${source}/dist/main.js`,'second-runtime');chownSync(`${source}/dist/main.js`,1000,1000);
if(['copy-failure','credential-failure','foreign-owner','drain-failure'].includes(shape)) {
 const names=['runtime/dist/main.js','runtime-receipt.json','compose.json','openbao/identity.json','keys/credentials'];
 const before=names.map(name=>readFileSync(`${directory}/${name}`));
 if(shape==='copy-failure')symlinkSync('/etc/hosts',`${source}/dist/escape`);
 if(shape==='credential-failure')rmSync('/run/treeseed/openbao/client/ca.pem');
 failing=true;
 assert.throws(()=>executeDevelopmentContainer(input,transport),shape==='copy-failure'?/escaped/:shape==='credential-failure'?/ENOENT/:shape==='foreign-owner'?/ownership/:/did not drain cleanly/);
 names.forEach((name,index)=>assert.deepEqual(readFileSync(`${directory}/${name}`),before[index]));
 assert.equal(developmentRuntimeStatus(directory).digest,first.digest);
 assert.equal(running,shape!=='drain-failure');assert.equal(starts,1);
 assert.equal(readdirSync(directory).some(name=>name.startsWith('prepare-')),false);
 failing=false;
 if(shape==='copy-failure')rmSync(`${source}/dist/escape`);
 if(shape==='credential-failure')make('/run/treeseed/openbao/client/ca.pem','disposable-fixture');
 assert.deepEqual(executeDevelopmentContainer(input,transport),{started:true});
 assert.equal(readFileSync(`${directory}/runtime/dist/main.js`,'utf8'),'second-runtime');
 console.log(JSON.stringify({shape,rejected:true,selectedBytesUnchanged:true,retryVerified:true}));
} else if(['readiness-failure','cleanup-failure','orphan-preparation','interrupted-before-spec'].includes(shape)) {
 make('/fixture/unrelated/retained','unrelated');
 if(shape==='interrupted-before-spec') {
  // A terminated supervisor can leave the durable handoff without a spec.
  running=false;rmSync(`${directory}/compose.json`);
  make(`${directory}/prepare-interrupted/runtime/partial`,'interrupted bytes');
 } else if(shape==='orphan-preparation')make(`${directory}/prepare-interrupted/runtime/partial`,'interrupted bytes');
 else {
  failing=true;assert.throws(()=>executeDevelopmentContainer(input,transport),/fixture readiness unavailable/);
  assert.equal(running,false);
  assert.equal(existsSync(directory),shape==='cleanup-failure');
  if(shape==='cleanup-failure')assert.equal(existsSync(`${directory}/released-runner.json`),true);
  else assert.equal(releasedRunning,true);
 }
 failing=false;
 assert.deepEqual(executeDevelopmentContainer({...input,action:'stop'},transport),{stopped:true});
 assert.equal(existsSync(directory),false);assert.equal(releasedRunning,true);
 assert.deepEqual(executeDevelopmentContainer(input,transport),{started:true});
 assert.equal(readFileSync(`${directory}/runtime/dist/main.js`,'utf8'),'second-runtime');
 assert.deepEqual(executeDevelopmentContainer({...input,action:'stop'},transport),{stopped:true});
 assert.equal(existsSync(directory),false);assert.equal(running,false);assert.equal(releasedRunning,true);
 assert.equal(readFileSync('/fixture/unrelated/retained','utf8'),'unrelated');
 console.log(JSON.stringify({shape,recovered:true,privateBytesVerified:true,teardownVerified:true}));
} else if(shape==='concurrent') {
 mkdirSync(resolve(paths.socket,'..'),{recursive:true});
 const server=createServer({allowHalfOpen:true},supervisorConnectionHandler(value=>executeDevelopmentContainer(value,transport),()=>undefined));
 server.listen(paths.socket);await once(server,'listening');
 try {
  assert.deepEqual(await Promise.all([requestSupervisor(input),requestSupervisor(input)]),[{started:true},{started:true}]);
  assert.equal(starts,3);assert.equal(drains,2);
  assert.equal(readFileSync(`${directory}/runtime/dist/main.js`,'utf8'),'second-runtime');
  assert.equal(readdirSync(directory).some(name=>name.startsWith('prepare-')),false);
  assert.deepEqual(await requestSupervisor({...input,action:'stop'}),{stopped:true});
  assert.equal(existsSync(directory),false);assert.equal(running,false);assert.equal(releasedRunning,true);
 } finally {await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));}
 console.log(JSON.stringify({concurrent:true,restarts:2,privateBytesVerified:true,teardownVerified:true}));
} else {
assert.deepEqual(executeDevelopmentContainer(input,transport),{started:true});
const second=developmentRuntimeStatus(directory);
assert.notEqual(first.digest,second.digest);
assert.equal(readFileSync(`${directory}/runtime/dist/main.js`,'utf8'),'second-runtime');
assert.equal(starts,2);assert.equal(drains,1);assert.equal(running,true);
assert.equal(existsSync(`${source}/dist/main.js`),true);
assert.equal(readdirSync(directory).some(name=>name.startsWith('prepare-')),false);
console.log(JSON.stringify({started:true,restarted:true,privateBytesVerified:true,priorProcessDrained:true}));
}
