import { chownSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { developmentContainerSchema } from './development-container-contract.js';
export { developmentContainerSchema } from './development-container-contract.js';
import { atomicJson } from '../core/files.js';
import { DevelopmentSessionStore, type ManagedDevelopmentSession } from '../manager/development-sessions.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { loadActiveComponents } from '../manager/current-state.js';
import { managedContainerDevelopmentConnectionEnvironment, componentActivationInputs, composeFiles } from '../manager/reconcile.js';
import { componentStateRoot, configureComponent, resolveDevelopmentSecretEnvironment } from './component.js';
import { componentComposeArguments, type CommandRunner } from './compose-runtime.js';
import { drainCandidateRunner, drainReleasedRunner, releasedRunnerIdentity, restoreReleasedRunner } from './development-runner.js';
import { copyDevelopmentRuntime } from './development-runtime-copy.js';
import { prepareAiStorageIdentities } from './ai/storage-identity.js';
import { recoverDevelopmentCustody } from './development-custody-recovery.js';

const root='/run/treeseed/development-containers';

const dockerCommand:CommandRunner=(executable,args)=>{
  const result=spawnSync(executable,[...args],{encoding:'utf8',timeout:180_000,maxBuffer:1_048_576,
    env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin'}});
  if(result.error||result.status!==0) {
    const text=(result.stderr??'')+'\n'+(result.stdout??'');
    const reason=/port is already allocated|address already in use/i.test(text)?'port_in_use':
      /network .*not.*found|network .*does not exist/i.test(text)?'network_missing':
      /bind source path does not exist/i.test(text)?'mount_missing':
      /invalid mount/i.test(text)?'mount_invalid':/validating|Additional property/i.test(text)?'configuration_invalid':
      /unhealthy|exited/i.test(text)?'application_unhealthy':/permission denied/i.test(text)?'permission_denied':'docker_failed';
    throw new Error(`Managed development ${reason} (exit ${result.status ?? 'timeout'}).`);
  }
  return result.stdout + (args[0]==='logs' ? result.stderr : '');
};

export function developmentContainerSource(record:ManagedDevelopmentSession) {
  const repository=record.session.repositories.find(r=>r.projectId==='api');
  if(!repository)throw new Error('API source is not registered in this development session.');
  const worktree=realpathSync(repository.worktree);
  if(lstatSync(worktree).uid===0 || !existsSync(resolve(worktree,'treeseed.package.yaml')) || !existsSync(resolve(worktree,'.git')))
    throw new Error('Development requires an operator-owned API checkout.');
  const roots=record.session.repositories.map(r=>realpathSync(r.worktree));
  let workspace=worktree;
  while(!roots.every(path=>path===workspace||path.startsWith(workspace+sep)))workspace=dirname(workspace);
  if(workspace.split(sep).filter(Boolean).length<3)throw new Error('Development workspace mount is too broad.');
  const {uid,gid}=lstatSync(worktree);
  return {worktree,workspace,uid,gid};
}

/** No repository commands, Compose files, mounts, image or Docker options cross this boundary. */
export function renderDevelopmentContainer(input:{sessionId:string;targetId:'service'|'operations-runner';worktree:string;workspace:string;uid:number;gid:number;sourceGid?:number;environment:Record<string,string>;image:string;stateRoot:string}) {
  if(!/^sha256:[a-f0-9]{64}$/.test(input.image))throw new Error('Development runtime image must resolve to an immutable local ID.');
  const api=input.targetId==='service', name=`treeseed-${input.sessionId}-api-${input.targetId}`,directory=resolve(root,input.sessionId,input.targetId);
  const args=api?['--watch','--import','tsx','src/api/support/server.ts']:['dist/operations-runner/entrypoint.js','run'];
  // Forward explicit stop signals; elapsed time never terminates development.
  const processSupervisor=`const{spawn}=require('node:child_process');const c=spawn(process.execPath,${JSON.stringify(args)},{stdio:'inherit'});for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>c.kill(s));c.on('exit',n=>process.exit(n??1));`;
  return {services:{runtime:{image:input.image,container_name:name,user:`${input.uid}:${input.gid}`,init:true,read_only:true,restart:'no',
    group_add:input.sourceGid===undefined||input.sourceGid===input.gid?[]:[String(input.sourceGid)],
    entrypoint:['node','-e',processSupervisor],working_dir:api?input.worktree:'/app',cap_drop:['ALL'],security_opt:['no-new-privileges:true'],
    pids_limit:512,mem_limit:'4g',cpus:4,stop_grace_period:'30s',
    labels:{'org.treeseed.development.session':input.sessionId,'org.treeseed.development.target':`api.${input.targetId}`},
    environment:{...input.environment,HOST:'0.0.0.0',PORT:'3000',TREESEED_DEVELOPMENT_SESSION_ID:input.sessionId,TREESEED_DEVELOPMENT_MODE:api?'live':'candidate',
      TREESEED_OPENBAO_ADDRESS:'https://openbao:8200',TREESEED_OPENBAO_IDENTITY_FILE:'/run/openbao-client/identity.json',NODE_EXTRA_CA_CERTS:'/run/openbao-client/ca.pem',
      TREESEED_CAPACITY_ENCRYPTION_KEY_FILE:'/run/treeseed-keys/credentials',TREESEED_DIAGNOSTICS_ENCRYPTION_KEY_FILE:'/run/treeseed-keys/diagnostics',
      ...(api?{}:{TREESEED_PLATFORM_RUNNER_DATA_DIR:'/data/operations-runner',TREESEED_PUBLISHED_KNOWLEDGE_ROOT:'/data/published-knowledge'})},
    volumes:[{type:'bind',source:api?input.workspace:resolve(directory,'runtime'),target:api?input.workspace:'/app',read_only:true},
      {type:'bind',source:resolve(directory,'openbao'),target:'/run/openbao-client',read_only:true},
      {type:'bind',source:resolve(directory,'keys'),target:'/run/treeseed-keys',read_only:true},
      ...(api?[]:[{type:'bind',source:resolve(input.stateRoot,'operations-runner'),target:'/data/operations-runner'},
        {type:'bind',source:resolve(input.stateRoot,'published-knowledge'),target:'/data/published-knowledge'}])],
    tmpfs:['/tmp'],extra_hosts:['host.docker.internal:host-gateway'],
    ...(api?{ports:['127.0.0.1:3000:3000']}:{}),
    healthcheck:{test:['CMD','node','-e',`fetch('http://127.0.0.1:3000${api?'/v1/health/ready':'/readyz'}').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))`],interval:'2s',timeout:'2s',retries:60},
    networks:{private:{},edge:{aliases:[api?'api-live':'operations-runner-live']},platform:{}}}},
    networks:{private:{external:true,name:'treeseed-api_private'},edge:{external:true,name:'treeseed-edge'},platform:{external:true,name:'treeseed-platform'}}};
}

export function executeDevelopmentContainer(value:unknown,command:CommandRunner=dockerCommand) {
  const input=developmentContainerSchema.parse(value),record=new DevelopmentSessionStore().load(input.sessionId);
  const selected=record.session.targets.find(t=>t.projectId==='api'&&t.targetId===input.targetId);
  if(!selected)throw new Error('Development container is outside the registered session.');
  const directory=resolve(root,input.sessionId,input.targetId),file=resolve(directory,'compose.json');
  const handoff=resolve(directory,'released-runner.json');
  const compose=['compose','--project-name',`treeseed-${input.sessionId}-api-${input.targetId}`,'--file',file];
  if(input.action==='stop') {
    if(!existsSync(file)){if(existsSync(directory))rmSync(directory,{recursive:true});return {stopped:true};}
    if(input.targetId==='operations-runner')drainCandidateRunner(command,input.sessionId);
    command('/usr/bin/docker',[...compose,'down','--timeout','30']);
    if(input.targetId==='operations-runner'&&existsSync(handoff))restoreReleasedRunner(command);
    rmSync(directory,{recursive:true});return {stopped:true};
  }
  if(input.action==='status')return {registered:existsSync(file),state:existsSync(file)?command('/usr/bin/docker',[...compose,'ps','--format','json']):null};
  if(record.session.status!=='active')throw new Error('Development session is not active.');
  const host=loadHostConfiguration(),releases=loadActiveComponents(),component=releases.find(r=>r.componentId==='api');
  if(!component)throw new Error('Installed API foundation is required for development.');
  const target=record.runtimes.find(r=>r.project.id==='api')?.targets.find(t=>t.id===input.targetId);
  if(!target)throw new Error('API development target contract is missing.');
  // Development holds the API release, not its managed custody prerequisites.
  // Reconstruct /run from encrypted persistent custody before mounting clients.
  const custodyCompose = () => ['compose', ...componentComposeArguments('api', composeFiles(component)), '--project-name', component.runtime.compose.projectName];
  recoverDevelopmentCustody({
    ready: () => existsSync('/run/treeseed/openbao/client/identity.json'),
    prepare: () => {
      const services = new Set(component.runtime.services.map(service => service.composeService));
      if (!services.has('openbao') || !services.has('openbao-initialize')) throw new Error('Managed API custody recovery contract is unavailable.');
      const inputs = componentActivationInputs(host, component, releases, record.routes);
      configureComponent('api', component.release, inputs.connectionEnvironment, inputs.secretFileIds, inputs.optionalSecretEnvironment);
    },
    startVault: () => { command('/usr/bin/docker', [...custodyCompose(), 'up', '--detach', '--wait', '--wait-timeout', '120', 'openbao']); },
    initializeClient: () => { command('/usr/bin/docker', [...custodyCompose(), 'run', '--rm', '--no-deps', '-T', 'openbao-initialize']); },
  });
  const environment=resolveDevelopmentSecretEnvironment(host,'api',target.secretRefs,
    managedContainerDevelopmentConnectionEnvironment(host,component,releases,record.routes));
  const aiStorageKeys=prepareAiStorageIdentities(host,'api');
  if(Object.keys(aiStorageKeys).length) environment.TREESEED_AI_STORAGE_PUBLIC_KEYS=JSON.stringify(aiStorageKeys);
  const source=developmentContainerSource(record);
  // Stateful candidates retain the installed runtime identity. The source
  // owner's identity is only appropriate for the stateless live API.
  const identity=input.targetId==='operations-runner'?releasedRunnerIdentity(command):source;
  // Resolve once; Docker runs the immutable ID, not a mutable tag from the checkout.
  command('/usr/bin/docker',['pull','--quiet','node:24-bookworm-slim']);
  const image=String(command('/usr/bin/docker',['image','inspect','node:24-bookworm-slim','--format','{{.Id}}'])).trim();
  const spec=renderDevelopmentContainer({...input,...source,uid:identity.uid,gid:identity.gid,sourceGid:source.gid,environment,image,stateRoot:componentStateRoot(host,'api')});
  mkdirSync(directory,{recursive:true,mode:0o700});
  if(input.targetId==='operations-runner') {
    // Refuse to overwrite an existing candidate snapshot. Cleanup must finish first.
    const receipt=copyDevelopmentRuntime({worktree:source.worktree,workspace:source.workspace,
      destination:resolve(directory,'runtime'),sourceUid:source.uid});
    atomicJson(resolve(directory,'runtime-receipt.json'),receipt,0o600);
  }
  // Delegate only the API's fixed credential files to the runtime's UID;
  // the root-owned parent prevents host users from browsing these copies.
  for(const [child,origin,names] of [['openbao','/run/treeseed/openbao/client',['identity.json','ca.pem']],['keys','/run/treeseed/component-credentials/api',['credentials','diagnostics']]] as const) {
    const target=resolve(directory,child);mkdirSync(target,{recursive:true,mode:0o700});chownSync(target,identity.uid,identity.gid);
    for(const name of names){const value=readFileSync(resolve(origin,name));try{const output=resolve(target,name);writeFileSync(output,value,{mode:0o600});chownSync(output,identity.uid,identity.gid);}finally{value.fill(0);}}
  }
  atomicJson(file,spec,0o600);
  let drained=false;
  if(input.targetId==='operations-runner') {
    drained=drainReleasedRunner(command);
    if(drained)atomicJson(handoff,{restore:true},0o600);
  }
  try { command('/usr/bin/docker',[...compose,'up','--detach','--wait','--wait-timeout','120','runtime']); }
  catch(error) {
    let code='';
    try { const log=String(command('/usr/bin/docker',['logs','--tail','50',`treeseed-${input.sessionId}-api-${input.targetId}`]));
      code=developmentStartupCode(log);
    } catch {/* Diagnostics never prevent cleanup. */}
    try{
      if(input.targetId==='operations-runner')drainCandidateRunner(command,input.sessionId);
      command('/usr/bin/docker',[...compose,'down','--timeout','30']);
      if(drained||existsSync(handoff))restoreReleasedRunner(command);
      rmSync(directory,{recursive:true});
    }catch{/* Retain the root-owned spec and handoff marker for an idempotent cleanup retry. */}
    if(code)throw new Error(`Managed development application startup failed (${code}).`);
    throw error;
  }
  return {started:true};
}

/** Only fixed diagnostic codes cross the operator boundary, never raw logs. */
export function developmentStartupCode(log:string):string {
  if (/\bEACCES\b/.test(log)) {
    for (const [path, code] of [['/data/operations-runner', 'RUNNER_STATE_PERMISSION'],
      ['/data/published-knowledge', 'KNOWLEDGE_STATE_PERMISSION'],
      ['/run/openbao-client', 'CUSTODY_PERMISSION'], ['/run/treeseed-keys', 'KEY_PERMISSION']] as const) {
      if (log.split('\n').some(line => /\bEACCES\b/.test(line) && line.includes(path))) return code;
    }
  }
  return log.match(/\b(ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|EACCES|ECONNREFUSED|ENOTFOUND)\b/)?.[1]??
    (/does not provide an export named/.test(log)?'EXPORT_MISSING':/SyntaxError/.test(log)?'SYNTAX_ERROR':/duplicate key|already exists/.test(log)?'DATABASE_CONFLICT':/permission denied/.test(log)?'DATABASE_PERMISSION':/relation .*does not exist/.test(log)?'DATABASE_RELATION_MISSING':'');
}
