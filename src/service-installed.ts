import { spawn, type ChildProcess } from 'node:child_process';
import { lstatSync, statSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { InstalledSchemas, ServiceSchemas, type ApplyOptions, type ServicePlan, type ServiceStatus, type ServiceApplicationRecord } from '@treeseed-cordis/sdk';
import { BootstrapRecords, BootstrapSchemas, WorkerBootstrap } from './service-bootstrap.js';
import { ServicePlanStore, ServiceTransitions } from './service-plan.js';
import { ServiceWorkerClient, ServiceWorkerOwnerClient } from './service-ipc.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
/** Default format-3 transport/launch adapter; the native host remains the sole writer. */
export class ServiceInstalledHost {
    async apply(planId: string, digest: string, input: ApplyOptions): Promise<{ id: string; accepted: true }> {
        const options = ServiceSchemas.applyOptions.parse(input), store = new ServicePlanStore(options.installationDirectory), plan = store.read(planId, digest), client = new ServiceWorkerOwnerClient(options), request = { protocol: 3 as const, operation: 'submit' as const, planId: plan.id, digest: plan.digest, idempotencyKey: options.idempotencyKey,...(options.restartServices?{restartServices:[...options.restartServices].sort()}:{}) };
        ServiceTransitions.activation(plan,options.restartServices);
        if (this.control(plan)) { this.running(plan); return client.submit(request); }
        const bootstrap = WorkerBootstrap.prepare(plan);
        let child: ChildProcess | undefined;
        try {
            child = spawn(bootstrap.executable, ['--installation', store.path, '--plan', plan.id, '--digest', plan.digest, '--nonce', bootstrap.nonce, '--protocol', '3'], { cwd: join(store.path, '.cordis'), detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG } });
            await new Promise<void>(ServiceInstalledHost.spawned.bind(null, child));
            await bootstrap.handoff(child.pid!);
        } finally { child?.unref(); bootstrap.close(); }
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            if (child.exitCode !== null || child.signalCode !== null) throw new Error('SERVICE_WORKER_START_FAILED');
            if (this.control(plan, true)) {
                this.running(plan);
                const status = await client.status();
                Check.require(status.installationId === plan.configuration.installationId && status.engine === plan.expectedEngine.context, 'WORKER_BINDING');
                return client.submit(request);
            }
            await new Promise(ServiceInstalledHost.delay);
        }
        throw new Error('SERVICE_WORKER_START_FAILED');
    }
    private control(plan: ServicePlan, starting = false): boolean {
        const state = SafeDirectory.open(join(plan.configuration.installationDirectory, '.cordis'));
        try {
            SafeDirectory.owner(fstatSync(state.fd), true);
            if (!state.entries().includes('control')) return false;
            const control = state.directory('control', true);
            try {
                const names = control.entries();
                Check.require(names.length === 0 || names.join(',') === 'worker.sock', 'WORKER_REPAIR_REQUIRED');
                if (!names.length) return false;
                const socket = lstatSync(control.childPath('worker.sock'));
                Check.require(socket.isSocket() && !socket.isSymbolicLink() && socket.uid === process.getuid?.() && socket.nlink === 1, 'WORKER_SOCKET_OWNER');
                if (starting && (socket.mode & 0o777) !== 0o600) return false;
                Check.require((socket.mode & 0o777) === 0o600, 'WORKER_SOCKET_OWNER');
                control.verify(); state.verify(); return true;
            } finally { control.close(); }
        } finally { state.close(); }
    }
    private running(plan: ServicePlan): void {
        const store = new ServicePlanStore(plan.configuration.installationDirectory), state = SafeDirectory.open(join(store.path, '.cordis'));
        try {
            for (const required of ['launch', 'worker', 'writer.lock']) Check.require(state.entries().includes(required), 'WORKER_REPAIR_REQUIRED');
            const launch = state.directory('launch', true);
            let intent;
            try { intent = BootstrapSchemas.intent.safeParse(StrictJson.parse(launch.file('intent.json', undefined, 4096, true))); Check.require(intent.success, 'BOOTSTRAP_REPAIR_REQUIRED'); } finally { launch.close(); }
            const initial = store.read(intent.data.planId, intent.data.digest), data = BootstrapRecords.read(state, new Map([[initial.id, initial]]));
            Check.require(data?.ready && data.child && data.executable, 'WORKER_REPAIR_REQUIRED');
            const writer = state.directory('writer.lock', true);
            try {
                const owner = StrictJson.object(StrictJson.parse(writer.file('owner.json', undefined, 1024, true)));
                Check.require(owner.pid === data.child.pid && owner.ownerUid === process.getuid?.(), 'WORKER_BINDING');
                let executable;
                try { executable = statSync('/proc/' + data.child.pid + '/exe'); } catch { Check.block('WORKER_REPAIR_REQUIRED'); }
                Check.require(executable.dev === data.executable.dev && executable.ino === data.executable.ino, 'WORKER_IDENTITY_CHANGED');
                writer.verify(); state.verify();
            } finally { writer.close(); }
        } finally { state.close(); }
    }
    status(directory: string): Promise<ServiceStatus> { return new ServiceWorkerClient({ installationDirectory: directory }).status(); }
    application(directory: string, id: string): Promise<ServiceApplicationRecord> { return new ServiceWorkerClient({ installationDirectory: directory }).application(id); }
    private static spawned(child: ChildProcess, done: (value: void) => void, reject: (error: Error) => void): void { child.once('error', ServiceInstalledHost.failed.bind(null, reject)); child.once('spawn', done); }
    private static failed(reject: (error: Error) => void): void { reject(new Error('SERVICE_WORKER_START_FAILED')); }
    private static delay(done: (value: void) => void): void { setTimeout(done, 50); }
}
