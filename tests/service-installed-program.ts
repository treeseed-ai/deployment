import { readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanonicalJson, ServiceSchemas, PlanningBlockedError } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, ServiceWorkerBuild, ServicePlanStore, ServiceWorkerClient } from '@treeseed-cordis/deployment';
import { createHash } from 'node:crypto';
class InstalledHostProgram {
    private static worker: { pid: number; dev: number; ino: number } | null = null;
    static sha(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
    static async run(file: string, mode: string): Promise<void> {
        const configuration = ServiceSchemas.configuration.parse(JSON.parse(readFileSync(file, 'utf8'))), root = dirname(file), releasePath = join(configuration.release.directory, 'release.json'), release = ServiceSchemas.release.parse(JSON.parse(readFileSync(releasePath, 'utf8')));
        if (mode === 'script') {
            const bytes = Buffer.from('#!/bin/sh\n: > SCRIPT_EXECUTED\n');
            writeFileSync(join(configuration.release.directory, 'script-worker'), bytes);
            release.composition.worker = { path: 'script-worker', sha256: this.sha(bytes), size: bytes.length };
        } else {
            const output = join(root, 'worker-build');
            mkdirSync(output, { mode: 0o700 });
            const descriptor = ServiceWorkerBuild.produce(output);
            writeFileSync(join(configuration.release.directory, 'compiled-worker'), readFileSync(join(output, descriptor.path)));
            release.composition.worker = { ...descriptor, path: 'compiled-worker' };
        }
        const bytes = Buffer.from(CanonicalJson.stringify(release) + '\n');
        writeFileSync(releasePath, bytes);
        configuration.release.manifestDigest = this.sha(bytes);
        const host = new ComposeDeploymentHost(), plan = await host.plan(configuration);
        if (plan.formatVersion !== 3) throw new Error('Wrong saved format');
        const options = { installationDirectory: configuration.installationDirectory, idempotencyKey: 'default-host-application' }, input = join(root, 'apply-input.json');
        writeFileSync(input, JSON.stringify({ planId: plan.id, digest: plan.digest, options }));
        if (mode === 'script') {
            let refused = false;
            try { await host.apply(plan.id, plan.digest, options); } catch (error) { refused = error instanceof PlanningBlockedError && error.blockers.some(this.executable); }
            if (!refused || existsSync(configuration.installationDirectory + '/.cordis/launch') || existsSync(configuration.installationDirectory + '/.cordis/worker') || existsSync(configuration.installationDirectory + '/.cordis/SCRIPT_EXECUTED')) throw new Error('Script worker was not refused before effects');
            process.stdout.write(JSON.stringify({ fixtureOnly: true, scriptRefused: true }) + '\n');
            return;
        }
        const client = join(root, 'compiled-client'), build = spawnSync('bun', ['build', fileURLToPath(new URL('./service-installed-client.js', import.meta.url)), '--compile', '--target=bun-linux-x64', '--outfile', client], { encoding: 'utf8', timeout: 120000 });
        if (build.status !== 0) throw new Error('Client fixture compilation failed');
        const docker = spawnSync('which', ['docker'], { encoding: 'utf8' }), only = join(root, 'docker-only');
        if (docker.status !== 0 || !docker.stdout.trim().startsWith('/')) throw new Error('Missing Docker prerequisite');
        mkdirSync(only, { mode: 0o700 }); symlinkSync(docker.stdout.trim(), join(only, 'docker'));
        const prior = process.env.PATH;
        process.env.PATH = only;
        try {
            const first = spawnSync(client, [input], { env: { PATH: only, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG }, encoding: 'utf8', timeout: 30000 });
            if (first.status !== 0) throw new Error('Compiled default caller failed: ' + first.stderr);
            const accepted = JSON.parse(first.stdout), owner = JSON.parse(readFileSync(configuration.installationDirectory + '/.cordis/writer.lock/owner.json', 'utf8')), executable = statSync(configuration.installationDirectory + '/.cordis/worker'), running = statSync('/proc/' + owner.pid + '/exe');
            if (running.dev !== executable.dev || running.ino !== executable.ino) throw new Error('Wrong launched process identity');
            this.worker = { pid: owner.pid, dev: running.dev, ino: running.ino };
            const repeated = await new ComposeDeploymentHost().apply(plan.id, plan.digest, options);
            if (repeated.id !== accepted.id) throw new Error('Exited caller request was repeated');
            const deadline = Date.now() + 120000;
            let application = ServiceSchemas.applicationRecord.parse(await host.application(configuration.installationDirectory, accepted.id));
            while (!['completed', 'failed', 'cancelled'].includes(application.phase) && Date.now() < deadline) { await new Promise(this.delay); application = ServiceSchemas.applicationRecord.parse(await host.application(configuration.installationDirectory, accepted.id)); }
            const status = ServiceSchemas.status.parse(await host.status(configuration.installationDirectory)), store = new ServicePlanStore(configuration.installationDirectory), snapshot = store.current();
            if (application.phase !== 'completed' || !status.ready || status.services.length !== 5 || !snapshot) throw new Error('Default host application not ready');
            const observer = new ServiceWorkerClient({ installationDirectory: configuration.installationDirectory }), beforeObservations = CanonicalJson.stringify({ applications: store.records(), resources: store.resources(), snapshot: store.current() });
            for (const service of plan.composition.services) {
                const context = await observer.observationContext(service.serviceId), change = plan.changes.find(InstalledHostProgram.named.bind(null, service.serviceId));
                if (context.identity.serviceId !== service.serviceId || context.identity.compositionGeneration !== plan.compositionGeneration || context.identity.serviceGeneration !== change?.serviceGeneration || context.identity.runtime !== null || context.dependencies.length || Object.hasOwn(context, 'ready')) throw new Error('Invalid accepted observation context');
            }
            let missingRefused = false;
            try { await observer.observationContext('missing'); } catch (error) { missingRefused = error instanceof PlanningBlockedError; }
            if (!missingRefused || beforeObservations !== CanonicalJson.stringify({ applications: store.records(), resources: store.resources(), snapshot: store.current() })) throw new Error('Observation changed records or accepted an unknown service');
            rmSync(configuration.release.directory, { recursive: true });
            if ((await host.apply(plan.id, plan.digest, options)).id !== accepted.id || !ServiceSchemas.status.parse(await host.status(configuration.installationDirectory)).ready) throw new Error('Default host reopened source');
            if ((await observer.observationContext(plan.composition.services[0]!.serviceId)).identity.compositionGeneration !== plan.compositionGeneration) throw new Error('Observation reopened source');
            this.signal('SIGTERM');
            const closeDeadline = Date.now() + 15000;
            while (existsSync(configuration.installationDirectory + '/.cordis/writer.lock') && Date.now() < closeDeadline) await new Promise(this.delay);
            if (existsSync(configuration.installationDirectory + '/.cordis/writer.lock') || CanonicalJson.stringify(store.current()) !== CanonicalJson.stringify(snapshot)) throw new Error('Worker did not preserve committed resources on close');
            let restart = false;
            try { await host.apply(plan.id, plan.digest, options); restart = true; } catch (error) { if (!(error instanceof PlanningBlockedError)) throw error; }
            if (restart || existsSync(configuration.installationDirectory + '/.cordis/writer.lock')) throw new Error('Stopped worker was implicitly restarted');
            process.stdout.write(JSON.stringify({ fixtureOnly: true, ready: true, services: status.services.length, sameApplication: true, noRestart: true, observationVerified: true }) + '\n');
        } finally {
            if (!this.worker) {
                try {
                    const child = JSON.parse(readFileSync(configuration.installationDirectory + '/.cordis/launch/child.json', 'utf8')), file = statSync(configuration.installationDirectory + '/.cordis/worker'), executable = statSync('/proc/' + child.pid + '/exe');
                    if (file.dev === executable.dev && file.ino === executable.ino && file.uid === process.getuid?.()) this.worker = { pid: child.pid, dev: executable.dev, ino: executable.ino };
                } catch { }
            }
            this.signal('SIGKILL'); process.env.PATH = prior;
        }
    }
    private static signal(signal: NodeJS.Signals): void { if (!this.worker) return; try { const stat = statSync('/proc/' + this.worker.pid + '/exe'); if (stat.dev === this.worker.dev && stat.ino === this.worker.ino) process.kill(this.worker.pid, signal); } catch { } }
    private static executable(blocker: { code: string }): boolean { return blocker.code === 'WORKER_EXECUTABLE'; }
    private static named(id: string, value: { serviceId: string }): boolean { return value.serviceId === id; }
    private static delay(done: (value: void) => void): void { setTimeout(done, 100); }
}
await InstalledHostProgram.run(process.argv[2]!, process.argv[3]!);
