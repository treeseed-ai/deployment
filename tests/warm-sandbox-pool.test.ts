import { describe, expect, it, vi, onTestFailed } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { kataGuestMemoryMiB, kataWarmOperations, WarmSandboxPool } from '../src/sandbox/warm-sandbox-pool.js';
import { sandboxBrokerConfigurationSchema } from '../src/sandbox/protocol.js';
import { containerdImageReference } from '../src/sandbox/image-reference.js';

const shape = { image: 'trusted@sha256:fixture', cpuCores: 1, memoryBytes: 1024 };
function fixture() {
	let count = 0;
	const operations = { create: vi.fn(async () => `vm-${++count}`), destroy: vi.fn(async (_id: string) => undefined), onFailure: vi.fn() };
	return { operations, pool: new WarmSandboxPool(operations) };
}
describe('one-use pristine warm sandbox pool', () => {
	it('projects exact byte limits into the Kata MiB annotation', () => {
		expect(kataGuestMemoryMiB(8_589_934_592)).toBe(8192);
		expect(kataGuestMemoryMiB(1_048_577)).toBe(2);
		expect(() => kataGuestMemoryMiB(0)).toThrow('Invalid Kata guest memory limit');
	});
	it('atomically assigns each VM once, replenishes only pristine capacity and bounds idle memory', async () => {
		const { pool, operations } = fixture(); pool.prewarm(shape); pool.prewarm(shape);
		expect(operations.create).toHaveBeenCalledTimes(1);
		const results = await Promise.all([pool.acquire(shape), pool.acquire(shape)]);
		expect(new Set(results.map(result => result.id)).size).toBe(2);
		expect(results.map(result => result.warmed)).toEqual([true, false]);
		await pool.drain(); expect(operations.destroy).toHaveBeenCalledTimes(1);
		expect(results.map(result => result.id)).not.toContain(operations.destroy.mock.calls[0]?.[0]);
	});
	it('never substitutes an incompatible image or resource shape', async () => {
		const { pool } = fixture(); pool.prewarm(shape);
		expect((await pool.acquire({ ...shape, image: 'other' })).warmed).toBe(false);
		expect((await pool.acquire(shape)).warmed).toBe(true);
		await pool.drain();
	});
	it('does not recycle failed readiness and rejects admission after drain', async () => {
		const { pool, operations } = fixture(); operations.create.mockRejectedValueOnce(new Error('not ready'));
		pool.prewarm(shape); await Promise.resolve(); await Promise.resolve();
		expect(operations.onFailure).toHaveBeenCalledTimes(1);
		expect((await pool.acquire(shape)).warmed).toBe(false);
		await pool.drain(); await expect(pool.acquire(shape)).rejects.toThrow('stopped');
	});
	it('destroys creation that finishes after admission has stopped', async () => {
		const { pool, operations } = fixture(); let complete!: (value: string) => void;
		operations.create.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
		const pending = pool.acquire(shape); await pool.drain(); complete('late');
		await expect(pending).rejects.toThrow('stopped'); expect(operations.destroy).toHaveBeenCalledWith('late');
	});
	it('retains failed warm teardown ownership across concurrent drain and exact retry without recycling or recreating an assigned VM', async () => {
		const destroyed: string[] = [], failures: unknown[] = [];
		const original = new Error('owned teardown interrupted'); let next = 0, deny = true;
		const operations = { create: async () => `owned-${++next}`, destroy: async (id: string) => {
			destroyed.push(id); if (id === 'owned-2' && deny) throw original;
		}, onFailure: (error: unknown) => { failures.push(error); } };
		const pool = new WarmSandboxPool(operations, 2), input = structuredClone(shape);
		pool.prewarm(input); pool.prewarm(input);
		const assigned = await pool.acquire(input);
		expect(assigned).toEqual({ id: 'owned-1', warmed: true }); expect(next).toBe(3);
		const outcomes = await Promise.allSettled([pool.drain(), pool.drain()]);
		expect(outcomes.some(value => value.status === 'rejected' && value.reason === original)).toBe(true);
		expect(destroyed.filter(id => id === 'owned-2').length).toBeGreaterThan(0);
		expect(destroyed.filter(id => id === 'owned-3')).toEqual(['owned-3']);
		expect(destroyed).not.toContain(assigned.id); expect(failures).toEqual([]);
		const failedHistory = [...destroyed]; deny = false; await pool.drain();
		expect(destroyed).toEqual([...failedHistory, 'owned-2']);
		await pool.drain(); expect(destroyed).toEqual([...failedHistory, 'owned-2']);
		await expect(pool.acquire(input)).rejects.toThrow('stopped'); pool.prewarm(input);
		expect(next).toBe(3); expect(input).toEqual(shape);
	});
	it('native original Kata warm admission assigns distinct pinned VMs and verifies exact task container and readiness-child absence after duplicate teardown', async () => {
		const brokerPath = '/etc/treeseed/sandbox/broker.json', bytes = await readFile(brokerPath);
		const configuration = sandboxBrokerConfigurationSchema.parse(JSON.parse(bytes.toString('utf8')));
		expect(await readlink('/proc/self/ns/mnt')).toBe(await readlink('/proc/1/ns/mnt'));
		const image = configuration.guestImages[0]; expect(image).toBeDefined();
		if (!image) throw new Error('Native pinned Kata image required; no build or fallback');
		const supplied = { image: containerdImageReference(image.image, image.digest), cpuCores: 1,
			memoryBytes: 1_073_741_824, network: 'none' as const }, held = structuredClone(supplied);
		const execute = promisify(execFile), list = async (kind: 'tasks' | 'containers') => (await execute('/usr/bin/ctr',
			['--address', configuration.containerdAddress, '--namespace', configuration.namespace, kind, 'list', '--quiet'],
			{ encoding: 'utf8', timeout: 5000, maxBuffer: 65_536, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } })).stdout.trim().split(/\s+/u).filter(Boolean);
		const original = kataWarmOperations(configuration, error => { throw error; });
		const allocated: string[] = [];
		const pool = new WarmSandboxPool({ ...original, create: async value => {
			const id = await original.create(value); allocated.push(id); return id;
		} }, 0);
		try {
			const [first, second] = await Promise.all([pool.acquire(supplied), pool.acquire(supplied)]);
			expect(first.warmed).toBe(false); expect(second.warmed).toBe(false);
			expect(first.id).not.toBe(second.id); expect(new Set(allocated).size).toBe(2);
			for (const id of allocated) {
				expect(id).toMatch(/^sandbox-warm-[a-f0-9-]{36}$/u);
				expect(await list('tasks')).toContain(id); expect(await list('containers')).toContain(id);
				expect(await list('tasks')).not.toContain(`${id}-ready`);
				expect(await list('containers')).not.toContain(`${id}-ready`);
			}
			await pool.drain(); await expect(pool.acquire(supplied)).rejects.toThrow('stopped');
			// Acquired VMs are caller-owned, never idle-pool drain targets.
			for (const id of allocated) expect(await list('tasks')).toContain(id);
			for (const id of allocated) { await original.destroy(id); await original.destroy(id); }
			for (const id of allocated) for (const kind of ['tasks', 'containers'] as const) {
				const actual = await list(kind); expect(actual).not.toContain(id); expect(actual).not.toContain(`${id}-ready`);
			}
			expect(supplied).toEqual(held); expect(await readFile(brokerPath)).toEqual(bytes);
		} finally {
			await pool.drain();
			// Only identities returned by this callback's own native create are cleanup targets.
			const cleanup = await Promise.allSettled(allocated.map(id => original.destroy(id)));
			for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
		}
	}, 30_000);
});
it('native owning runtime retains its actual acquired VM identity through guest interruption and exact independent host absence',async()=>{
 let phase='INSTALLED_BYTES';const mark=(value:string)=>{phase=value;console.log(JSON.stringify({nativeExecutionVmPhase:phase,observedAt:new Date().toISOString()}));};
 onTestFailed(()=>console.error(JSON.stringify({nativeExecutionVmFailedPhase:phase,originalBoundMillis:30000})));
 const installed='/usr/lib/treeseed/manager/dist/src/sandbox/runtime.js';
 expect(await readFile(installed)).toEqual(await readFile('dist/src/sandbox/runtime.js'));
 expect(await readFile('/usr/lib/treeseed/manager/dist/src/sandbox/guest-startup-monitor.js')).toEqual(await readFile('dist/src/sandbox/guest-startup-monitor.js'));
 const {KataSandboxRuntime}=await import(installed) as typeof import('../src/sandbox/runtime.js');
 const {inspectSandboxInventory}=await import('../src/sandbox/doctor.js');
 const original=await readFile('/etc/treeseed/sandbox/broker.json'),configured=sandboxBrokerConfigurationSchema.parse(JSON.parse(original.toString('utf8')));
 const configuration=sandboxBrokerConfigurationSchema.parse({...configured,modelGateway:undefined}),image=configuration.guestImages[0];
 expect(image).toBeDefined();if(!image||!image.profiles[0])throw new Error('Original pinned native guest required');
 const runtime=new KataSandboxRuntime(configuration),owned:Array<{sandboxId:string;operationToken:string}>=[],failures:unknown[]=[],observations:unknown[]=[];
 let pending:Promise<{failure:unknown;result:unknown}>|undefined,settled=false;
 try{
  // Deliberate credential-free interruption proves native VM custody only.
  // It cannot dispatch a model or count as a managed workday.
  mark('PREPARATION');const prepared=await runtime.prepare({schemaVersion:'treeseed.sandbox-assignment/v1',assignmentId:'native-vm-custody-'+Date.now(),attempt:1,runnerId:'native-runtime-owner',providerId:'native-runtime-owner',teamId:'native-fixture',projectId:'native-fixture',profile:image.profiles[0],guestImage:image.image,guestImageDigest:image.digest,
   identityManifestDigest:'sha256:'+'a'.repeat(64),contextManifestDigest:'sha256:'+'b'.repeat(64),resources:{cpuCores:1,memoryBytes:1073741824,diskBytes:67108864,durationSeconds:30,processLimit:64,outputBytes:1048576},inputs:[],outputs:[],network:{defaultDeny:true,relayUrl:configuration.relay.publicUrl,allowedServices:[]},modelPolicy:{provider:'openai',model:'native-interruption-no-model',capabilities:[]},credentialHandles:[],treeDxHandleIds:[],leaseExpiresAt:new Date(Date.now()+60000).toISOString(),signature:{keyId:'native-owning-fixture',algorithm:'Ed25519',value:'direct-owning-runtime-fixture-not-a-wire-authorization'}});owned.push(prepared);mark('WARM_ACQUISITION');
  pending=runtime.execute(prepared.sandboxId,prepared.operationToken,{}).then(result=>{settled=true;return{result,failure:null};},failure=>{settled=true;return{failure,result:null};});
  const deadline=Date.now()+20000;let current=runtime.inspect(prepared.sandboxId,prepared.operationToken);
  while(!current.running&&!settled&&Date.now()<deadline){await new Promise(done=>setTimeout(done,5));current=runtime.inspect(prepared.sandboxId,prepared.operationToken);}
  console.log(JSON.stringify({nativeExecutionVmObserved:{phase,running:current.running,settled,events:current.events.map(event=>({type:event.type,payload:event.payload}))}}));
  const assigned=current.events.filter(event=>event.type==='execution.progress'&&event.payload.stage==='vm.assigned');expect(assigned).toHaveLength(1);
  const vmId=assigned[0]!.payload.vmId;expect(vmId).toMatch(/^sandbox-warm-[a-f0-9-]{36}$/u);expect(vmId).not.toBe(prepared.sandboxId);
  mark('PRESENT_INVENTORY');const present=await inspectSandboxInventory(configuration);observations.push(present);expect(present.complete).toBe(true);expect(present.errors).toEqual([]);
  const vms=present.vmProcesses!.filter(vm=>vm.name==='sandbox-'+String(vmId));expect(vms).toHaveLength(1);expect(vms[0]!.failure).toBeNull();
  mark('GUEST_CANCELLATION');if(current.running)await runtime.cancel(prepared.sandboxId,prepared.operationToken);
  mark('GUEST_TERMINATION');const outcome=await pending;expect(outcome.failure).toBeInstanceOf(Error);expect(outcome.result).toBeNull();
  mark('SCOPED_DESTRUCTION');const destroyed=await runtime.destroy(prepared.sandboxId,prepared.operationToken);expect(destroyed.destroyed).toBe(true);owned.length=0;
  const terminal=destroyed.events.filter(event=>event.type==='sandbox.destroyed');expect(terminal).toHaveLength(1);expect(terminal[0]!.payload.vmId).toBe(vmId);
  expect(destroyed.events.find(event=>event.sequence===assigned[0]!.sequence)).toEqual(assigned[0]);
  mark('POOL_DRAIN');await runtime.drainWarmPool();mark('ABSENT_INVENTORY');const absent=await inspectSandboxInventory(configuration);observations.push(absent);expect(absent.complete).toBe(true);expect(absent.errors).toEqual([]);
  expect(absent.vmProcesses!.some(vm=>vm.name==='sandbox-'+String(vmId))).toBe(false);
  for(const kind of ['tasks','containers'] as const)expect(absent[kind]!.trim().split(/\s+/u)).not.toContain(vmId);
  expect(await readFile('/etc/treeseed/sandbox/broker.json')).toEqual(original);
 }catch(error){failures.push(error);console.error(JSON.stringify({nativeExecutionVmOriginalFailurePhase:phase}));}finally{
  mark('SCOPED_FAILURE_CLEANUP');
  for(const owner of owned)try{await runtime.cancel(owner.sandboxId,owner.operationToken);await runtime.destroy(owner.sandboxId,owner.operationToken);}catch(error){failures.push(error);}
  try{await pending;}catch(error){failures.push(error);}try{await runtime.drainWarmPool();}catch(error){failures.push(error);}
  console.log(JSON.stringify({nativeExecutionVmCustody:observations,scopedCleanupAttempts:owned.map(owner=>owner.sandboxId),managedWorkday:false,modelDispatched:false}));
 }
 if(failures.length)throw new AggregateError(failures,'Original native execution VM custody or scoped cleanup failed.');
},30000);
