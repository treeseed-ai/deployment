import { readFileSync, lstatSync, existsSync, renameSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync, linkSync } from 'node:fs';
import { Socket } from 'node:net';
import { ServiceSchemas, ServiceWorkerSchemas, CanonicalJson, type ServicePlan } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, ServiceHostRuntime, ServiceWorkerClient, ServiceWorkerOwnerClient, ServicePlanStore, InstallationStore } from '@treeseed-cordis/deployment';
class RawRequest {
    private socket = new Socket();
    private bytes = Buffer.alloc(0);
    private accept: ((value: unknown) => void) | undefined;
    private reject: ((error: Error) => void) | undefined;
    constructor(private readonly path: string, private readonly request: unknown, private readonly raw?: string) { }
    run(): Promise<unknown> { return new Promise(this.start.bind(this)); }
    private start(accept: (value: unknown) => void, reject: (error: Error) => void): void { this.accept = accept; this.reject = reject; this.socket.setTimeout(10000); this.socket.once('timeout', this.fail.bind(this)); this.socket.once('error', this.fail.bind(this)); this.socket.on('data', this.data.bind(this)); this.socket.once('end', this.end.bind(this)); this.socket.connect(this.path, this.connected.bind(this)); }
    private connected(): void { this.socket.write(this.raw ?? CanonicalJson.stringify(this.request) + '\n'); }
    private data(bytes: Buffer): void { this.bytes = Buffer.concat([this.bytes, bytes]); if (this.bytes.length > 4 * 1024 * 1024)
        this.fail(); }
    private end(): void { try {
        this.accept!(ServiceWorkerSchemas.response.parse(JSON.parse(this.bytes.toString())));
        this.socket.destroy();
    }
    catch {
        this.fail();
    } }
    private fail(): void { this.socket.destroy(); this.reject!(new Error('Fixture RPC failed')); }
}
class LostResponse {
    private readonly socket = new Socket();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private accept: (() => void) | undefined;
    private reject: ((error: Error) => void) | undefined;
    private done = false;
    constructor(private readonly path: string, private readonly request: unknown) { }
    run(): Promise<void> { return new Promise(this.start.bind(this)); }
    private start(accept: () => void, reject: (error: Error) => void): void { this.accept = accept; this.reject = reject; this.timer = setTimeout(this.failed.bind(this), 10000); this.socket.once('error', this.failed.bind(this)); this.socket.once('end', this.failed.bind(this)); this.socket.once('data', this.received.bind(this)); this.socket.connect(this.path, this.connected.bind(this)); }
    private connected(): void { this.socket.write(CanonicalJson.stringify(this.request) + '\n'); }
    private received(): void { if (this.done)
        return; this.done = true; clearTimeout(this.timer); this.socket.destroy(); this.accept!(); }
    private failed(): void { if (this.done)
        return; this.done = true; clearTimeout(this.timer); this.socket.destroy(); this.reject!(new Error('Fixture lost-response setup failed')); }
}
class PartialStart {
    private static original = InstallationStore.mkdir;
    private static conflict = '';
    static async run(plan: ServicePlan): Promise<void> { this.conflict = plan.configuration.installationDirectory + '/.cordis/control/foreign.txt'; InstallationStore.mkdir = this.mkdir.bind(this); let refused = false; try {
        await ServiceHostRuntime.start(plan);
    }
    catch {
        refused = true;
    }
    finally {
        InstallationStore.mkdir = this.original;
    } if (!refused || existsSync(plan.configuration.installationDirectory + '/.cordis/run/host.sock'))
        throw new Error('Failed initialization retained a known listener'); if (readFileSync(this.conflict, 'utf8') !== 'foreign')
        throw new Error('Failed initialization removed foreign state'); if (existsSync(plan.configuration.installationDirectory + '/.cordis/writer.lock'))
        throw new Error('Failed initialization retained writer'); process.stdout.write(JSON.stringify({ fixtureOnly: true, refused: true, observerClosed: true, foreignPreserved: true }) + '\n'); }
    private static mkdir(parent: Parameters<typeof InstallationStore.mkdir>[0], name: string): ReturnType<typeof InstallationStore.mkdir> { if (name === 'control') {
        mkdirSync(parent.childPath(name), { mode: 0o700 });
        writeFileSync(this.conflict, 'foreign', { mode: 0o600 });
    } return this.original.call(InstallationStore, parent, name); }
}
class HostProgram {
    static async run(file: string, mode = 'normal'): Promise<void> { const configuration = ServiceSchemas.configuration.parse(JSON.parse(readFileSync(file, 'utf8')));if(mode==='alias-check')configuration.runtimeState='stopped';const plan=await new ComposeDeploymentHost().plan(configuration); if (plan.formatVersion !== 3)
        throw new Error('Wrong format'); if (mode === 'partial-start') {
        await PartialStart.run(plan);
        return;
    } const host = await ServiceHostRuntime.start(plan), observerPath = configuration.installationDirectory + '/.cordis/run/host.sock', controlPath = configuration.installationDirectory + '/.cordis/control/worker.sock', observer = new ServiceWorkerClient({ installationDirectory: configuration.installationDirectory }), owner = new ServiceWorkerOwnerClient({ installationDirectory: configuration.installationDirectory }); try {
        if(mode==='alias-check'){const backup=configuration.release.directory+'/observer-socket-backup';renameSync(observerPath,backup);linkSync(controlPath,observerPath);let refused=false;try{try{const result=ServiceWorkerSchemas.response.parse(await new RawRequest(observerPath,{protocol:3,operation:'submit',planId:plan.id,digest:plan.digest,idempotencyKey:'observer-alias-canary'}).run());refused=!result.success;}catch{refused=true;}}finally{unlinkSync(observerPath);renameSync(backup,observerPath);}const count=new ServicePlanStore(configuration.installationDirectory).records().length;if(!refused||count!==0)throw new Error('Aliased observer endpoint admitted owner mutation');process.stdout.write(JSON.stringify({fixtureOnly:true,refused:true,acceptedApplications:0})+'\n');return;}
        for (const path of [observerPath, controlPath])
            if ((lstatSync(path).mode & 0o777) !== 0o600)
                throw new Error('Unsafe socket mode');
        const before = await observer.status();
        if (before.ready || before.activeComposition !== null)
            throw new Error('Unapplied host claimed ready');
        const request = { protocol: 3 as const, operation: 'submit' as const, planId: plan.id, digest: plan.digest, idempotencyKey: 'host-socket-fixture' }, denied = ServiceWorkerSchemas.response.parse(await new RawRequest(observerPath, request).run());
        if (denied.success || new ServicePlanStore(configuration.installationDirectory).records().length)
            throw new Error('Observer admitted mutation');
        for (const raw of ['{\"protocol\":3,\"operation\":\"status\",\"operation\":\"submit\",\"secret\":\"SECRET_CANARY\"}\n', '{\"protocol\":3,\"operation\":\"status\"}\n{}\n']) {
            const invalid = ServiceWorkerSchemas.response.parse(await new RawRequest(observerPath, {}, raw).run());
            if (invalid.success || CanonicalJson.stringify(invalid).includes('SECRET_CANARY'))
                throw new Error('Unsafe invalid frame');
        }
        await new LostResponse(controlPath, request).run();
        const intent = new ServicePlanStore(configuration.installationDirectory).records()[0];
        if (!intent || intent.idempotencyKey !== request.idempotencyKey)
            throw new Error('Lost response lacked durable intent');
        const accepted = await owner.submit(request), again = await owner.submit(request);
        if (accepted.id !== intent.id)
            throw new Error('Lost response changed accepted intent');
        if (accepted.id !== again.id)
            throw new Error('Duplicate RPC application');
        let application = await observer.application(accepted.id);
        const deadline = Date.now() + 120000;
        while (!['completed', 'failed'].includes(application.phase) && Date.now() < deadline) {
            await new Promise(HostProgram.delay);
            application = await owner.application(accepted.id);
        }
        if (application.phase !== 'completed' || application.result !== 'ready' || !(await observer.status()).ready)
            throw new Error('RPC composition not ready');
        const original = observerPath + '.original', canary = configuration.installationDirectory + '/.cordis/run/foreign.txt';
        renameSync(observerPath, original);
        writeFileSync(canary, 'keep', { mode: 0o600 });
        symlinkSync(canary, observerPath);
        let refused = false;
        try {
            await host.close();
        }
        catch {
            refused = true;
        }
        if (!refused || readFileSync(canary, 'utf8') !== 'keep' || !lstatSync(observerPath).isSymbolicLink())
            throw new Error('Foreign socket entry removed');
        unlinkSync(observerPath);
        renameSync(original, observerPath);
        unlinkSync(canary);
        await host.close();
        if (existsSync(observerPath) || existsSync(controlPath) || existsSync(configuration.installationDirectory + '/.cordis/writer.lock'))
            throw new Error('Host transport not closed');
        let reopened = false;
        try {
            await ServiceHostRuntime.start(plan);
            reopened = true;
        }
        catch { }
        if (reopened)
            throw new Error('Prior runtime adopted');
        process.stdout.write(JSON.stringify({ fixtureOnly: true, applicationId: application.id, ready: true, observerRefused: true, closed: true }) + '\n');
    }
    finally {
        await host.close();
    } }
    private static delay(done: (value: void) => void): void { setTimeout(done, 50); }
}
await HostProgram.run(process.argv[2]!, process.argv[3]);
