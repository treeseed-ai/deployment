import { beforeEach, expect, it, vi } from 'vitest';
import type { SandboxBrokerConfiguration } from '../src/sandbox/protocol.js';
import * as doctor from '../src/sandbox/doctor.js';

const observed=vi.hoisted(()=>({tasks:'unrelated-task\n',containers:'unrelated-container\n',mounts:'1 0 0:1 / / rw - rootfs rootfs rw\n',
 namespace:'mnt:[1234]',hostNamespace:'mnt:[1234]',rootPresent:true,rootLink:false,unreadable:'',entries:['sandbox-retained','audit'],
 processes:[] as string[],processReads:0,processChanged:false,pidNamespace:'pid:[4321]',hostPidNamespace:'pid:[4321]',statReads:0,statChanged:false,nbd:[] as string[],files:{} as Record<string,string>,links:{} as Record<string,string>,nbdReads:0,nbdChanged:false,
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
 readFileSync:(path:string)=>{if(path!=='/proc/1/mountinfo'){
  if(observed.unreadable===path)throw Object.assign(new Error('denied'),{code:'EACCES'});
  if(Object.hasOwn(observed.files,path)){if(path==='/proc/1/root/proc/100/stat'){observed.statReads++;if(observed.statChanged&&observed.statReads>1)return processStat('100','999');}return observed.files[path];}throw Object.assign(new Error('absent'),{code:'ENOENT'});
 }if(observed.unreadable==='mounts')throw new Error('denied');return observed.mounts;},
 readlinkSync:(path:string)=>{if(path.endsWith('/ns/pid'))return path.endsWith('/1/ns/pid')?observed.hostPidNamespace:observed.pidNamespace;if(/^\/proc\/(?:1\/root\/proc\/)?[0-9]+\/exe$/u.test(path)&&!Object.hasOwn(observed.links,path))throw Object.assign(new Error('absent'),{code:'ENOENT'});if(Object.hasOwn(observed.links,path)){if(observed.unreadable===path)throw Object.assign(new Error('denied'),{code:'EACCES'});return observed.links[path];}
  if(observed.unreadable==='namespace')throw new Error('denied');return path==='/proc/1/ns/mnt'?observed.hostNamespace:observed.namespace;},
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
 readdirSync:(path:string)=>{if(path==='/proc/1/root/proc'){if(observed.unreadable===path)throw Object.assign(new Error('denied'),{code:'EACCES'});observed.processReads++;return [...observed.processes,...(observed.processChanged&&observed.processReads>1?['400']:[])];}if(path==='/sys/block'){if(observed.unreadable===path)throw Object.assign(new Error('denied'),{code:'EACCES'});
  observed.nbdReads++;return [...observed.nbd,...(observed.nbdChanged&&observed.nbdReads>1?['nbd3']:[])];}expect(path).toBe('/proc/1/root/var/lib/treeseed/sandboxes');if(observed.unreadable==='directories')throw new Error('denied');return [...observed.entries];},
}));
const configuration:SandboxBrokerConfiguration={socketPath:'/run/treeseed/sandbox/broker.sock',containerdAddress:'/run/containerd/containerd.sock',
 namespace:'treeseed-sandboxes',runtime:'io.containerd.kata.v2',stateRoot:'/var/lib/treeseed/sandboxes',trustedProvidersPath:'/etc/treeseed/sandbox/providers.json',
 relay:{listenHost:'10.89.0.1',port:7443,publicUrl:'https://10.89.0.1:7443',certificateFile:'/etc/treeseed/sandbox/relay.crt',privateKeyFile:'/run/credentials/relay-tls-key'},guestImages:[]};
beforeEach(()=>{observed.tasks='unrelated-task\n';observed.containers='unrelated-container\n';observed.mounts='1 0 0:1 / / rw - rootfs rootfs rw\n';
 observed.namespace='mnt:[1234]';observed.hostNamespace='mnt:[1234]';observed.rootPresent=true;observed.rootLink=false;observed.unreadable='';observed.entries=['sandbox-retained','audit'];observed.calls=[];observed.changed=false;observed.reordered=false;observed.hostFailure='';observed.processes=[];observed.processReads=0;observed.processChanged=false;observed.pidNamespace='pid:[4321]';observed.hostPidNamespace='pid:[4321]';observed.statReads=0;observed.statChanged=false;observed.nbd=[];observed.files={};observed.links={};observed.nbdReads=0;observed.nbdChanged=false;});

