import { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, lstatSync, renameSync, linkSync, unlinkSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CanonicalJson, ServiceSchemas, PlanningBlockedError } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, ServicePlanStore, ServiceHostRuntime, ServiceWorkerOwnerClient } from '@treeseed-cordis/deployment';
import { WorkerBootstrap, BootstrapPermit } from '../../src/service-bootstrap.js';
class AliasRequest {
    private readonly socket = new Socket();
    private done = false;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private accept: (() => void) | undefined;
    private reject: ((error: Error) => void) | undefined;
    constructor(private readonly path: string, private readonly request: unknown) { }
    run(): Promise<void> { return new Promise(this.start.bind(this)); }
    private start(accept: () => void, reject: (error: Error) => void): void { this.accept = accept; this.reject = reject; this.timer = setTimeout(this.expired.bind(this), 15000); this.socket.once('data', this.finish.bind(this)); this.socket.once('close', this.finish.bind(this)); this.socket.once('error', this.finish.bind(this)); this.socket.connect(this.path, this.connected.bind(this)); }
    private connected(): void { this.socket.write(CanonicalJson.stringify(this.request) + '\n'); }
    private finish(): void { if (this.done)
        return; this.done = true; clearTimeout(this.timer); this.socket.destroy(); this.accept!(); }
    private expired(): void { if (this.done)
        return; this.done = true; this.socket.destroy(); this.reject!(new Error('Alias fixture request timed out')); }
}
class BootstrapProgram {
    private static host: ServiceHostRuntime | null = null;
    static async run(args: string[]): Promise<void> { if (args[0] === 'child') {
        const [, _directory, id, digest, nonce] = args, plan = new ServicePlanStore(_directory!).read(id!, digest!);
        await BootstrapPermit.wait(plan, nonce!, 10000);
        this.host = await ServiceHostRuntime.start(plan, { nonce: nonce! });
        process.once('SIGTERM', this.stop.bind(this));
        return;
    } const file = args[0]!, mode = args[1] ?? 'normal', configuration = ServiceSchemas.configuration.parse(JSON.parse(readFileSync(file, 'utf8'))), releaseFile = configuration.release.directory + '/release.json', release = ServiceSchemas.release.parse(JSON.parse(readFileSync(releaseFile, 'utf8'))), bytes = readFileSync(process.execPath); writeFileSync(configuration.release.directory + '/node-bootstrap-fixture', bytes); release.composition.worker = { path: 'node-bootstrap-fixture', sha256: BootstrapProgram.sha(bytes), size: bytes.length }; const content = CanonicalJson.stringify(release) + '\n'; writeFileSync(releaseFile, content); configuration.release.manifestDigest = BootstrapProgram.sha(Buffer.from(content)); const plan = await new ComposeDeploymentHost().plan(configuration); if (plan.formatVersion !== 3)
        throw new Error('Wrong format'); const bootstrap = WorkerBootstrap.prepare(plan); let child: ChildProcess | undefined; try {
        if ((lstatSync(bootstrap.executable).mode & 0o777) !== 0o500)
            throw new Error('Unsafe executable mode');
        let refused = false;
        try {
            await ServiceHostRuntime.start(plan);
        }
        catch {
            refused = true;
        }
        if (!refused)
            throw new Error('Unrelated root adopted launch');
        if (mode === 'interrupted') {
            bootstrap.close();
            let adopted = false;
            try {
                WorkerBootstrap.prepare(plan);
                adopted = true;
            }
            catch { }
            if (adopted || !existsSync(configuration.installationDirectory + '/.cordis/launch/intent.json'))
                throw new Error('Interrupted bootstrap adopted');
            const intentPath = configuration.installationDirectory + '/.cordis/launch/intent.json', intent = JSON.parse(readFileSync(intentPath, 'utf8'));
            intent.extra = 'SECRET_CANARY';
            const malformed = JSON.stringify(intent);
            writeFileSync(intentPath, malformed, { mode: 0o600 });
            let typed = false;
            try {
                new ServicePlanStore(configuration.installationDirectory).read(plan.id, plan.digest);
            }
            catch (error) {
                typed = error instanceof PlanningBlockedError && error.blockers.some(BootstrapProgram.malformed);
            }
            if (!typed || readFileSync(intentPath, 'utf8') !== malformed)
                throw new Error('Malformed bootstrap was not safely blocked');
            process.stdout.write(JSON.stringify({ fixtureOnly: true, interrupted: true, adopted: false }) + '\n');
            return;
        }
        child = spawn(bootstrap.executable, [fileURLToPath(import.meta.url), 'child', configuration.installationDirectory, plan.id, plan.digest, mode === 'wrong-nonce' ? 'wrong-nonce' : bootstrap.nonce], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG } });
        await new Promise<void>(BootstrapProgram.spawned.bind(null, child));
        await bootstrap.handoff(child.pid!);
        if (mode === 'wrong-nonce') {
            const code = await new Promise<number | null>(BootstrapProgram.exit.bind(null, child));
            if (code === 0 || existsSync(configuration.installationDirectory + '/.cordis/writer.lock') || existsSync(configuration.installationDirectory + '/.cordis/control/worker.sock'))
                throw new Error('Wrong child nonce admitted');
            process.stdout.write(JSON.stringify({ fixtureOnly: true, wrongNonceRefused: true }) + '\n');
            return;
        }
        const owner = new ServiceWorkerOwnerClient({ installationDirectory: configuration.installationDirectory }), deadline = Date.now() + 15000;
        let ready = false;
        while (Date.now() < deadline) {
            try {
                const status = await owner.status();
                if (status.ready || status.activeComposition !== null)
                    throw new Error('Bootstrap activated composition');
                ready = true;
                break;
            }
            catch { }
            await new Promise(BootstrapProgram.delay);
        }
        if (!ready)
            throw new Error('Selected child did not claim host');
        const writer = JSON.parse(readFileSync(configuration.installationDirectory + '/.cordis/writer.lock/owner.json', 'utf8')) as {
            pid: number;
        };
        if (writer.pid !== child.pid)
            throw new Error('Writer was not transferred to selected child');
        const observerPath = configuration.installationDirectory + '/.cordis/run/host.sock', controlPath = configuration.installationDirectory + '/.cordis/control/worker.sock', backup = configuration.release.directory + '/observer-socket-backup';
        renameSync(observerPath, backup);
        linkSync(controlPath, observerPath);
        try {
            await new AliasRequest(observerPath, { protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'observer-alias-canary' }).run();
        }
        finally {
            unlinkSync(observerPath);
            renameSync(backup, observerPath);
        }
        if (new ServicePlanStore(configuration.installationDirectory).records().length)
            throw new Error('Aliased observer endpoint admitted owner mutation');
        child.kill('SIGTERM');
        const code = await new Promise<number | null>(BootstrapProgram.exit.bind(null, child));
        if (code !== 0 || existsSync(configuration.installationDirectory + '/.cordis/writer.lock'))
            throw new Error('Child failed to release writer');
        process.stdout.write(JSON.stringify({ fixtureOnly: true, selectedChild: true, ready: false, writerTransferred: true }) + '\n');
    }
    finally {
        bootstrap.close();
        if (child && child.exitCode === null)
            child.kill('SIGKILL');
    } }
    private static malformed(value: {
        code: string;
    }): boolean { return value.code === 'BOOTSTRAP_REPAIR_REQUIRED'; }
    private static sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
    private static spawned(child: ChildProcess, done: (value: void) => void, reject: (error: Error) => void): void { child.once('spawn', done); child.once('error', reject); }
    private static exit(child: ChildProcess, done: (value: number | null) => void): void { if (child.exitCode !== null) {
        done(child.exitCode);
        return;
    } child.once('exit', done); }
    private static async stop(): Promise<void> { try {
        await this.host?.close(10000);
    }
    catch {
        process.exitCode = 3;
    } }
    private static delay(done: (value: void) => void): void { setTimeout(done, 50); }
}
await BootstrapProgram.run(process.argv.slice(2));
