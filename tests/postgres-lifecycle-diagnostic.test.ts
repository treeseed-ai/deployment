import { expect,it } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { component } from './fixtures.js';
import { inspectLifecycle, migrationFailureCategories } from '../src/postgres/lifecycle-diagnostic.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';

function fixture() {
  const release=component('api','stable','a');
  release.runtime.services.push({id:'migration',composeService:'migration',endpoints:[]});
  release.runtime.postgresRequirements=[{id:'api',supportedMajors:[17],extensions:[],runtimeConnectionLimit:10}];
  release.runtime.postgresLifecycle=[{requirementId:'api',credentialOwner:{uid:0,gid:0},migration:{composeService:'migration',completion:'exit-zero',timeoutSeconds:120},runtimeServices:['service']}];
  release.runtimeDigest=deploymentDigest(release.runtime);
  const state={project:'treeseed-api',service:'migration',image:`treeseed/api@${release.images[0]!.digest}`,state:'exited',exitCode:1,oomKilled:false};
  const calls:string[][]=[];
  const run=()=>inspectLifecycle(release,async args=>{
    calls.push(args);
    if(args[0]==='ps') return 'b'.repeat(64);
    if(args[0]==='inspect') return JSON.stringify(state);
    if(args[0]==='logs') return 'password=never-export-me Error: permission denied for relation private_records';
    throw new Error('Unexpected command');
  });
  return {release,state,calls,run};
}
it('returns only bounded fixed categories and declared service status',async()=>{
  const f=fixture(),result=await f.run();
  expect(result.services[0]).toEqual({service:'migration',state:'exited',exitCode:1,oomKilled:false,reasons:['database-permission']});
  expect(JSON.stringify(result)).not.toMatch(/never-export|private_records/);
  expect(f.calls.at(-1)).toEqual(['logs','--tail','80','b'.repeat(64)]);
});
it.each(['project','service','image'] as const)('rejects foreign %s before reading logs',async field=>{
  const f=fixture();f.state[field]='wrong';await expect(f.run()).rejects.toThrow('installed release');
  expect(f.calls.some(args=>args[0]==='logs')).toBe(false);
});
it('rejects runtime digest changes before Docker access',async()=>{
  const f=fixture();f.release.runtimeDigest=`sha256:${'c'.repeat(64)}`;
  await expect(f.run()).rejects.toThrow('Exact lifecycle');expect(f.calls).toEqual([]);
});
it('never echoes unknown messages and bounds classification',()=>{
  expect(migrationFailureCategories('secret=abc')).toEqual([]);
  expect(migrationFailureCategories('SyntaxError'+'x'.repeat(131072))).toEqual([]);
  expect(migrationFailureCategories('Managed Identity account migration failed')).toEqual(['identity-account-migration']);
});
it('does not accept log selectors, commands or credential material',()=>{
  const request={operation:'postgres.lifecycle.inspect',componentId:'api',release:'1.0.0'};
  expect(supervisorOperationSchema.safeParse(request).success).toBe(true);
  for(const extra of [{command:'id'},{container:'arbitrary'},{path:'/private'},{password:'secret'}])
    expect(supervisorOperationSchema.safeParse({...request,...extra}).success).toBe(false);
});
