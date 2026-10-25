import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync, rmSync, chmodSync, openSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CanonicalJson, ServiceSchemas } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, ServicePlanStore, ServiceWorkerBuild, ServiceWorkerOwnerClient } from '@treeseed-cordis/deployment';
import { WorkerBootstrap } from '../src/service-bootstrap.js';
import { createHash } from 'node:crypto';
class StandaloneWorkerProgram {
    private static outputSeen = false;
    private static phase = 'build';
    static sha(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
    static async run(file: string): Promise<void> {
        const configuration = ServiceSchemas.configuration.parse(JSON.parse(readFileSync(file, 'utf8'))), root = dirname(file), output = join(root, 'worker-build');
        mkdirSync(output, { mode: 0o700 });
        const executable = ServiceWorkerBuild.produce(output), releaseFile = join(configuration.release.directory, 'release.json'), release = ServiceSchemas.release.parse(JSON.parse(readFileSync(releaseFile, 'utf8')));
        let overwriteRefused = false;
        try { ServiceWorkerBuild.produce(output); } catch { overwriteRefused = true; }
        if (!overwriteRefused || this.sha(readFileSync(join(output, executable.path))) !== executable.sha256) throw new Error('Producer overwrote or adopted existing output');
        writeFileSync(join(configuration.release.directory, 'standalone-worker'), readFileSync(join(output, executable.path)));
        release.composition.worker = { ...executable, path: 'standalone-worker' };
        const bytes = Buffer.from(CanonicalJson.stringify(release) + '\n');
        writeFileSync(releaseFile, bytes);
        configuration.release.manifestDigest = this.sha(bytes);
        const plan = await new ComposeDeploymentHost().plan(configuration);
        if (plan.formatVersion !== 3) throw new Error('Wrong saved plan format');
        const docker = spawnSync('which', ['docker'], { encoding: 'utf8' });
        if (docker.status !== 0 || !docker.stdout.trim().startsWith('/')) throw new Error('Missing Docker prerequisite');
        const path = join(root, 'docker-only');
        mkdirSync(path, { mode: 0o700 });
        symlinkSync(docker.stdout.trim(), join(path, 'docker'));
        const environment = { PATH: path, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG }, buildPath = join(output, executable.path);
        const invalid = spawnSync(buildPath, ['--protocol', '2'], { env: environment, encoding: 'utf8', timeout: 10000 });
        if (invalid.status !== 2 || invalid.stdout || invalid.stderr || existsSync(configuration.installationDirectory + '/.cordis/writer.lock')) throw new Error('Invalid worker arguments had effects or raw output');
        const unclaimed = spawnSync(buildPath, ['--installation', configuration.installationDirectory, '--plan', plan.id, '--digest', plan.digest, '--nonce', 'd8ada480-0843-4170-9476-e069cc5ac055', '--protocol', '3'], { env: environment, encoding: 'utf8', timeout: 15000 });
        if (unclaimed.status !== 3 || unclaimed.stdout || unclaimed.stderr || existsSync(configuration.installationDirectory + '/.cordis/writer.lock')) throw new Error('Unclaimed standalone worker performed effects');
        const bootstrap = WorkerBootstrap.prepare(plan);
        let child: ChildProcess | undefined;
        try {
            child = spawn(bootstrap.executable, ['--installation', configuration.installationDirectory, '--plan', plan.id, '--digest', plan.digest, '--nonce', bootstrap.nonce, '--protocol', '3'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
            child.stdout!.on('data', this.output.bind(this));
            child.stderr!.on('data', this.output.bind(this));
            await new Promise<void>(this.spawned.bind(null, child));
            await bootstrap.handoff(child.pid!);
            const owner = new ServiceWorkerOwnerClient({ installationDirectory: configuration.installationDirectory }), deadline = Date.now() + 120000;
            this.phase = 'connect';
            let connected = false;
            while (Date.now() < deadline && child.exitCode === null) {
                try { await owner.status(); connected = true; break; } catch { }
                await new Promise(this.delay);
            }
            if (!connected) throw new Error('Compiled worker did not become available: ' + child.exitCode);
            const writer = JSON.parse(readFileSync(configuration.installationDirectory + '/.cordis/writer.lock/owner.json', 'utf8'));
            if (writer.pid !== child.pid) throw new Error('Wrong standalone writer owner');
            const request = { protocol: 3 as const, operation: 'submit' as const, planId: plan.id, digest: plan.digest, idempotencyKey: 'standalone-application' }, accepted = await owner.submit(request);
            this.phase = 'application';
            let application = await owner.application(accepted.id);
            while (!['completed', 'failed', 'cancelled'].includes(application.phase) && Date.now() < deadline) { await new Promise(this.delay); application = await owner.application(accepted.id); }
            this.phase = 'ready-status';
            const status = await owner.status(), store = new ServicePlanStore(configuration.installationDirectory), snapshot = store.current();
            if (application.phase !== 'completed' || application.result !== 'ready' || !status.ready || status.services.length !== 5 || !snapshot) throw new Error('Standalone application was not verified: ' + application.phase);
            let textBusy = false;
            chmodSync(bootstrap.executable, 0o700);
            try { const fd = openSync(bootstrap.executable, 'r+'); closeSync(fd); } catch (error) { textBusy = (error as NodeJS.ErrnoException).code === 'ETXTBSY'; }
            finally { chmodSync(bootstrap.executable, 0o500); }
            if (!textBusy) throw new Error('Running executable inode was writable');
            const savedExecutable = join(root, 'retained-running-worker');
            renameSync(bootstrap.executable, savedExecutable);
            writeFileSync(bootstrap.executable, readFileSync(buildPath), { mode: 0o500 });
            let replacementRefused = false;
            try { await owner.status(); } catch { replacementRefused = true; }
            finally { unlinkSync(bootstrap.executable); renameSync(savedExecutable, bootstrap.executable); }
            if (!replacementRefused || !(await owner.status()).ready) throw new Error('Replaced executable identity was adopted');
            rmSync(configuration.release.directory, { recursive: true });
            this.phase = 'source-free-replay';
            if ((await owner.submit(request)).id !== accepted.id || !(await owner.status()).ready) throw new Error('Standalone replay reopened source bundle');
            child.kill('SIGTERM');
            this.phase = 'shutdown';
            const code = await new Promise<number | null>(this.exited.bind(null, child));
            if (code !== 0 || existsSync(configuration.installationDirectory + '/.cordis/writer.lock') || existsSync(configuration.installationDirectory + '/.cordis/control/worker.sock')) throw new Error('Standalone shutdown did not drain');
            if (CanonicalJson.stringify(store.current()) !== CanonicalJson.stringify(snapshot)) throw new Error('Shutdown changed committed resources');
            if (this.outputSeen) throw new Error('Worker emitted unexpected output');
            for (const resource of store.resources()) if (resource.kind === 'container') {
                const result = spawnSync('docker', ['container', 'inspect', '--format', '{{.State.Running}}', resource.actualId!], { encoding: 'utf8' });
                if (result.status !== 0 || result.stdout.trim() !== 'true') throw new Error('Shutdown stopped an installed resource');
            }
            process.stdout.write(JSON.stringify({ fixtureOnly: true, standalone: true, ready: true, services: status.services.length, resourcesRetained: true, replayed: true, writerReleased: true }) + '\n');
        } catch (error) { const records = new ServicePlanStore(configuration.installationDirectory).records(); throw new Error('Standalone phase ' + this.phase + ', application ' + (records.at(-1)?.phase ?? 'none') + ', output ' + this.outputSeen + ': ' + (error instanceof Error ? error.message : 'failure')); }
        finally { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise<number | null>(this.exited.bind(null, child)); } bootstrap.close(); }
    }
    private static output(bytes: Buffer): void { if (bytes.length) this.outputSeen = true; }
    private static delay(done: (value: void) => void): void { setTimeout(done, 100); }
    private static spawned(child: ChildProcess, done: (value: void) => void, reject: (error: Error) => void): void { child.once('error', reject); child.once('spawn', done); }
    private static exited(child: ChildProcess, done: (value: number | null) => void): void { if (child.exitCode !== null || child.signalCode !== null) done(child.exitCode); else child.once('exit', done); }
}
await StandaloneWorkerProgram.run(process.argv[2]!);
