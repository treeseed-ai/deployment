import {expect,it} from 'vitest';
import {developmentContainerSchema,renderDevelopmentContainer,developmentStartupCode} from '../src/supervisor/development-container.js';
const input={sessionId:'dev-example',targetId:'service' as const,worktree:'/workspace/packages/api',workspace:'/workspace/packages',uid:1000,gid:1000,environment:{},image:`sha256:${'a'.repeat(64)}`,leaseSeconds:60,stateRoot:'/var/lib/treeseed/components/api'};
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
  expect(runtime.entrypoint.join(' ')).toContain('60000');
  expect(()=>renderDevelopmentContainer({...input,image:'node:latest'})).toThrow('immutable');
});
it('does not publish a runner port and confines its writable state',()=>{
  const runtime=renderDevelopmentContainer({...input,targetId:'operations-runner'}).services.runtime;
  expect(runtime.ports).toBeUndefined();
  expect(runtime.environment.TREESEED_DEVELOPMENT_MODE).toBe('candidate');
  expect(runtime.healthcheck.test.join(' ')).toContain('/readyz');
  expect(runtime.entrypoint.join(' ')).toContain('process.on(s,()=>c.kill(s))');
  expect(runtime.volumes.filter(v=>!v.read_only).map(v=>v.source)).toEqual([
    '/var/lib/treeseed/components/api/operations-runner','/var/lib/treeseed/components/api/published-knowledge']);
});
