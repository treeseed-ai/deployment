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
const sandbox = shape.startsWith('sandbox-');
const sessionId = 'dev-handoff-regression';
const directory = `/run/treeseed/development-containers/${sessionId}/agent/provider`;
const source = '/fixture/workspace/agent';
const make = (path: string, value: string) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, value); };
make(`${source}/treeseed.package.yaml`, 'id: agent');
mkdirSync(`${source}/.git`, { recursive: true });
make(`${source}/dist/main.js`, 'new-runtime');
make(`${source}/.treeseed/docker/runtime/shared/package.json`, '{}');
mkdirSync(`${source}/.treeseed/docker/runtime/shared/node_modules`, { recursive: true });
if (sandbox) {
  make(`${source}/Dockerfile`, 'FROM scratch'); make(`${source}/Dockerfile.sandbox-codex`, 'FROM scratch');
  make(`${source}/dist/sandbox/guest.js`, 'new-guest');
}
if(shape==='copy-failure') symlinkSync('/etc/hosts', `${source}/dist/bad`);
const own = (path: string) => { chownSync(path, 1000, 1000); for (const entry of readdirSync(path, { withFileTypes: true })) { const child=resolve(path, entry.name); if(entry.isDirectory()) own(child); else lchownSync(child,1000,1000); } };
own('/fixture');
const configuration = host();
configuration.components.agent!.configuration = { files: { 'treeseed.capacity-provider.yaml': 'schemaVersion: 5\n' } };
make('/etc/treeseed/platform.json', JSON.stringify(configuration));
make('/etc/treeseed/sandbox/broker.json', JSON.stringify({socketPath:'/run/treeseed/sandbox/broker.sock',containerdAddress:'/run/containerd/containerd.sock',
  namespace:'treeseed-sandboxes',runtime:'io.containerd.kata.v2',stateRoot:'/var/lib/treeseed/sandboxes',trustedProvidersPath:'/etc/treeseed/sandbox/providers.json',
  relay:{listenHost:'127.0.0.1',port:8443,publicUrl:'https://fixture.invalid',certificateFile:'/etc/treeseed/sandbox/fixture.crt',privateKeyFile:'/run/credentials/fixture'},
  guestImages:[{image:sandbox?'treeseed/sandbox-codex':'fixture',digest:`sha256:${'a'.repeat(64)}`,profiles:['fixture']}]}));
if (sandbox) make('/var/lib/treeseed/manager/host-development/state.json', JSON.stringify({schemaVersion:'treeseed.host-development-generation/v1',
  generationId:'dev-1788100000000-deadbeef',status:'active',worktree:source,manifestDigest:`sha256:${'a'.repeat(64)}`,
  guestImageDigest:shape==='sandbox-invalid-prior'?'invalid':`sha256:${'a'.repeat(64)}`,message:null,updatedAt:new Date().toISOString()}));
