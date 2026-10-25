import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CanonicalJson, ServiceSchemas } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, ServicePlanStore, ServiceWorkerBuild, ServiceWorkerOwnerClient } from '@treeseed-cordis/deployment';
import { WorkerBootstrap } from '../src/service-bootstrap.js';
import { createHash } from 'node:crypto';
class StandaloneWorkerProgram {
    static sha(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
    static async run(file: string): Promise<void> {
        const configuration = ServiceSchemas.configuration.parse(JSON.parse(readFileSync(file, 'utf8'))), root = dirname(file), output = join(root, 'worker-build');
        mkdirSync(output, { mode: 0o700 });
        const executable = ServiceWorkerBuild.produce(output), releaseFile = join(configuration.release.directory, 'release.json'), release = ServiceSchemas.release.parse(JSON.parse(readFileSync(releaseFile, 'utf8')));
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
        const bootstrap = WorkerBootstrap.prepare(plan);
        let child: ChildProcess | undefined, diagnostics = '';
        try {
            child = spawn(bootstrap.executable, ['--installation', configuration.installationDirectory, '--plan', plan.id, '--digest', plan.digest, '--nonce', bootstrap.nonce, '--protocol', '3'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
            child.stdout!.on('data', this.output.bind(null));
            child.stderr!.on('data', this.output.bind(null));
            await new Promise<void>(this.spawned.bind(null, child));
            await bootstrap.handoff(child.pid!);
            const owner = new ServiceWorkerOwnerClient({ installationDirectory: configuration.installationDirectory }), deadline = Date.now() + 120000;
            let connected = false;
            while (Date.now() < deadline && child.exitCode === null) {
                try { await owner.status(); connected = true; break; } catch { }
                await new Promise(this.delay);
            }
            if (!connected) throw new Error('Compiled worker did not become available: ' + child.exitCode);
            const writer = JSON.parse(readFileSync(configuration.installationDirectory + '/.cordis/writer.lock/owner.json', 'utf8'));
            if (writer.pid !== child.pid) throw new Error('Wrong standalone writer owner');
            const request = { protocol: 3 as const, operation: 'submit' as const, planId: plan.id, digest: plan.digest, idempotencyKey: 'standalone-application' }, accepted = await owner.submit(request);
            let application = await owner.application(accepted.id);
            while (!['completed', 'failed', 'cancelled'].includes(application.phase) && Date.now() < deadline) { await new Promise(this.delay); application = await owner.application(accepted.id); }
            const status = await owner.status(), store = new ServicePlanStore(configuration.installationDirectory), snapshot = store.current();
            if (application.phase !== 'completed' || application.result !== 'ready' || !status.ready || status.services.length !== 5 || !snapshot) throw new Error('Standalone application was not verified: ' + application.phase);
            rmSync(configuration.release.directory, { recursive: true });
            if ((await owner.submit(request)).id !== accepted.id || !(await owner.status()).ready) throw new Error('Standalone replay reopened source bundle');
            child.kill('SIGTERM');
            const code = await new Promise<number | null>(this.exited.bind(null, child));
            if (code !== 0 || existsSync(configuration.installationDirectory + '/.cordis/writer.lock') || existsSync(configuration.installationDirectory + '/.cordis/control/worker.sock')) throw new Error('Standalone shutdown did not drain');
            if (CanonicalJson.stringify(store.current()) !== CanonicalJson.stringify(snapshot)) throw new Error('Shutdown changed committed resources');
            for (const resource of snapshot.resources) if (resource.kind === 'container') {
                const result = spawnSync('docker', ['container', 'inspect', '--format', '{{.State.Running}}', resource.actualId!], { encoding: 'utf8' });
                if (result.status !== 0 || result.stdout.trim() !== 'true') throw new Error('Shutdown stopped an installed resource');
            }
            process.stdout.write(JSON.stringify({ fixtureOnly: true, standalone: true, ready: true, services: status.services.length, resourcesRetained: true, replayed: true, writerReleased: true }) + '\n');
        } catch (error) { diagnostics = error instanceof Error ? error.message : 'Standalone fixture failed'; throw new Error(diagnostics); }
        finally { if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise<number | null>(this.exited.bind(null, child)); } bootstrap.close(); }
    }
    private static output(bytes: Buffer): void { if (bytes.length) throw new Error('Worker emitted unexpected output'); }
    private static delay(done: (value: void) => void): void { setTimeout(done, 100); }
    private static spawned(child: ChildProcess, done: (value: void) => void, reject: (error: Error) => void): void { child.once('error', reject); child.once('spawn', done); }
    private static exited(child: ChildProcess, done: (value: number | null) => void): void { if (child.exitCode !== null) done(child.exitCode); else child.once('exit', done); }
}
await StandaloneWorkerProgram.run(process.argv[2]!);
