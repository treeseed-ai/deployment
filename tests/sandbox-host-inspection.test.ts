import { beforeEach, expect, it, vi } from 'vitest';
import type { SandboxBrokerConfiguration } from '../src/sandbox/protocol.js';
import * as doctor from '../src/sandbox/doctor.js';

const observed=vi.hoisted(()=>({tasks:'unrelated-task\n',containers:'unrelated-container\n',mounts:'1 0 0:1 / / rw - rootfs rootfs rw\n',
 namespace:'mnt:[1234]',hostNamespace:'mnt:[1234]',rootPresent:true,rootLink:false,unreadable:'',entries:['sandbox-retained','audit'],
 calls:[] as {path:string;args:readonly string[]}[],changed:false,reordered:false,hostFailure:''}));
vi.mock('node:child_process',()=>({execFile:vi.fn((path:string,args:readonly string[],_options:unknown,callback:(error:Error|null,stdout:string,stderr:string)=>void)=>{
 observed.calls.push({path,args:[...args]});const kind=args.includes('tasks')?'tasks':'containers';
 if(observed.unreadable===kind){callback(new Error('denied'),'', 'private native error');return;}
 let stdout=observed[kind]+(observed.changed&&observed.calls.filter(call=>call.args.includes(kind)).length>1?'new-live-resource\n':'');
 if(observed.reordered&&observed.calls.filter(call=>call.args.includes(kind)).length>1)stdout=stdout.trimEnd().split('\n').reverse().join('\n')+'\n';
 callback(null,stdout,'');
}),execFileSync:vi.fn()}));
vi.mock('node:fs',()=>({
 accessSync:vi.fn(),constants:{R_OK:4,W_OK:2},existsSync:()=>false,
 readFileSync:(path:string)=>{if(observed.unreadable==='mounts')throw new Error('denied');expect(path).toBe('/proc/1/mountinfo');return observed.mounts;},
 readlinkSync:(path:string)=>{if(observed.unreadable==='namespace')throw new Error('denied');return path==='/proc/1/ns/mnt'?observed.hostNamespace:observed.namespace;},
 realpathSync:(path:string)=>observed.rootLink?'/redirected':path,
 lstatSync:(path:string)=>{
  const host=path.startsWith('/proc/1/root');
  if(host&&observed.hostFailure==='missing')throw Object.assign(new Error('absent host'),{code:'ENOENT'});
  path=path.replace(/^\/proc\/1\/root/u,'');
  if(observed.unreadable==='directories')throw new Error('denied');
  if(path==='/var/lib/treeseed/sandboxes'&&!observed.rootPresent)throw Object.assign(new Error('absent'),{code:'ENOENT'});
  const directory=['/var','/var/lib','/var/lib/treeseed'].includes(path)||path==='/var/lib/treeseed/sandboxes'||path.endsWith('/sandbox-retained')||path.endsWith('/audit');
  return {dev:1,ino:host&&observed.hostFailure==='inode'?456:123,isDirectory:()=>directory,isFile:()=>!directory,isSymbolicLink:()=>observed.rootLink};
 },
 readdirSync:(path:string)=>{expect(path).toBe('/proc/1/root/var/lib/treeseed/sandboxes');if(observed.unreadable==='directories')throw new Error('denied');return [...observed.entries];},
}));
const configuration:SandboxBrokerConfiguration={socketPath:'/run/treeseed/sandbox/broker.sock',containerdAddress:'/run/containerd/containerd.sock',
 namespace:'treeseed-sandboxes',runtime:'io.containerd.kata.v2',stateRoot:'/var/lib/treeseed/sandboxes',trustedProvidersPath:'/etc/treeseed/sandbox/providers.json',
 relay:{listenHost:'10.89.0.1',port:7443,publicUrl:'https://10.89.0.1:7443',certificateFile:'/etc/treeseed/sandbox/relay.crt',privateKeyFile:'/run/credentials/relay-tls-key'},guestImages:[]};
beforeEach(()=>{observed.tasks='unrelated-task\n';observed.containers='unrelated-container\n';observed.mounts='1 0 0:1 / / rw - rootfs rootfs rw\n';
 observed.namespace='mnt:[1234]';observed.hostNamespace='mnt:[1234]';observed.rootPresent=true;observed.rootLink=false;observed.unreadable='';observed.entries=['sandbox-retained','audit'];observed.calls=[];observed.changed=false;observed.reordered=false;observed.hostFailure='';});

