import { expect, it, vi } from 'vitest';
import { component, host } from './fixtures.js';
const digest=`sha256:${'a'.repeat(64)}`;
vi.mock('../src/manager/development-sessions.js',()=>({DevelopmentSessionStore:class {
  load(){return {session:{targets:[{projectId:'agent',targetId:'provider'}]}};}
}}));
vi.mock('../src/manager/current-state.js',()=>({loadActiveComponents:()=>[component('agent','development','a')]}));
vi.mock('../src/core/configuration.js',()=>({loadHostConfiguration:()=>host()}));
vi.mock('../src/supervisor/sandbox-guest-import.js',async importOriginal=>({
  ...await importOriginal<typeof import('../src/supervisor/sandbox-guest-import.js')>(),
  configuredSandboxGuestDigest:()=>`sha256:${'a'.repeat(64)}`,
}));
vi.mock('node:fs',async importOriginal=>({
  ...await importOriginal<typeof import('node:fs')>(),
  existsSync:(path:unknown)=>String(path).endsWith('/agent/provider/compose.json'),
}));
import { executeAgentDevelopmentContainer } from '../src/supervisor/development-agent-container.js';
const sessionId='dev-status-regression';
const directory=`/run/treeseed/development-containers/${sessionId}/agent/provider`;
function command(session=sessionId,writable=false) {
  return (_executable:string,args:readonly string[])=>JSON.stringify({
    labels:{'com.docker.compose.project':'treeseed-agent','com.docker.compose.service':args[1]?.includes('manager')?'manager':'runner',
      'org.treeseed.development.session':session,'org.treeseed.development.target':'agent.provider'},
    running:true,environment:[`TREESEED_DEVELOPMENT_SANDBOX_GUEST_DIGEST=${digest}`,`TREESEED_PROVIDER_RUNTIME_BUILD=${digest}`],
    mounts:['dist','package.json','node_modules'].map(name=>({Source:`${directory}/runtime/${name}`,Destination:`/app/${name}`,RW:writable,Type:'bind'})),
  });
}
const status=(transport:ReturnType<typeof command>)=>executeAgentDevelopmentContainer({sessionId,projectId:'agent',targetId:'provider',action:'status'},transport);
it('rejects a running provider belonging to another session instead of reporting ready',()=>{
  expect(()=>status(command('dev-other'))).toThrow();
});
it('rejects a running provider with writable code mounts instead of reporting ready',()=>{
  expect(()=>status(command(sessionId,true))).toThrow();
});
it('rejects a running provider without its private copy receipt instead of reporting ready',()=>{
  expect(()=>status(command())).toThrow();
});