make('/var/lib/treeseed/manager/active-components.json', JSON.stringify([component('agent', 'development', 'a')]));
const now = new Date().toISOString();
new DevelopmentSessionStore().save({
  session: { schemaVersion:'treeseed.development-session/v2',sessionId,actor:'fixture',hostId:'fixture',createdAt:now,status:'active',
    repositories:[{projectId:'agent',repository:'treeseed-ai/agent',worktree:source,commit:'a'.repeat(40),branch:'staging',dirty:false,dirtyDigest:null,recipeDigest:`sha256:${'a'.repeat(64)}`}],
    targets:[{projectId:'agent',targetId:'provider',mode:'candidate',generation:1,health:'ready'},
      ...(sandbox?[{projectId:'agent',targetId:'sandbox',mode:'candidate' as const,generation:1,health:'ready' as const}]:[])],leases:[],restoredReceiptId:null,blockers:[] },
  runtimes:[],routes:[],candidates:[],
});
const claims = '/var/lib/treeseed/components/agent/runtime/capacity-state.json';
const succeeds=['polling','empty','first-start','closed-recovery','native-closed-recovery'].includes(shape);
make(claims, shape==='malformed' ? 'not-json' : JSON.stringify({schemaVersion:1,claims:shape==='empty'||shape==='first-start'?[]:
  [{id:'fixture',status:shape==='copy-failure'||shape.includes('stop-')?'polling':shape==='bad-claim'?'unknown':shape.includes('recovery')?'recovery':shape,
    ...(shape==='native-closed-recovery' ? {assignmentId:'native-assignment',activeStartedAt:new Date(Date.parse(now)-1000).toISOString(),activeFinishedAt:now,accountedThrough:now,
      dispatchEnvelope:{assignment:{assignmentAttempt:{id:'native-assignment',workspace:{mode:'treedx'}}}},
      closeoutOutput:{assignmentResult:{assignmentId:'native-assignment',status:'completed',completedAt:new Date(Date.parse(now)-10).toISOString()},
        teardown:{verified:true,completedAt:new Date(Date.parse(now)-10).toISOString()},artifacts:[]}} : shape.includes('recovery') && shape !== 'recovery' ? { activeStartedAt: now, ...(shape !== 'ongoing-recovery' ? {activeFinishedAt:now}:{}),
      closeoutOutput:{sandboxId:'original-sandbox',teardown:{verified:shape!=='unverified-recovery',
        completedAt:shape==='invalid-recovery'?'invalid':shape==='future-recovery'?'2999-01-01T00:00:00.000Z':shape==='early-recovery'?'2000-01-01T00:00:00.000Z':now}}}: {})}]}));
const originalClaims=readFileSync(claims);
if (sandbox) make(claims, JSON.stringify({schemaVersion:1,usage:{unknown:true},claims:[{id:'retained',assignmentId:'original-assignment',status:'recovery',
  activeStartedAt:new Date(Date.parse(now)-120_000).toISOString(),leaseExpiresAt:new Date(Date.parse(now)+(shape==='sandbox-live-recovery'?60_000:-60_000)).toISOString(),
  dispatchEnvelope:{assignment:{assignmentAttempt:{schemaVersion:'treeseed.assignment-attempt/v1',id:'original-assignment',deadline:new Date(Date.parse(now)+(shape==='sandbox-live-recovery'?60_000:-60_000)).toISOString()}}}}]}));
