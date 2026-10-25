import { randomUUID } from 'node:crypto';
import { lstatSync, statSync, fstatSync, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { CanonicalJson, PlatformSchemas, ServiceSchemas, type ServicePlan } from '@treeseed-cordis/sdk';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
import { InstallationStore, InstallationWriter } from './installed.js';
import { ServicePlanStore } from './service-plan.js';
export class BootstrapSchemas {
    static readonly reference = z.strictObject({ nonce: z.string().uuid() });
    static readonly authority = z.strictObject({ plan: ServiceSchemas.plan, bootstrap: this.reference.optional() });
    static readonly intent = z.strictObject({ formatVersion: z.literal(1), nonce: z.string().uuid(), installationId: PlatformSchemas.text, installationDirectory: PlatformSchemas.absolute, planId: ServiceSchemas.plan.shape.id, digest: PlatformSchemas.digest, workerDigest: PlatformSchemas.digest, workerSize: z.number().int().positive().max(512 * 1024 * 1024), ownerUid: z.number().int().nonnegative(), parentPid: z.number().int().positive() });
    static readonly executable = z.strictObject({ formatVersion: z.literal(1), nonce: z.string().uuid(), dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative(), size: z.number().int().positive() });
    static readonly child = z.strictObject({ formatVersion: z.literal(1), nonce: z.string().uuid(), parentPid: z.number().int().positive(), pid: z.number().int().positive(), dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative() });
    static readonly ready = z.strictObject({ formatVersion: z.literal(1), nonce: z.string().uuid(), parentPid: z.number().int().positive(), pid: z.number().int().positive() });
}
interface BootstrapData {
    intent: z.infer<typeof BootstrapSchemas.intent>;
    executable: z.infer<typeof BootstrapSchemas.executable> | null;
    child: z.infer<typeof BootstrapSchemas.child> | null;
    ready: z.infer<typeof BootstrapSchemas.ready> | null;
}
/** Immutable launch records; the existing store/writer still owns installation mutation. */
export class BootstrapRecords {
    static #verifiedExecutable: string | null = null;
    private static worker(state: SafeDirectory, before: Stats, intent: BootstrapData['intent'], child: BootstrapData['child'], ready: BootstrapData['ready']): void {
        const key = CanonicalJson.stringify({ dev: before.dev, ino: before.ino, size: before.size, digest: intent.workerDigest });
        const executable = ready && child?.pid === process.pid ? statSync('/proc/self/exe') : null;
        const running = executable?.dev === before.dev && executable?.ino === before.ino;
        if (!running || this.#verifiedExecutable !== key) state.hash('worker', intent.workerDigest, intent.workerSize);
        const linked = lstatSync(state.childPath('worker'));
        Check.require(linked.dev === before.dev && linked.ino === before.ino && linked.size === before.size && linked.uid === before.uid && linked.mode === before.mode && linked.nlink === 1 && linked.mtimeMs === before.mtimeMs && linked.ctimeMs === before.ctimeMs, 'WORKER_IDENTITY_CHANGED');
        if (running) this.#verifiedExecutable = key;
    }
    private static record<T>(schema: {
        safeParse(value: unknown): {
            success: boolean;
            data?: T;
        };
    }, directory: SafeDirectory, name: string): T { const parsed = schema.safeParse(StrictJson.parse(directory.file(name, undefined, 4096, true))); Check.require(parsed.success, 'BOOTSTRAP_REPAIR_REQUIRED'); return parsed.data!; }
    static read(state: SafeDirectory, plans: ReadonlyMap<string, ServicePlan>): BootstrapData | null { const names = state.entries(); if (!names.includes('launch')) {
        Check.require(!names.includes('worker'), 'BOOTSTRAP_REPAIR_REQUIRED');
        return null;
    } const launch = state.directory('launch', true); try {
        const entries = launch.entries();
        Check.require(entries.includes('intent.json') && entries.length <= 4, 'BOOTSTRAP_REPAIR_REQUIRED');
        for (const name of entries)
            Check.require(['intent.json', 'executable.json', 'child.json', 'ready.json'].includes(name), 'BOOTSTRAP_REPAIR_REQUIRED');
        const intent = this.record(BootstrapSchemas.intent, launch, 'intent.json'), plan = plans.get(intent.planId);
        Check.require(plan && plan.digest === intent.digest && intent.installationDirectory === dirname(state.path) && intent.installationId === plan.configuration.installationId && intent.ownerUid === process.getuid?.() && intent.workerDigest === plan.composition.worker.sha256 && intent.workerSize === plan.composition.worker.size, 'BOOTSTRAP_BINDING');
        let executable: BootstrapData['executable'] = null, child: BootstrapData['child'] = null, ready: BootstrapData['ready'] = null, worker: Stats | null = null;
        if (names.includes('worker')) {
            const stat = lstatSync(state.childPath('worker'));
            Check.require(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o500 && stat.nlink === 1 && stat.size === intent.workerSize, 'WORKER_INTEGRITY');
            worker = stat;
            if (entries.includes('executable.json')) {
                executable = this.record(BootstrapSchemas.executable, launch, 'executable.json');
                Check.require(executable.nonce === intent.nonce && executable.dev === stat.dev && executable.ino === stat.ino && executable.size === stat.size, 'WORKER_IDENTITY_CHANGED');
            }
        }
        else
            Check.require(!entries.includes('executable.json'), 'BOOTSTRAP_REPAIR_REQUIRED');
        if (entries.includes('child.json')) {
            Check.require(executable, 'BOOTSTRAP_REPAIR_REQUIRED');
            child = this.record(BootstrapSchemas.child, launch, 'child.json');
            Check.require(child.nonce === intent.nonce && child.parentPid === intent.parentPid && child.pid !== intent.parentPid && child.dev === executable.dev && child.ino === executable.ino, 'BOOTSTRAP_BINDING');
        }
        if (entries.includes('ready.json')) {
            Check.require(child, 'BOOTSTRAP_REPAIR_REQUIRED');
            ready = this.record(BootstrapSchemas.ready, launch, 'ready.json');
            Check.require(ready.nonce === intent.nonce && ready.parentPid === intent.parentPid && ready.pid === child.pid, 'BOOTSTRAP_BINDING');
        }
        if (worker) this.worker(state, worker, intent, child, ready);
        launch.verify();
        state.verify();
        return { intent, executable, child, ready };
    }
    finally {
        launch.close();
    } }
}
/** Current-process proof. No caller-controlled predicate can waive the handoff checks. */
export class BootstrapPermit {
    #plan: ServicePlan;
    #nonce: string;
    private constructor(plan: ServicePlan, nonce: string) { this.#plan = plan; this.#nonce = nonce; }
    static claim(input: ServicePlan, nonce: string): BootstrapPermit { const plan = ServiceSchemas.plan.parse(input); BootstrapSchemas.reference.parse({ nonce }); this.validate(plan, nonce); return new BootstrapPermit(plan, nonce); }
    private static validate(plan: ServicePlan, nonce: string): void { const state = SafeDirectory.open(plan.configuration.installationDirectory + '/.cordis'); try {
        SafeDirectory.owner(fstatSync(state.fd), true);
        const data = BootstrapRecords.read(state, new Map([[plan.id, plan]]));
        Check.require(data?.ready && data.child && data.executable && data.intent.nonce === nonce && data.child.pid === process.pid, 'BOOTSTRAP_HANDOFF_REQUIRED');
        const current = statSync('/proc/self/exe');
        Check.require(current.dev === data.executable.dev && current.ino === data.executable.ino, 'WORKER_IDENTITY_CHANGED');
    }
    finally {
        state.close();
    } }
    authorize(path: string): void { Check.require(this.#plan.configuration.installationDirectory === path, 'BOOTSTRAP_BINDING'); BootstrapPermit.validate(this.#plan, this.#nonce); }
    static async wait(plan: ServicePlan, nonce: string, timeoutMs = 10000): Promise<BootstrapPermit> { BootstrapSchemas.reference.parse({ nonce }); Check.require(Number.isInteger(timeoutMs) && timeoutMs >= 50 && timeoutMs <= 30000, 'BOOTSTRAP_TIMEOUT'); const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) {
        const state = SafeDirectory.open(plan.configuration.installationDirectory + '/.cordis');
        let ready = false;
        try {
            const launch = state.directory('launch', true);
            try {
                ready = launch.entries().includes('ready.json');
            }
            finally {
                launch.close();
            }
        }
        finally {
            state.close();
        }
        if (ready)
            return this.claim(plan, nonce);
        await new Promise(BootstrapPermit.delay);
    } return Check.block('BOOTSTRAP_HANDOFF_REQUIRED'); }
    private static delay(done: (value: void) => void): void { setTimeout(done, 50); }
}
/** Parent-only preparation and explicit handoff. This primitive never chooses/spawns an executable. */
export class WorkerBootstrap {
    readonly executable: string;
    private closed = false;
    private handedOff = false;
    private constructor(private readonly plan: ServicePlan, readonly nonce: string, private readonly writer: InstallationWriter, private readonly state: SafeDirectory, private readonly launch: SafeDirectory, private readonly identity: {
        dev: number;
        ino: number;
    }) { this.executable = join(state.path, 'worker'); }
    static prepare(input: ServicePlan): WorkerBootstrap { const plan = ServiceSchemas.plan.parse(input), store = new ServicePlanStore(plan.configuration.installationDirectory); Check.require(CanonicalJson.stringify(store.read(plan.id, plan.digest)) === CanonicalJson.stringify(plan) && store.records().length === 0 && store.resources().length === 0 && store.current() === null, 'WORKER_REPAIR_REQUIRED'); const bundle = SafeDirectory.open(plan.configuration.release.directory); let bytes: Buffer; try {
        bytes = bundle.file(plan.composition.worker.path, plan.composition.worker.sha256, 512 * 1024 * 1024);
        Check.require(bytes.length === plan.composition.worker.size, 'WORKER_INTEGRITY');
    }
    finally {
        bundle.close();
    } const writer = store.writer(), state = SafeDirectory.open(store.path + '/.cordis'); let launch: SafeDirectory | undefined; try {
        writer.assert(store.path);
        Check.require(state.entries().join(',') === 'installation.json,plans,writer.lock', 'WORKER_REPAIR_REQUIRED');
        launch = InstallationStore.mkdir(state, 'launch');
        const nonce = randomUUID();
        InstallationStore.publish(launch, 'intent.json', BootstrapSchemas.intent.parse({ formatVersion: 1, nonce, installationId: plan.configuration.installationId, installationDirectory: store.path, planId: plan.id, digest: plan.digest, workerDigest: plan.composition.worker.sha256, workerSize: plan.composition.worker.size, ownerUid: process.getuid!(), parentPid: process.pid }));
        InstallationStore.publish(state, 'worker', bytes, 0o500);
        const stat = lstatSync(state.childPath('worker'));
        Check.require(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o500, 'WORKER_INTEGRITY');
        InstallationStore.publish(launch, 'executable.json', BootstrapSchemas.executable.parse({ formatVersion: 1, nonce, dev: stat.dev, ino: stat.ino, size: stat.size }));
        return new WorkerBootstrap(plan, nonce, writer, state, launch, { dev: stat.dev, ino: stat.ino });
    }
    catch (error) {
        launch?.close();
        state.close();
        try {
            writer.close();
        }
        catch { }
        throw error;
    } }
    async handoff(pid: number): Promise<void> { Check.require(!this.closed && !this.handedOff && Number.isInteger(pid) && pid > 0 && pid !== process.pid, 'BOOTSTRAP_BINDING'); this.writer.assert(this.plan.configuration.installationDirectory); const running = statSync('/proc/' + pid + '/exe'); Check.require(running.dev === this.identity.dev && running.ino === this.identity.ino, 'WORKER_IDENTITY_CHANGED'); InstallationStore.publish(this.launch, 'child.json', BootstrapSchemas.child.parse({ formatVersion: 1, nonce: this.nonce, parentPid: process.pid, pid, dev: running.dev, ino: running.ino })); this.writer.close(); InstallationStore.publish(this.launch, 'ready.json', BootstrapSchemas.ready.parse({ formatVersion: 1, nonce: this.nonce, parentPid: process.pid, pid })); this.handedOff = true; }
    close(): void { if (this.closed)
        return; this.closed = true; try {
        this.writer.close();
    }
    finally {
        this.launch.close();
        this.state.close();
    } }
}