it('reads complete stable owning host inventories without hiding unrelated resources or starting a runtime',async()=>{
 const image='/var/lib/treeseed/agent/workspaces/leases/workspace-lease-11111111-1111-4111-8111-111111111111/work.qcow2';
 observed.nbd=['nbd2','nbd1','nbd0'];observed.files={'/sys/block/nbd0/pid':'101\n','/sys/block/nbd1/pid':'201\n',
  '/proc/101/status':'Tgid:\t100\n','/proc/201/status':'Tgid:\t200\n',
  '/proc/100/cmdline':'qemu-nbd\0--description\0controlled-private-argument\0work.qcow2\0',
  '/proc/200/cmdline':'qemu-nbd\0/private/unrelated.img\0'};
 observed.links={'/proc/100/exe':'/usr/bin/qemu-nbd','/proc/200/exe':'/usr/bin/qemu-nbd',
  '/proc/100/cwd':image.slice(0,image.lastIndexOf('/')),'/proc/200/cwd':'/private'};

 observed.mounts+='2 1 0:4 net:[4026533736] /run/docker/netns/retained rw shared:7 - nsfs nsfs rw\n'
  +'3 1 0:4 mnt:[4026533684] /run/snapd/ns/retained.mnt rw - nsfs nsfs rw\n';
 const held=structuredClone(configuration),result=await doctor.inspectSandboxInventory(configuration);
 expect(result.complete).toBe(true);expect(result.errors).toEqual([]);
 expect(result.scope).toEqual({brokerSocket:configuration.socketPath,containerdAddress:configuration.containerdAddress,namespace:configuration.namespace,stateRoot:configuration.stateRoot,mountNamespace:observed.namespace,pidNamespace:observed.pidNamespace,procRoot:'/proc/1/root/proc'});
 expect(result.tasks).toBe(observed.tasks);expect(result.containers).toBe(observed.containers);expect(result.mountInfo).toBe(observed.mounts);
 expect(Reflect.get(result,'nbdDevices')).toEqual([
  {device:'/dev/nbd0',threadId:101,processId:100,executable:'/usr/bin/qemu-nbd',image,failure:null},
  {device:'/dev/nbd1',threadId:201,processId:200,executable:'/usr/bin/qemu-nbd',image:'/private/unrelated.img',failure:null},
  {device:'/dev/nbd2',threadId:null,processId:null,executable:null,image:null,failure:null}]);
 expect(Reflect.get(result.confirmation,'nbdDevices')).toEqual(Reflect.get(result,'nbdDevices'));expect(JSON.stringify(result)).not.toContain('controlled-private-argument');
 expect(result.managedDirectory).toEqual({rootPresent:true,entries:[{name:'audit',type:'directory'},{name:'sandbox-retained',type:'directory'}]});
 expect(observed.calls).toHaveLength(4);
 for(const call of observed.calls){expect(call.path).toBe('/usr/bin/ctr');expect(call.args.slice(0,4)).toEqual(['--address',configuration.containerdAddress,'--namespace',configuration.namespace]);expect(call.args.slice(4)).toMatchObject([expect.stringMatching(/^(tasks|containers)$/u),'list','--quiet']);}
 for(const args of [
  ['qemu-nbd','work.qcow2','--description','controlled-private-argument'],
  ['qemu-nbd','--description=controlled-private-argument','--','work.qcow2'],
 ]){
  observed.files['/proc/100/cmdline']=args.join('\0')+'\0';const original=structuredClone(observed.files);
  const current=await doctor.inspectSandboxInventory(configuration);expect(current.complete).toBe(true);
  expect(current.nbdDevices?.find(device=>device.device==='/dev/nbd0')?.image).toBe(image);
  expect(JSON.stringify(current)).not.toContain('controlled-private-argument');expect(observed.files).toEqual(original);
 }
 expect(configuration).toEqual(held);
});
it('distinguishes complete empty inventories and absent managed root from unavailable observations',async()=>{
 observed.tasks='';observed.containers='';observed.rootPresent=false;
 const result=await doctor.inspectSandboxInventory(configuration);
 expect(result.complete).toBe(true);expect(result.tasks).toBe('');expect(result.containers).toBe('');expect(result.managedDirectory).toEqual({rootPresent:false,entries:[]});
 expect(Reflect.get(result,'nbdDevices')).toEqual([]);expect(Reflect.get(result.confirmation,'nbdDevices')).toEqual([]);
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
 observed.changed=false;observed.rootLink=false;observed.hostNamespace=observed.namespace;observed.mounts='1 0 0:1 / / rw - rootfs rootfs rw\n';
 for(const mode of ['root-denied','pid-denied','bad-pid','missing-status','bad-tgid','missing-exe','bad-image','two-images','description-only','unknown-option','changed']){
  observed.unreadable='';observed.nbd=['nbd0'];observed.nbdReads=0;observed.nbdChanged=mode==='changed';
  observed.files={'/sys/block/nbd0/pid':'101\n','/proc/101/status':'Tgid:\t100\n','/proc/100/cmdline':'qemu-nbd\0work.qcow2\0'};
  observed.links={'/proc/100/exe':'/usr/bin/qemu-nbd','/proc/100/cwd':'/private'};
  if(mode==='root-denied')observed.unreadable='/sys/block';if(mode==='pid-denied')observed.unreadable='/sys/block/nbd0/pid';
  if(mode==='bad-pid')observed.files['/sys/block/nbd0/pid']='0\n';if(mode==='missing-status')delete observed.files['/proc/101/status'];
  if(mode==='bad-tgid')observed.files['/proc/101/status']='Tgid: invalid\n';if(mode==='missing-exe')observed.unreadable='/proc/100/exe';
  if(mode==='bad-image')observed.files['/proc/100/cmdline']='qemu-nbd\0';
  if(mode==='two-images')observed.files['/proc/100/cmdline']='qemu-nbd\0first.qcow2\0work.qcow2\0';
  if(mode==='description-only')observed.files['/proc/100/cmdline']='qemu-nbd\0--description\0work.qcow2\0';
  if(mode==='unknown-option')observed.files['/proc/100/cmdline']='qemu-nbd\0work.qcow2\0--unknown-option\0controlled-private-argument\0';
  const held=structuredClone({files:observed.files,links:observed.links}),result=await doctor.inspectSandboxInventory(configuration);
  expect(result.complete,mode).toBe(false);expect(result.errors).toContain(mode==='changed'?'nbd_inventory_changed':'nbd_inventory_unavailable');
  expect({files:observed.files,links:observed.links}).toEqual(held);
 }
 observed.nbd=[];observed.nbdChanged=false;observed.unreadable='';
 for(const [root,filesystem] of [['net:[other]','nsfs'],['net:[42','nsfs'],['net:42','nsfs'],[':[42]','nsfs'],['relative','nsfs'],['net:[42]','ext4']]){
  observed.mounts=`1 0 0:4 ${root} /run/retained rw - ${filesystem} ${filesystem} rw\n`;
  const result=await doctor.inspectSandboxInventory(configuration);
  expect(result.complete).toBe(false);expect(result.errors).toContain('owning_mount_inventory_unavailable');
  expect(result.mountInfo).toBe(observed.mounts);
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

function processStat(pid:string,start:string){return pid+' (qemu system) S '+Array.from({length:18},()=>0).join(' ')+' '+start+' 0\n';}
function vmProcesses(){
 observed.processes=['100','200','300','500'];
 observed.links={'/proc/1/root/proc/100/exe':'/opt/kata/bin/qemu-system-x86_64','/proc/1/root/proc/200/exe':'/usr/bin/qemu-system-x86_64 (deleted)','/proc/1/root/proc/500/exe':'/usr/bin/node'};
 observed.files={'/proc/1/root/proc/100/stat':processStat('100','42'),'/proc/1/root/proc/200/stat':processStat('200','43'),'/proc/1/root/proc/400/stat':processStat('400','44'),
  '/proc/1/root/proc/100/cmdline':'qemu-system-x86_64\0-name\0sandbox-sandbox-own\0-append\0controlled-private-argument\0',
  '/proc/1/root/proc/200/cmdline':'qemu-system-x86_64\0-name\0unrelated-vm\0','/proc/1/root/proc/400/cmdline':'qemu-system-x86_64\0-name\0sandbox-later\0',
  '/proc/1/root/proc/300/status':'Name:\tkworker\nKthread:\t1\nState:\tS (sleeping)\n'};
 observed.links['/proc/1/root/proc/400/exe']='/opt/kata/bin/qemu-system-x86_64';
}
it('requires complete stable native VM process identities and original Kata names while retaining unrelated VMs and withholding private arguments',async()=>{
 vmProcesses();observed.unreadable='/proc/1/root/proc/500/cmdline';const held=structuredClone({files:observed.files,links:observed.links,configuration});
 const result=await doctor.inspectSandboxInventory(configuration);
 expect(Reflect.get(result,'vmProcesses')).toEqual([
  {processId:100,startTicks:'42',executable:'/opt/kata/bin/qemu-system-x86_64',name:'sandbox-sandbox-own',failure:null},
  {processId:200,startTicks:'43',executable:'/usr/bin/qemu-system-x86_64 (deleted)',name:'unrelated-vm',failure:null}]);
 expect(Reflect.get(result.confirmation,'vmProcesses')).toEqual(Reflect.get(result,'vmProcesses'));expect(Reflect.get(result.scope,'pidNamespace')).toBe(observed.pidNamespace);
 expect(result.complete).toBe(true);expect(JSON.stringify(result)).not.toContain('controlled-private-argument');expect({files:observed.files,links:observed.links,configuration}).toEqual(held);
});
it('fails physical closure on unreadable malformed changing or ambiguously named VM inventories without changing original observations',async()=>{
 for(const mode of ['root-denied','exe-denied','stat-denied','stat-malformed','command-denied','truncated-command','missing-name','duplicate-name','invalid-name','changing','foreign-pid-namespace','malformed-pid-namespace','pid-reused','duplicate-pid']){
  vmProcesses();observed.unreadable='';observed.processReads=0;observed.processChanged=false;observed.pidNamespace='pid:[4321]';observed.hostPidNamespace='pid:[4321]';observed.statReads=0;observed.statChanged=false;
  if(mode==='root-denied')observed.unreadable='/proc/1/root/proc';if(mode==='exe-denied')observed.unreadable='/proc/1/root/proc/100/exe';if(mode==='stat-denied')observed.unreadable='/proc/1/root/proc/100/stat';
  if(mode==='stat-malformed')observed.files['/proc/1/root/proc/100/stat']='100 invalid';if(mode==='command-denied')observed.unreadable='/proc/1/root/proc/100/cmdline';
  if(mode==='truncated-command')observed.files['/proc/1/root/proc/100/cmdline']='qemu-system-x86_64\0-name\0sandbox-own';
  if(mode==='missing-name')observed.files['/proc/1/root/proc/100/cmdline']='qemu-system-x86_64\0';
  if(mode==='duplicate-name')observed.files['/proc/1/root/proc/100/cmdline']='qemu-system-x86_64\0-name\0sandbox-own\0-name\0another\0';
  if(mode==='invalid-name')observed.files['/proc/1/root/proc/100/cmdline']='qemu-system-x86_64\0-name\0private unsupported name\0';
  if(mode==='changing')observed.processChanged=true;if(mode==='foreign-pid-namespace')observed.hostPidNamespace='pid:[5678]';if(mode==='malformed-pid-namespace')observed.pidNamespace='foreign';if(mode==='pid-reused')observed.statChanged=true;if(mode==='duplicate-pid')observed.processes.push('100');
  const held=structuredClone({files:observed.files,links:observed.links}),result=await doctor.inspectSandboxInventory(configuration);
  expect(result.complete,mode).toBe(false);expect(result.errors,mode).toContain(mode==='changing'?'vm_inventory_changed':'vm_inventory_unavailable');expect({files:observed.files,links:observed.links}).toEqual(held);
 }
});
