import {expect,it} from 'vitest';
import {developmentContainerSchema,renderDevelopmentContainer,developmentStartupCode,developmentRuntimeOwner} from '../src/supervisor/development-container.js';
import type { ComponentRelease, HostConfiguration } from '@treeseed/sdk/deployment';
const input={sessionId:'dev-example',targetId:'service' as const,worktree:'/workspace/packages/api',workspace:'/workspace/packages',uid:1000,gid:1000,environment:{},image:`sha256:${'a'.repeat(64)}`,leaseSeconds:60,stateRoot:'/var/lib/treeseed/components/api'};
it('requires the installed API allocation and consistent credential owner',()=>{
  const owner={uid:10001,gid:10001};
  const host={components:{api:{configuration:{identityRuntime:{}}}},postgres:{requirements:[{id:'api',componentId:'api',enabled:true}],allocations:[{requirementId:'api'}]}} as unknown as HostConfiguration;
  const release={componentId:'api',runtime:{postgresLifecycle:[{requirementId:'api',credentialOwner:owner}]}} as unknown as ComponentRelease;
  expect(developmentRuntimeOwner(host,release)).toEqual(owner);
  expect(()=>developmentRuntimeOwner({...host,postgres:undefined},release)).toThrow('allocation');
  expect(()=>developmentRuntimeOwner({...host,components:{}},release)).toThrow('allocation');
  expect(()=>developmentRuntimeOwner(host,{...release,componentId:'identity'})).toThrow('allocation');
  expect(()=>developmentRuntimeOwner(host,{...release,runtime:{...release.runtime,postgresLifecycle:[]}})).toThrow('allocation');
  expect(()=>developmentRuntimeOwner(host,{...release,runtime:{...release.runtime,postgresLifecycle:[...release.runtime.postgresLifecycle!,{...release.runtime.postgresLifecycle![0]!,requirementId:'other',credentialOwner:{uid:0,gid:0}}]}})).toThrow('identities disagree');
});
it('classifies fixed permission boundaries without exposing paths or values',()=>{
  for(const [path,code] of [['/data/operations-runner/file','RUNNER_STATE_PERMISSION'],
    ['/data/published-knowledge/file','KNOWLEDGE_STATE_PERMISSION'],
    ['/run/openbao-client/identity.json','CUSTODY_PERMISSION'],
    ['/run/treeseed-keys/credentials','KEY_PERMISSION']] as const)
    expect(developmentStartupCode(`EACCES: permission denied, open '${path}' secret-value`)).toBe(code);
  expect(developmentStartupCode('EACCES: unknown private path')).toBe('EACCES');
});
it('projects startup failures to fixed codes without reflecting sensitive log content',()=>{
  for(const [log,code] of [['does not provide an export named secret-value','EXPORT_MISSING'],['SyntaxError: secret-value','SYNTAX_ERROR'],['relation secret-value does not exist','DATABASE_RELATION_MISSING'],['permission denied secret-value','DATABASE_PERMISSION'],['duplicate key secret-value','DATABASE_CONFLICT'],['ERR_MODULE_NOT_FOUND secret-value','ERR_MODULE_NOT_FOUND'],['secret-value','']] as const)expect(developmentStartupCode(log)).toBe(code);
});
it('rejects privileged options and arbitrary targets at the supervisor boundary',()=>{
  const request={operation:'development.container',sessionId:input.sessionId,targetId:'service',action:'start'};
  expect(developmentContainerSchema.parse(request)).toEqual(request);
  for(const extra of [{command:'sh'},{composeFile:'/tmp/untrusted'},{environment:{LD_PRELOAD:'bad'}},{mounts:['/:/host']},{privileged:true}])
    expect(()=>developmentContainerSchema.parse({...request,...extra})).toThrow();
  expect(()=>developmentContainerSchema.parse({...request,sessionId:'../../etc'})).toThrow();
  expect(()=>developmentContainerSchema.parse({...request,targetId:'arbitrary'})).toThrow();
});
it('uses immutable image, read-only source, fixed networks and no privileged/socket access',()=>{
  const spec=renderDevelopmentContainer(input),runtime=spec.services.runtime;
  expect(runtime.image).toBe(input.image);expect(runtime.read_only).toBe(true);
  expect(runtime.user).toBe('1000:1000');
  expect(runtime.cap_drop).toEqual(['ALL']);expect(runtime.security_opt).toEqual(['no-new-privileges:true']);
  expect(runtime.volumes[0]).toMatchObject({source:input.workspace,read_only:true});
  expect(JSON.stringify(spec)).not.toContain('docker.sock');expect(runtime.ports).toEqual(['127.0.0.1:3000:3000']);
  expect(runtime.entrypoint.join(' ')).not.toContain('setTimeout');
  expect(runtime.entrypoint.join(' ')).toContain('process.on(s,()=>c.kill(s))');
  expect(()=>renderDevelopmentContainer({...input,image:'node:latest'})).toThrow('immutable');
});
it('does not publish a runner port and confines its writable state',()=>{
  const runtime=renderDevelopmentContainer({...input,targetId:'operations-runner'}).services.runtime;
  expect(runtime.working_dir).toBe('/app');
  expect(runtime.volumes[0]).toMatchObject({source:'/run/treeseed/development-containers/dev-example/operations-runner/runtime',target:'/app',read_only:true});
  expect(runtime.ports).toBeUndefined();
  expect(runtime.environment.TREESEED_DEVELOPMENT_MODE).toBe('candidate');
  expect(runtime.healthcheck.test.join(' ')).toContain('/readyz');
  expect(runtime.entrypoint.join(' ')).toContain('process.on(s,()=>c.kill(s))');
  expect(runtime.volumes.filter(v=>!v.read_only).map(v=>v.source)).toEqual([
    '/var/lib/treeseed/components/api/operations-runner','/var/lib/treeseed/components/api/published-knowledge']);
});
it.each(['service','operations-runner'] as const)('mounts only API runtime database and Identity custody for %s',targetId=>{
  const runtime=renderDevelopmentContainer({...input,targetId,environment:{TREESEED_IDENTITY_HOSTNAME:'identity.example.localhost'}}).services.runtime;
  expect(runtime.environment.TREESEED_DATABASE_URL_FILE).toBe('/run/treeseed/postgres/api/url');
  expect(runtime.volumes).toContainEqual({type:'bind',source:'/run/treeseed/postgres-clients/api/api/runtime',target:'/run/treeseed/postgres/api',read_only:true});
  expect(runtime.volumes).toContainEqual({type:'bind',source:'/run/treeseed/identity-clients/api',target:'/run/treeseed/identity/api',read_only:true});
  expect(JSON.stringify(runtime.volumes)).not.toContain('/migration');
  expect(JSON.stringify(runtime.volumes)).not.toContain('/postgres-clients/identity');
  expect(runtime.environment).not.toHaveProperty('TREESEED_DATABASE_URL');
  expect(runtime.extra_hosts).toContain('identity.example.localhost:host-gateway');
  expect(runtime.environment.NODE_EXTRA_CA_CERTS).toBe('/run/openbao-client/ca.pem');
});
it('allows group-readable source without changing state identity or enabling writes',()=>{
  const runtime=renderDevelopmentContainer({...input,targetId:'operations-runner',uid:0,gid:0,sourceGid:1000}).services.runtime;
  expect(runtime.user).toBe('0:0');expect(runtime.group_add).toEqual(['1000']);
  expect(runtime.volumes[0]?.read_only).toBe(true);expect(runtime.cap_drop).toEqual(['ALL']);
  expect(renderDevelopmentContainer({...input,sourceGid:1000}).services.runtime.group_add).toEqual([]);
});