it('reads complete stable owning host inventories without hiding unrelated resources or starting a runtime',async()=>{
 const held=structuredClone(configuration),result=await doctor.inspectSandboxInventory(configuration);
 expect(result.complete).toBe(true);expect(result.errors).toEqual([]);
 expect(result.scope).toEqual({containerdAddress:configuration.containerdAddress,namespace:configuration.namespace,stateRoot:configuration.stateRoot,mountNamespace:observed.namespace});
 expect(result.tasks).toBe(observed.tasks);expect(result.containers).toBe(observed.containers);expect(result.mountInfo).toBe(observed.mounts);
 expect(result.managedDirectory).toEqual({rootPresent:true,entries:[{name:'audit',type:'directory'},{name:'sandbox-retained',type:'directory'}]});
 expect(observed.calls).toHaveLength(4);
 for(const call of observed.calls){expect(call.path).toBe('/usr/bin/ctr');expect(call.args.slice(0,4)).toEqual(['--address',configuration.containerdAddress,'--namespace',configuration.namespace]);expect(call.args.slice(4)).toMatchObject([expect.stringMatching(/^(tasks|containers)$/u),'list','--quiet']);}
 expect(configuration).toEqual(held);
});
it('distinguishes complete empty inventories and absent managed root from unavailable observations',async()=>{
 observed.tasks='';observed.containers='';observed.rootPresent=false;
 const result=await doctor.inspectSandboxInventory(configuration);
 expect(result.complete).toBe(true);expect(result.tasks).toBe('');expect(result.containers).toBe('');expect(result.managedDirectory).toEqual({rootPresent:false,entries:[]});
});
it('fails closure on unreadable malformed redirected foreign-namespace or changing observations while retaining native evidence',async()=>{
 for(const mode of ['tasks','containers','mounts','namespace','directories','duplicate-task','malformed-container','malformed-mount','empty-mount','namespace-mismatch','root-link','changing']){
  observed.unreadable=['tasks','containers','mounts','namespace','directories'].includes(mode)?mode:'';
  observed.tasks=mode==='duplicate-task'?'duplicate\nduplicate\n':'unrelated-task\n';observed.containers=mode==='malformed-container'?'error: denied\n':'unrelated-container\n';
  observed.mounts=mode==='malformed-mount'?'permission denied':mode==='empty-mount'?'':'1 0 0:1 / / rw - rootfs rootfs rw\n';
  observed.hostNamespace=mode==='namespace-mismatch'?'mnt:[other]':observed.namespace;observed.rootLink=mode==='root-link';observed.changed=mode==='changing';observed.calls=[];
  const held={tasks:observed.tasks,containers:observed.containers,mounts:observed.mounts},result=await doctor.inspectSandboxInventory(configuration);
  expect(result.complete,mode).toBe(false);expect(result.errors.length,mode).toBeGreaterThan(0);
  expect({tasks:observed.tasks,containers:observed.containers,mounts:observed.mounts}).toEqual(held);
 }
});
it('observes the host mount namespace through supervisor hardening only when managed directory inode custody agrees',async()=>{
 observed.hostNamespace='mnt:[5678]';
 const result=await doctor.inspectSandboxInventory(configuration);
 expect(result.complete).toBe(true);expect(result.scope.mountNamespace).toBe('mnt:[5678]');
 expect(result.mountInfo).toBe(observed.mounts);
});
it('denies host namespace directory absence or inode disagreement instead of certifying supervisor-local absence',async()=>{
 for(const failure of ['missing','inode']){
  observed.hostFailure=failure;
  const result=await doctor.inspectSandboxInventory(configuration);
  expect(result.complete,failure).toBe(false);
  expect(result.errors).toContain('managed_directory_inventory_unavailable');
  expect(result.managedDirectory.rootPresent).toBeNull();
 }
});
it('retains differently ordered native inventories while requiring the exact same unique resource identities',async()=>{
 observed.tasks='first-task\nsecond-task\n';observed.containers='first-container\nsecond-container\n';observed.reordered=true;
 const result=await doctor.inspectSandboxInventory(configuration);
 expect(result.complete).toBe(true);
 expect(result.tasks).toBe('first-task\nsecond-task\n');expect(result.confirmation.tasks).toBe('second-task\nfirst-task\n');
 expect(result.containers).toBe('first-container\nsecond-container\n');expect(result.confirmation.containers).toBe('second-container\nfirst-container\n');
});
it('denies blank or whitespace-normalized native identities while preserving the original malformed bytes',async()=>{
 for(const tasks of ['\n','entry \n','entry\n\n']){
  observed.tasks=tasks;observed.calls=[];
  const result=await doctor.inspectSandboxInventory(configuration);
  expect(result.complete,JSON.stringify(tasks)).toBe(false);expect(result.tasks).toBe(tasks);
 }
});
