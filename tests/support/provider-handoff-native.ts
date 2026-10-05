import { strict as assert } from 'node:assert';
import { chownSync, existsSync, lchownSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { component, host } from '../fixtures.js';
import { DevelopmentSessionStore } from '../../src/manager/development-sessions.js';
import { executeAgentDevelopmentContainer } from '../../src/supervisor/development-agent-container.js';
import { developmentRuntimeStatus } from '../../src/supervisor/development-runtime-copy.js';

// Runs only inside a disposable Docker filesystem, with no Docker socket or host state mount.
assert.equal(process.env.TREESEED_HANDOFF_DISPOSABLE, '1');
const shape = process.argv[2]!;
const sessionId = 'dev-handoff-regression';
const directory = `/run/treeseed/development-containers/${sessionId}/agent/provider`;
const source = '/fixture/workspace/agent';
const make = (path: string, value: string) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, value); };
make(`${source}/treeseed.package.yaml`, 'id: agent');
mkdirSync(`${source}/.git`, { recursive: true });
make(`${source}/dist/main.js`, 'new-runtime');
make(`${source}/.treeseed/docker/runtime/shared/package.json`, '{}');
mkdirSync(`${source}/.treeseed/docker/runtime/shared/node_modules`, { recursive: true });
if(shape==='copy-failure') symlinkSync('/etc/hosts', `${source}/dist/bad`);
const own = (path: string) => { chownSync(path, 1000, 1000); for (const entry of readdirSync(path, { withFileTypes: true })) { const child=resolve(path, entry.name); if(entry.isDirectory()) own(child); else lchownSync(child,1000,1000); } };
own('/fixture');
const configuration = host();
configuration.components.agent!.configuration = { files: { 'treeseed.capacity-provider.yaml': 'schemaVersion: 5\n' } };
make('/etc/treeseed/platform.json', JSON.stringify(configuration));
make('/etc/treeseed/sandbox/broker.json', JSON.stringify({socketPath:'/run/treeseed/sandbox/broker.sock',containerdAddress:'/run/containerd/containerd.sock',
  namespace:'treeseed-sandboxes',runtime:'io.containerd.kata.v2',stateRoot:'/var/lib/treeseed/sandboxes',trustedProvidersPath:'/etc/treeseed/sandbox/providers.json',
  relay:{listenHost:'127.0.0.1',port:8443,publicUrl:'https://fixture.invalid',certificateFile:'/etc/treeseed/sandbox/fixture.crt',privateKeyFile:'/run/credentials/fixture'},
  guestImages:[{image:'fixture',digest:`sha256:${'a'.repeat(64)}`,profiles:['fixture']}]}));
make('/var/lib/treeseed/manager/active-components.json', JSON.stringify([component('agent', 'development', 'a')]));
const now = new Date().toISOString();
new DevelopmentSessionStore().save({
  session: { schemaVersion:'treeseed.development-session/v2',sessionId,actor:'fixture',hostId:'fixture',createdAt:now,status:'active',
    repositories:[{projectId:'agent',repository:'treeseed-ai/agent',worktree:source,commit:'a'.repeat(40),branch:'staging',dirty:false,dirtyDigest:null,recipeDigest:`sha256:${'a'.repeat(64)}`}],
    targets:[{projectId:'agent',targetId:'provider',mode:'candidate',generation:1,health:'ready'}],leases:[],restoredReceiptId:null,blockers:[] },
  runtimes:[],routes:[],candidates:[],
});
const claims = '/var/lib/treeseed/components/agent/runtime/capacity-state.json';
const succeeds=['polling','empty','first-start'].includes(shape);
make(claims, shape==='malformed' ? 'not-json' : JSON.stringify({schemaVersion:1,claims:shape==='empty'||shape==='first-start'?[]:
  [{id:'fixture',status:shape==='copy-failure'||shape.includes('stop-')?'polling':shape==='bad-claim'?'unknown':shape}]}));
if(shape!=='first-start') {
make(`${directory}/runtime/dist/main.js`, 'old-runtime');
make(`${directory}/runtime-receipt.json`, 'original-receipt');
make(`${directory}/compose.json`, 'original-compose');
}
const before = shape==='first-start'?[]:['runtime/dist/main.js','runtime-receipt.json','compose.json'].map(name=>readFileSync(`${directory}/${name}`));
const states:Record<string,boolean>={manager:true,runner:true};
const commands:string[][]=[];
const transport=(_executable:string,args:readonly string[])=>{
  commands.push([...args]);
  const service=args[1]?.includes('manager')?'manager':'runner';
  if(args[0]==='inspect') return JSON.stringify({labels:{'com.docker.compose.project':'treeseed-agent','com.docker.compose.service':service},running:states[service],environment:[]});
  if(args[0]==='stop') {
    const stopped=args.at(-1)!.includes('manager')?'manager':'runner';
    if(shape==='runner-stop-failure'&&stopped==='runner') throw new Error('fixture runner stop denied');
    states[stopped]=false;
    if(shape===`${stopped}-stop-uncertain`) throw new Error(`fixture ${stopped} stop uncertain`);
    return '';
  }
  if(args[0]==='start') { states[service]=true; return ''; }
  if(args[0]==='compose'&&succeeds) {
    assert.deepEqual(states,{manager:false,runner:false},'no code selection before execution drain');
    assert.equal(readFileSync(`${directory}/runtime/dist/main.js`,'utf8'),'new-runtime');
    states.manager=true;states.runner=true;return '';
  }
  throw new Error(`Unexpected Docker transport command: ${args[0]}`);
};
let rejected=false, failure='', result:unknown;
try { result=executeAgentDevelopmentContainer({sessionId,projectId:'agent',targetId:'provider',action:'start'},transport); }
catch(error) { rejected=true; failure=String(error); }
if(succeeds) {
  assert.equal(rejected,false,failure);
  const runtime=developmentRuntimeStatus(directory,['dist','package.json','node_modules']);
  assert.deepEqual(result,{started:true,runtime});
  assert.deepEqual(states,{manager:true,runner:true});
  assert.equal(commands.filter(args=>args[0]==='compose').length,1);
  assert.deepEqual(readdirSync(directory).sort(),['compose.json','released-agent.json','runtime','runtime-receipt.json','treeseed.capacity-provider.yaml']);
  console.log(JSON.stringify({shape,started:true,runtimeCustodyVerified:true}));
} else {
assert.equal(rejected,true,'boundary must reject');
assert.match(failure,shape==='copy-failure'?/escaped/:shape==='malformed'?/JSON|Unexpected token/:shape.includes('stop-')?/fixture .* stop/:shape==='bad-claim'?/claim is invalid/:/cannot interrupt/);
for(const [index,name] of ['runtime/dist/main.js','runtime-receipt.json','compose.json'].entries()) {
  assert.equal(existsSync(`${directory}/${name}`),true,`selected file vanished: ${name}`);
  assert.deepEqual(readFileSync(`${directory}/${name}`),before[index],`selected bytes changed: ${name}`);
}
assert.deepEqual(states,{manager:true,runner:true},'rejected handoff must retain execution');
assert.equal(commands.some(args=>args[0]==='compose'),false);
assert.deepEqual(readdirSync(resolve(directory,'..')),['provider'],'no failed preparation residue');
assert.deepEqual(readdirSync(directory).sort(),['compose.json','runtime','runtime-receipt.json'],'no selected-directory preparation residue');
console.log(JSON.stringify({shape,rejected,selectedBytesUnchanged:true,executionUnchanged:true}));
}