const sandboxClaims = sandbox ? readFileSync(claims) : null;
if(shape!=='first-start') {
make(`${directory}/runtime/dist/main.js`, 'old-runtime');
make(`${directory}/runtime-receipt.json`, 'original-receipt');
make(`${directory}/compose.json`, 'original-compose');
}
const before = shape==='first-start'?[]:['runtime/dist/main.js','runtime-receipt.json','compose.json'].map(name=>readFileSync(`${directory}/${name}`));
const states:Record<string,boolean>={manager:true,runner:true};
const commands:string[][]=[];
let partialFailure=false;
const transport=(_executable:string,args:readonly string[])=>{
  commands.push([...args]);
  if(sandbox && _executable.endsWith('systemctl')) {
    if(shape==='sandbox-partial-import-retry'&&args[0]==='restart'&&!partialFailure){partialFailure=true;throw new Error('fixture restart interruption');}
    return args[0]==='show'?'inactive\n':'';
  }
  if(sandbox && _executable.endsWith('ctr')) {
    if(shape==='sandbox-import-failure'&&args.includes('images')&&args.includes('import')) throw new Error('fixture import failure');
    if(shape==='sandbox-physical-work'&&args.includes('tasks')) return 'retained-physical-work\n';
    return args.includes('inspect')?`sha256:${'b'.repeat(64)}`:'';
  }
  if(sandbox && args[0]==='build') {if(shape==='sandbox-build-failure')throw new Error('fixture build failure');return '';}
  if(sandbox && args[0]==='image' && args[1]==='save') { writeFileSync(args[args.indexOf('--output')+1]!, Buffer.alloc(1024)); return ''; }
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
  if(args[0]==='compose'&&(succeeds||sandbox)) {
    assert.deepEqual(states,{manager:false,runner:false},'no code selection before execution drain');
    assert.equal(readFileSync(`${directory}/runtime/dist/main.js`,'utf8'),'new-runtime');
    states.manager=true;states.runner=true;return '';
  }
  throw new Error(`Unexpected Docker transport command: ${args[0]}`);
};
let rejected=false, failure='', result:unknown;
try { result=executeAgentDevelopmentContainer({sessionId,projectId:'agent',targetId:sandbox?'sandbox':'provider',action:'start'},transport); }
catch(error) { rejected=true; failure=String(error); }
assert.deepEqual(readFileSync(claims),sandboxClaims??originalClaims,'handoff must preserve complete provider recovery bytes');
if(sandbox) {
  if(shape==='sandbox-partial-import-retry') {
    assert.equal(rejected,true);assert.match(failure,/fixture restart interruption/);
    assert.deepEqual(states,{manager:false,runner:false},'partial trust changes cannot resume old admissions');
    assert.equal(existsSync(resolve(directory,'../sandbox/receipt.json')),false);
    result=executeAgentDevelopmentContainer({sessionId,projectId:'agent',targetId:'sandbox',action:'start'},transport);
    rejected=false;assert.deepEqual(readFileSync(claims),sandboxClaims);
  } else if(shape!=='sandbox-expired-recovery') {
    assert.equal(rejected,true,failure);
    const expected:Record<string,RegExp>={'sandbox-live-recovery':/cannot replace guest trust/,'sandbox-physical-work':/no remaining sandbox tasks/,
      'sandbox-build-failure':/fixture build failure/,'sandbox-import-failure':/fixture import failure/,'sandbox-invalid-prior':/prior guest trust is invalid/};
    assert.match(failure,expected[shape]!);
    assert.deepEqual(states,{manager:true,runner:true});
    assert.equal(existsSync(resolve(directory,'../sandbox/receipt.json')),false);
    assert.equal(JSON.parse(readFileSync('/etc/treeseed/sandbox/broker.json','utf8')).guestImages[0].digest,`sha256:${'a'.repeat(64)}`);
    if(shape==='sandbox-live-recovery')assert.equal(commands.some(args=>args[0]==='build'),false);
    assert.equal(existsSync(resolve(directory,'../sandbox/rebuild.lock')),false);
    assert.equal(existsSync(resolve(directory,'../sandbox/sandbox-codex.tar')),false);
    console.log(JSON.stringify({shape,rejected:true,originalRecoveryUnchanged:true,priorTrustPreserved:true,executionRestored:true}));
    process.exit(0);
  }
  assert.equal(rejected,false,failure);
  assert.deepEqual(states,{manager:true,runner:true});
  assert.deepEqual(result,{started:true,schemaVersion:1,sessionId,priorDigest:`sha256:${'a'.repeat(64)}`,digest:`sha256:${'b'.repeat(64)}`,image:'treeseed/sandbox-codex:local'});
  const override=JSON.parse(readFileSync(`${directory}/compose.json`,'utf8'));
  for(const service of ['manager','runner']) assert.equal(override.services[service].environment.TREESEED_DEVELOPMENT_SANDBOX_GUEST_DIGEST,`sha256:${'b'.repeat(64)}`);
  assert.equal(JSON.parse(readFileSync('/var/lib/treeseed/manager/host-development/state.json','utf8')).guestImageDigest,`sha256:${'b'.repeat(64)}`);
  const imported=commands.findIndex(args=>args.includes('images')&&args.includes('import'));
  assert.ok(imported>=0);
  for(const name of ['manager','runner']) {
    const stopped=commands.findIndex(args=>args[0]==='stop'&&args.at(-1)===`treeseed-agent-${name}-1`);
    assert.ok(stopped>=0&&stopped<imported);
  }
  assert.deepEqual(readdirSync(resolve(directory,'../sandbox')),['receipt.json']);
  console.log(JSON.stringify({shape,started:true,guestTrustUpdated:true,providerRebound:true,originalRecoveryUnchanged:true}));
} else
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
