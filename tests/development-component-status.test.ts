import {afterEach,expect,it,vi} from 'vitest';
import {component} from './fixtures.js';
const fixture=vi.hoisted(()=>({override:'',present:true,instances:[] as Array<Record<string,unknown>>,changeDuringInspection:false}));
const sessionId='dev-image-custody',image=`sha256:${'a'.repeat(64)}`;
const labels={'org.treeseed.development.session':sessionId,'org.treeseed.development.target':'treedx.service'};
vi.mock('../src/manager/development-sessions.js',()=>({DevelopmentSessionStore:class {
 load(){return {session:{targets:[{projectId:'treedx',targetId:'service'}]}};}
}}));
vi.mock('../src/manager/current-state.js',()=>({loadActiveComponents:()=>[component('treedx','development','a')]}));
vi.mock('node:fs',async original=>({...await original<typeof import('node:fs')>(),
 existsSync:(path:unknown)=>fixture.present&&String(path).endsWith('/treedx/service/compose.json'),
 readFileSync:()=>fixture.override,
}));
import {executeManagedComponentDevelopment,waitForManagedReadiness} from '../src/supervisor/development-component-container.js';
function selected(){return {services:{treedx:{image,labels}}};}
function instance(){return {id:'native-one',service:'treedx',sessionId,target:'treedx.service',image,running:true,health:'healthy'};}
function status(){return executeManagedComponentDevelopment({sessionId,projectId:'treedx',targetId:'service',action:'status'},(_command,args)=>{
 if(fixture.changeDuringInspection)fixture.override+=' ';
 return args[0]==='ps'?fixture.instances.map(item=>item.id).join('\n'):JSON.stringify(fixture.instances.find(item=>item.id===args[1]));
});}
afterEach(()=>{fixture.override='';fixture.instances=[];fixture.present=true;fixture.changeDuringInspection=false;});
function setup(){fixture.override=JSON.stringify(selected());fixture.instances=[instance()];}
it('rejects a healthy owned component running a different selected image',()=>{
 setup();fixture.instances[0]!.image=`sha256:${'b'.repeat(64)}`;expect(status).toThrow();
});
it('rejects duplicate owned service instances rather than reporting aggregate readiness',()=>{
 setup();fixture.instances.push({...instance(),id:'native-two'});expect(status).toThrow();
});
it('rejects undeclared owned services instead of accepting their health',()=>{
 setup();fixture.instances.push({...instance(),id:'extra',service:'unexpected'});expect(status).toThrow();
});
it('requires every selected persistent service before reporting readiness',()=>{
 setup();const value=selected();Object.assign(value.services,{worker:{image,labels}});fixture.override=JSON.stringify(value);
 expect(status()).toMatchObject({registered:true,ready:false});
});
it('rejects malformed empty mutable and incorrectly owned selected image declarations',()=>{
 setup();for(const value of ['not json',null,[],{},{services:null},{services:[]},{services:{}},{services:{treedx:null}},{services:{treedx:{image:'latest',labels}}},
  {services:{treedx:{image,labels:{...labels,'org.treeseed.development.session':'dev-other'}}}}]){
  fixture.override=typeof value==='string'?value:JSON.stringify(value);expect(status).toThrow();
 }
});
it('rejects selected service identity drift instead of dropping it from observations',()=>{
 setup();fixture.instances[0]!.sessionId='dev-other';expect(status).toThrow();
});
it('preserves matching selected-image readiness and stopped unhealthy non-readiness',()=>{
 setup();expect(status()).toMatchObject({registered:true,ready:true});
 for(const health of ['starting','unhealthy']){fixture.instances[0]!.health=health;expect(status()).toMatchObject({ready:false});}
 fixture.instances=[];expect(status()).toMatchObject({ready:false});
});
it('does not require completed declared one-shot services for steady-state readiness',()=>{
 setup();const value=selected();Object.assign(value.services,{'inference-migrations':{image,labels}});fixture.override=JSON.stringify(value);
 expect(status()).toMatchObject({registered:true,ready:true});
});
it('reports an absent selected override as unregistered without Docker side effects',()=>{
 setup();fixture.present=false;fixture.changeDuringInspection=true;const before=fixture.override;
 expect(status()).toEqual({registered:false,state:null});expect(fixture.override).toBe(before);
});
it('rejects selection changes during Docker inspection before readiness',()=>{
 setup();fixture.changeDuringInspection=true;expect(status).toThrow('selection changed');
});
function activation(){return waitForManagedReadiness((_command,args)=>args[0]==='ps'?fixture.instances.map(item=>item.id).join('\n'):
 JSON.stringify(fixture.instances.find(item=>item.id===args[1])),'treeseed-treedx',
 {sessionId,projectId:'treedx',targetId:'service',action:'start'},new Map([['treedx',image]]));}
it('rejects wrong images during activation readiness as well as later status',()=>{
 setup();fixture.instances[0]!.image=`sha256:${'b'.repeat(64)}`;expect(activation).toThrow();
});
it('rejects duplicate and incorrectly owned activation service identities',()=>{
 setup();fixture.instances.push({...instance(),id:'duplicate'});expect(activation).toThrow();
 fixture.instances=[{...instance(),sessionId:'dev-other'}];expect(activation).toThrow();
});
it('retains healthy exact-image activation readiness without another build or receipt',()=>{
 setup();expect(activation()).toMatchObject({ready:true});
});

it('requires complete exact owning RAM observations and rejects malformed selected limits before readiness',()=>{
 const memoryBytes=4_294_967_296;
 const selection={services:{treedx:{image,labels,mem_limit:memoryBytes,memswap_limit:memoryBytes}}};
 fixture.override=JSON.stringify(selection);fixture.instances=[{...instance(),memoryBytes,memorySwapBytes:memoryBytes}];
 expect(status()).toMatchObject({ready:true});
 for(const memory of [undefined,0,memoryBytes-1,'4294967296']){
  fixture.instances=[{...instance(),memoryBytes:memory,memorySwapBytes:memoryBytes}];
  expect(()=>status()).toThrow('actual RAM limit');
 }
 fixture.instances=[{...instance(),memoryBytes,memorySwapBytes:undefined}];expect(()=>status()).toThrow('actual RAM limit');
 for(const invalid of [0,-1,null,'4g',Number.MAX_SAFE_INTEGER+1]){
  fixture.override=JSON.stringify({services:{treedx:{...selection.services.treedx,mem_limit:invalid}}});
  expect(()=>status()).toThrow();
 }
 fixture.override=JSON.stringify({services:{treedx:{...selection.services.treedx,memswap_limit:memoryBytes+1}}});
 expect(()=>status()).toThrow('swap custody');
});
