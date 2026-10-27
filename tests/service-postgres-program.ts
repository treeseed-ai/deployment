import { createServer, type Server, type Socket } from 'node:net';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { CanonicalJson, ServiceSchemas, ServiceTokens, type ProbeContext, type ServicePlan } from '@treeseed-cordis/sdk';
import { CordisComposition, type Context, type CompositionHandle } from '@treeseed-cordis/sdk/runtime';
import { ComposeDeploymentHost, ServiceApplicationRuntime, ServicePlanStore, ServiceCredentials, ServiceRuntimeInspection, PostgresReadinessPlugin } from '@treeseed-cordis/deployment';
class ProbeReceiver { context?: Context; }
class ProbeConsumer { static readonly inject = ['probe.service']; constructor(context: Context, receiver: ProbeReceiver) { receiver.context = context; } }
/** Explicit observation-input fixture for authentication/cancellation negatives only. */
class PostgresProbeInput implements ProbeContext {
    readonly authorityIds: string[] = [];
    readonly credentialReferences: string[];
    readonly expected: ProbeContext['expected'];
    readonly deadline = Date.now() + 5000;
    reads = 0;
    constructor(readonly serviceId: string, readonly endpoint: string, readonly signal: AbortSignal, plan: ServicePlan, private readonly password: Buffer) { this.credentialReferences = ['secret://' + serviceId + '/database-password']; this.expected = { installationId: plan.configuration.installationId, compositionGeneration: plan.compositionGeneration, serviceGeneration: plan.changes.find(PostgresProbeInput.named.bind(null, serviceId))!.serviceGeneration, assetDigest: plan.composition.assetDigest }; }
    private static named(id: string, item: { serviceId: string }): boolean { return item.serviceId === id; }
    async credential(reference: string): Promise<Uint8Array> { this.reads++; if (!this.credentialReferences.includes(reference)) throw new Error('Foreign credential'); return Buffer.from(this.password); }
    async authority(_reference: string): Promise<Uint8Array> { throw new Error('No authority grant'); }
}
/** Controlled protocol stall for in-flight cancellation; no PostgreSQL impersonation claim. */
class PostgresHandshakeStall {
    private readonly server: Server = createServer(this.connected.bind(this));
    private readonly sockets = new Set<Socket>();
    private accepted: ((port: number) => void) | null = null;
    private closed: ((value: void) => void) | null = null;
    connections = 0;
    get pending(): number { return this.sockets.size; }
    start(): Promise<number> { return new Promise(this.listen.bind(this)); }
    private listen(accept: (port: number) => void, reject: (error: Error) => void): void { this.accepted = accept; this.server.once('error', reject); this.server.listen(0, '127.0.0.1', this.listening.bind(this)); }
    private listening(): void { const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('Missing stall endpoint'); this.accepted!(address.port); }
    private connected(socket: Socket): void { this.connections++; this.sockets.add(socket); socket.once('close', this.disconnected.bind(this, socket)); socket.resume(); }
    private disconnected(socket: Socket): void { this.sockets.delete(socket); }
    close(): Promise<void> { return new Promise(this.closing.bind(this)); }
    private closing(done: (value: void) => void): void { this.closed = done; for (const socket of this.sockets) socket.destroy(); this.server.close(this.finished.bind(this)); }
    private finished(): void { this.closed!(); }
}
class PostgresServiceProgram {
    static async run(file: string): Promise<void> {
        const configuration = ServiceSchemas.configuration.parse(JSON.parse(readFileSync(file, 'utf8'))), plan = await new ComposeDeploymentHost().plan(configuration);
        if (plan.formatVersion !== 3 || existsSync(configuration.release.directory + '/../POSTGRES_IMPORT_CANARY')) throw new Error('Planning imported provider or used wrong format');
        const runtime = await ServiceApplicationRuntime.start(plan); let handle: CompositionHandle | null = null;
        try {
            const accepted = await runtime.submit({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'postgres-default-program' }), until = Date.now() + 120000;
            let application = await runtime.application(accepted.id);
            while (!['completed', 'failed', 'cancelled'].includes(application.phase) && Date.now() < until) { await new Promise(this.delay); application = await runtime.application(accepted.id); }
            const status = await runtime.status(); if (application.phase !== 'completed' || !status.ready || status.services.length !== 2 || !existsSync(configuration.release.directory + '/../POSTGRES_IMPORT_CANARY')) throw new Error('Default Postgres composition did not qualify');
            const store = new ServicePlanStore(configuration.installationDirectory), resources = store.resources(), volumes = resources.filter(this.volume), first = plan.composition.services[0]!, second = plan.composition.services[1]!, credentials = new ServiceCredentials(plan), password = credentials.read(first.serviceId, 'secret://' + first.serviceId + '/database-password'), own = credentials.read(second.serviceId, 'secret://' + second.serviceId + '/database-password');
            if (volumes.length !== 2 || volumes[0]!.actualId === volumes[1]!.actualId || password.equals(own)) throw new Error('Postgres instances share private state');
            const token = ServiceTokens.probe(), scopeId = 'postgres-probe-negative';
            handle = await CordisComposition.start({ registrations: [{ token, plugin: PostgresReadinessPlugin, declaration: PostgresReadinessPlugin.declaration, configuration: {}, artifact: { kind: 'bundled', identity: 'explicit-postgres-negative-fixture' } }], selections: [{ scopeId, capability: token.id, providerId: PostgresReadinessPlugin.declaration.id }] }, { scopeId, target: 'deployment', principalId: 'fixture', resourceScope: configuration.installationDirectory });
            const receiver = new ProbeReceiver(); await handle.mount(ProbeConsumer, receiver); const lease = await handle.locator(receiver.context!).acquire(token);
            try {
                const target = await new ServiceRuntimeInspection(plan).service(second.serviceId), foreign = new PostgresProbeInput(second.serviceId, target.endpoint, new AbortController().signal, plan, password), denied = await lease.value.observe(foreign);
                if (denied.ready || foreign.reads !== 1 || JSON.stringify(denied).includes(password.toString())) throw new Error('Foreign password accepted or exposed');
                const valid = new PostgresProbeInput(second.serviceId, target.endpoint, new AbortController().signal, plan, own); if (!(await lease.value.observe(valid)).ready) throw new Error('Same probe contract failed valid credentials');
                const abort = new AbortController(); abort.abort(); const cancelled = new PostgresProbeInput(second.serviceId, target.endpoint, abort.signal, plan, own); if ((await lease.value.observe(cancelled)).ready || cancelled.reads !== 0) throw new Error('Cancelled probe accessed credentials');
                const stall = new PostgresHandshakeStall(); const port = await stall.start(), interrupt = new AbortController(), pending = new PostgresProbeInput(second.serviceId, 'tcp://127.0.0.1:' + port + '/', interrupt.signal, plan, own), started = Date.now(), timer = setTimeout(interrupt.abort.bind(interrupt), 100);
                try { if ((await lease.value.observe(pending)).ready || Date.now() - started > 2000 || pending.reads !== 1 || stall.connections !== 1) throw new Error('In-flight cancellation failed'); const drained = Date.now() + 1000; while (stall.pending && Date.now() < drained) await new Promise(this.delay); if (stall.pending) throw new Error('Cancelled SQL connection leaked'); } finally { clearTimeout(timer); await stall.close(); }

            } finally { await lease.release(); }
            const before = CanonicalJson.stringify({ resources: store.resources(), current: store.current() }); rmSync(configuration.release.directory, { recursive: true }); if (!(await runtime.status()).ready || before !== CanonicalJson.stringify({ resources: store.resources(), current: store.current() })) throw new Error('Postgres status reopened source or changed state');
            process.stdout.write(JSON.stringify({ fixtureOnly: true, ready: true, instances: 2, distinctState: true, wrongPasswordDenied: true, cancelled: true, inflightCancelled: true, sourceFree: true }) + '\n');
        } finally { await handle?.dispose(); await runtime.close(); }
    }
    private static volume(resource: { kind: string }): boolean { return resource.kind === 'volume'; }
    private static delay(done: (value: void) => void): void { setTimeout(done, 100); }
}
await PostgresServiceProgram.run(process.argv[2]!);
