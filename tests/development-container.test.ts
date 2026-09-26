import {expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {developmentContainerSchema,renderDevelopmentContainer,developmentRuntimeOwner,resolveDevelopmentRuntimeImage} from '../src/supervisor/development-container.js';
import {developmentStartupCode} from '../src/supervisor/development-diagnostics.js';
import {activeAgentClaims,renderAgentDevelopmentOverride} from '../src/supervisor/development-agent-container.js';
import {managedPersistentServices,renderManagedComponentOverride} from '../src/supervisor/development-component-container.js';
import {parseDevelopmentMigrationInventory} from '../src/supervisor/development-postgres-migration.js';
import {managedContainerDevelopmentConnectionEnvironment} from '../src/manager/reconcile.js';
import type { ComponentRelease, HostConfiguration } from '@treeseed/sdk/deployment';
import {component,host} from './fixtures.js';
const input={sessionId:'dev-example',targetId:'service' as const,worktree:'/workspace/packages/api',workspace:'/workspace/packages',uid:1000,gid:1000,environment:{},image:`sha256:${'a'.repeat(64)}`,leaseSeconds:60,stateRoot:'/var/lib/treeseed/components/api'};
it('routes the Agent control-plane capability to its runtime variable',()=>{
	const configuration=host(),agent=component('agent','development','a'),api=component('api','stable','b');
	agent.runtime.dependencies=[{id:'api',capability:'control-plane-api',locality:'either',optional:false}];
	configuration.components.agent={enabled:true,track:'development',aliases:{},connections:{api:{kind:'local',componentId:'api',serviceId:api.runtime.services[0]!.id,endpointId:api.runtime.services[0]!.endpoints[0]!.id}},configuration:{}} as any;
	const endpoint=api.runtime.services[0]!.endpoints[0]!,alias=endpoint.defaultAlias!;
	configuration.components.api!.aliases={[`api.${api.runtime.services[0]!.id}.${endpoint.id}`]:alias};
	const environment=managedContainerDevelopmentConnectionEnvironment(configuration,agent,[agent,api],[{alias,upstream:'http://api-live:3000',authentication:'application',projectId:'api',targetId:'service'}]);
	expect(environment.TREESEED_CONTROL_PLANE_URL).toBe('http://api-live:3000');
	expect(environment.TREESEED_SERVER_PROFILE_LOCAL_URL).toBe('http://api-live:3000');
});
it('restarts from the immutable local runtime without a registry dependency',()=>{
  const calls:string[][]=[];
  expect(resolveDevelopmentRuntimeImage((_command,args)=>{calls.push([...args]);return input.image;})).toBe(input.image);
  expect(calls).toHaveLength(1);expect(calls[0]?.[0]).toBe('image');
});
it('accepts only safe migration filenames in development migration receipts',()=>{
  const receipt=JSON.stringify({schemaVersion:'treeseed.database-migration-inventory/v1',pending:[],unexpected:['0022_retired.sql']});
  expect(parseDevelopmentMigrationInventory(`build output\n${receipt}\n`)).toEqual({pending:[],unexpected:['0022_retired.sql'],schema:{}});
	const schemaReceipt=JSON.stringify({schemaVersion:'treeseed.database-migration-inventory/v1',pending:[],unexpected:[],schema:{execution_edges:['from_node_id','to_node_id']}});
	expect(parseDevelopmentMigrationInventory(schemaReceipt).schema).toEqual({execution_edges:['from_node_id','to_node_id']});
  expect(()=>parseDevelopmentMigrationInventory(JSON.stringify({schemaVersion:'treeseed.database-migration-inventory/v1',pending:[],unexpected:['../../secret']}))).toThrow('valid migration inventory');
});
it('pulls only when no local runtime exists and rejects non-immutable image results',()=>{
  const calls:string[][]=[];
  expect(resolveDevelopmentRuntimeImage((_command,args)=>{calls.push([...args]);if(calls.length===1)throw new Error('missing');return input.image;})).toBe(input.image);
  expect(calls.map(args=>args[0])).toEqual(['image','pull','image']);
  expect(()=>resolveDevelopmentRuntimeImage(()=> 'mutable:tag')).toThrow('identity');
});
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
  expect(developmentStartupCode("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /workspace/app.ts")).toBe('TSX_MODULE_MISSING');
  expect(developmentStartupCode("Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@treeseed/sdk' imported from /workspace/app.ts")).toBe('SDK_MODULE_MISSING');
});
it('projects startup failures to fixed codes without reflecting sensitive log content',()=>{
  for(const [log,code] of [['does not provide an export named secret-value','EXPORT_MISSING'],['SyntaxError: secret-value','SYNTAX_ERROR'],['relation secret-value does not exist','DATABASE_RELATION_MISSING'],['permission denied secret-value','DATABASE_PERMISSION'],['duplicate key secret-value','DATABASE_CONFLICT'],['ERR_MODULE_NOT_FOUND secret-value','ERR_MODULE_NOT_FOUND'],['secret-value','']] as const)expect(developmentStartupCode(log)).toBe(code);
});
it('rejects privileged options and arbitrary targets at the supervisor boundary',()=>{
	const request={operation:'development.container',sessionId:input.sessionId,projectId:'api',targetId:'service',action:'start'};
  expect(developmentContainerSchema.parse(request)).toEqual(request);
  for(const extra of [{command:'sh'},{composeFile:'/tmp/untrusted'},{environment:{LD_PRELOAD:'bad'}},{mounts:['/:/host']},{privileged:true}])
    expect(()=>developmentContainerSchema.parse({...request,...extra})).toThrow();
  expect(()=>developmentContainerSchema.parse({...request,sessionId:'../../etc'})).toThrow();
	expect(()=>developmentContainerSchema.parse({...request,targetId:'arbitrary'})).toThrow();
	expect(developmentContainerSchema.parse({...request,projectId:'agent',targetId:'provider'})).toMatchObject({projectId:'agent',targetId:'provider'});
	expect(developmentContainerSchema.parse({...request,projectId:'agent',targetId:'sandbox'})).toMatchObject({projectId:'agent',targetId:'sandbox'});
	expect(developmentContainerSchema.parse({...request,projectId:'treedx',targetId:'service'})).toMatchObject({projectId:'treedx'});
	expect(developmentContainerSchema.parse({...request,projectId:'ai',targetId:'ai-inference'})).toMatchObject({projectId:'ai'});
});
it('renders only manager-resolved immutable images into component overrides',()=>{
	const image=`sha256:${'b'.repeat(64)}`;
	const spec=renderManagedComponentOverride({sessionId:'dev-example',projectId:'ai',targetId:'ai-inference',action:'start'},new Map([['inference-api',image]]));
	expect(spec.services['inference-api']).toEqual({image,labels:{'org.treeseed.development.session':'dev-example','org.treeseed.development.target':'ai.ai-inference'}});
	expect(JSON.stringify(spec)).not.toContain('docker.sock');
});
it('excludes successful one-shot services from managed development readiness',()=>{
	expect(managedPersistentServices(['inference-api','inference-gpu-state-init','inference-migrations','inference-manager','inference-api']))
		.toEqual(['inference-api','inference-manager']);
	expect(managedPersistentServices(['lab-state-init','open-webui-action-init'])).toEqual([]);
});
it('renders a fixed Agent overlay with read-only candidate code, live peer routes, and no privileged surface',()=>{
	const digest=`sha256:${'c'.repeat(64)}`;
	const spec=renderAgentDevelopmentOverride({sessionId:'dev-example',runtimeRoot:'/run/treeseed/development-containers/dev-example/agent/provider/runtime',sourceClosureDigest:digest,environment:{TREESEED_CONTROL_PLANE_URL:'http://api-live:3000'},sandboxGuestDigest:digest});
	for(const service of Object.values(spec.services)) {
		expect(service.restart).toBe('no');
		expect(service.labels).toEqual({'org.treeseed.development.session':'dev-example','org.treeseed.development.target':'agent.provider'});
		expect(service.volumes.map(volume=>volume.target)).toEqual(['/app/dist','/app/package.json','/app/node_modules']);
		expect(service.volumes.every(volume=>volume.read_only)).toBe(true);
		expect(service.environment.TREESEED_CONTROL_PLANE_URL).toBe('http://api-live:3000');
		expect(service.environment.TREESEED_DEVELOPMENT_SANDBOX_GUEST_DIGEST).toBe(digest);
		expect(service.environment.TREESEED_PROVIDER_RUNTIME_BUILD).toBe(digest);
	}
	expect(JSON.stringify(spec)).not.toContain('docker.sock');
});
it('allows polling handoff but blocks active and recoverable Agent claims',()=>{
	const root=mkdtempSync(resolve(tmpdir(),'treeseed-agent-development-'));
	try {
		mkdirSync(resolve(root,'runtime'));
		const write=(claims:unknown[])=>writeFileSync(resolve(root,'runtime','capacity-state.json'),JSON.stringify({schemaVersion:1,claims}));
		write([{id:'poll',status:'polling'}]);expect(activeAgentClaims(root)).toEqual([]);
		write([{id:'ready',status:'ready'},{id:'running',status:'running'},{id:'recovery',status:'recovery'}]);
		expect(activeAgentClaims(root).map(claim=>claim.id)).toEqual(['ready','running','recovery']);
		write([{id:'bad',status:'unknown'}]);expect(()=>activeAgentClaims(root)).toThrow('claim is invalid');
	} finally {rmSync(root,{recursive:true,force:true});}
});
it('uses immutable image, read-only source, fixed networks and no privileged/socket access',()=>{
  const spec=renderDevelopmentContainer(input),runtime=spec.services.runtime,migration=spec.services.migration;
  expect(runtime.image).toBe(input.image);expect(runtime.read_only).toBe(true);
  expect(runtime.user).toBe('1000:1000');
  expect(runtime.cap_drop).toEqual(['ALL']);expect(runtime.security_opt).toEqual(['no-new-privileges:true']);
  expect(runtime.networks.private).toEqual({aliases:['api','api-live']});
  expect(runtime.networks.platform).toEqual({aliases:['api','api-live']});
  expect(runtime.volumes[0]).toMatchObject({source:input.workspace,read_only:true});
  expect(JSON.stringify(spec)).not.toContain('docker.sock');expect(runtime.ports).toEqual(['127.0.0.1:3000:3000']);
  expect(runtime.entrypoint.join(' ')).not.toContain('setTimeout');
  expect(runtime.entrypoint.join(' ')).toContain('process.on(s,()=>c.kill(s))');
  expect(runtime.depends_on).toEqual({migration:{condition:'service_completed_successfully'}});
  expect(migration?.entrypoint).toEqual(['node','--import','tsx','scripts/support/migrate-db.ts']);
  expect(migration?.environment).toEqual({TREESEED_DATABASE_URL_FILE:'/run/treeseed/postgres/api/url',TREESEED_DEVELOPMENT_MODE:'migration'});
  expect(migration?.volumes).toEqual([
    {type:'bind',source:input.workspace,target:input.workspace,read_only:true},
    {type:'bind',source:'/run/treeseed/postgres-clients/api/api/runtime',target:'/run/treeseed/postgres/api',read_only:true},
  ]);
  expect(()=>renderDevelopmentContainer({...input,image:'node:latest'})).toThrow('immutable');
});
it('does not publish a runner port and confines its writable state',()=>{
  const runtime=renderDevelopmentContainer({...input,targetId:'operations-runner'}).services.runtime;
  expect(runtime.working_dir).toBe('/app');
  expect(runtime.volumes[0]).toMatchObject({source:'/run/treeseed/development-containers/dev-example/operations-runner/runtime',target:'/app',read_only:true});
  expect(runtime.ports).toBeUndefined();
  expect(runtime.environment.TREESEED_DEVELOPMENT_MODE).toBe('candidate');
  expect(renderDevelopmentContainer({...input,targetId:'operations-runner'}).services).not.toHaveProperty('migration');
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
  expect(runtime.networks).toHaveProperty('postgres');
  expect(renderDevelopmentContainer({...input,targetId}).networks.postgres).toEqual({external:true,name:'treeseed-postgres-private'});
});
it('allows group-readable source without changing state identity or enabling writes',()=>{
  const runtime=renderDevelopmentContainer({...input,targetId:'operations-runner',uid:0,gid:0,sourceGid:1000}).services.runtime;
  expect(runtime.user).toBe('0:0');expect(runtime.group_add).toEqual(['1000']);
  expect(runtime.volumes[0]?.read_only).toBe(true);expect(runtime.cap_drop).toEqual(['ALL']);
  expect(renderDevelopmentContainer({...input,sourceGid:1000}).services.runtime.group_add).toEqual([]);
  const migration=renderDevelopmentContainer({...input,targetId:'service',uid:0,gid:0,sourceGid:1000}).services.migration;
  expect(migration?.user).toBe('0:0');expect(migration?.group_add).toEqual(['1000']);
  expect(migration?.volumes[0]?.read_only).toBe(true);
});
