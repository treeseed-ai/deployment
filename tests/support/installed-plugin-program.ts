import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as Deployment from '@treeseed-cordis/deployment';
import { CanonicalJson, PlanningBlockedError, ServiceSchemas, type PluginInstallRequest, type PluginInstallResult } from '@treeseed-cordis/sdk';
import {InstallationSources} from './git-source-fixture.js';
class InstalledPluginProgram {
    private static phase = "plan";
    private static delay(done: (value: void) => void): void { setTimeout(done, 50); }
    private static hash(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
    static async run(file: string): Promise<void> {
        const Manager = Reflect.get(Deployment, 'InstalledPluginManager') as (new (path: string) => Deployment.PluginManager) | undefined;
        if (typeof Manager !== 'function') throw new Error('INSTALLED_PLUGIN_MANAGER_UNAVAILABLE');
        const input = JSON.parse(readFileSync(file, 'utf8')), configuration = ServiceSchemas.configuration.parse(input.configuration), registry = new InstallationSources(input,configuration.installationDirectory);
        await registry.listen(); let pid: number | undefined;
        try {
            const path = join(configuration.release.directory, 'release.json'), release = JSON.parse(readFileSync(path, 'utf8'));
            release.acquisitionPolicy=registry.policy(release.helpers.releaseIdentity,{path:'source-ca.pem',sha256:this.hash(readFileSync(join(configuration.release.directory,'source-ca.pem')))});
            const bytes = CanonicalJson.stringify(release) + '\n'; writeFileSync(path, bytes); configuration.release.manifestDigest = this.hash(bytes);
            await new Deployment.ComposeDeploymentHost().plan(configuration);
            const manager = new Manager(configuration.installationDirectory);
            if ((await manager.list()).length || existsSync(join(configuration.installationDirectory, '.cordis/control')) || existsSync(join(configuration.installationDirectory, '.cordis/credentials'))) throw new Error('Cold read launched an owner or application');
            const request: PluginInstallRequest = { source: registry.source('1.0.0'), serviceId: 'fresh-addon', idempotencyKey: 'fresh-install', installationDirectory: configuration.installationDirectory, scope: 'installation', target: 'deployment', configuration: {} };
            const alternate = await new Deployment.ComposeDeploymentHost().plan({ ...configuration, runtimeState: 'stopped' });
            if (alternate.formatVersion !== 3) throw new Error('Wrong alternate plan format');
            let ambiguous = false;
            try { await manager.install(request); } catch (error) { ambiguous = error instanceof PlanningBlockedError && error.blockers.some(this.ambiguous); }
            if (!ambiguous || existsSync(join(configuration.installationDirectory, '.cordis/launch')) || existsSync(join(configuration.installationDirectory, '.cordis/credentials'))) throw new Error('Ambiguous fresh plans started an owner');
            unlinkSync(join(configuration.installationDirectory, '.cordis/plans', alternate.id + '.json'));
            let scope = false;
            try { await manager.install({ ...request, installationDirectory: input.root }); } catch (error) { scope = error instanceof PlanningBlockedError; }
            if (!scope) throw new Error('Manager accepted another installation scope');
            this.phase = "install"; let result: PluginInstallResult = await manager.install(request);
            const writer = JSON.parse(readFileSync(join(configuration.installationDirectory, '.cordis/writer.lock/owner.json'), 'utf8')); pid = writer.pid;
            if (!pid || pid === process.pid) throw new Error('No independent durable owner');
            this.phase = "inspect"; const deadline = Date.now() + 150000;
            while (result.state === 'pending' && Date.now() < deadline) { await new Promise(this.delay); result = await manager.inspect(request.idempotencyKey); }
            if (result.state !== 'active' || !result.planId || !result.applicationId || !result.acknowledgements.length) throw new Error('FRESH_INSTALL_NOT_ACTIVE:' + result.state + ':' + result.blockers.map(this.code).join(','));
            this.phase = "status"; const owner = new Deployment.ServiceWorkerOwnerClient({ installationDirectory: configuration.installationDirectory });
            if (!(await owner.status()).ready || (await owner.status()).services.length !== 5) throw new Error('Fresh installation target readback failed');
            this.phase = "replay"; await registry.close(); const count = registry.requests, replay = await manager.install(request);
            if (CanonicalJson.stringify(replay) !== CanonicalJson.stringify(result) || registry.requests !== count) throw new Error('Fresh owner retry changed accepted request');
            this.phase = 'close'; process.kill(pid, 'SIGTERM'); const stopped = Date.now() + 15000;
            while (existsSync(join(configuration.installationDirectory, '.cordis/writer.lock')) && Date.now() < stopped) await new Promise(this.delay);
            if (existsSync(join(configuration.installationDirectory, '.cordis/writer.lock'))) throw new Error('Owner did not drain'); pid = undefined;
            this.phase = 'cold'; const cold = await manager.inspect(request.idempotencyKey);
            if (cold.state !== 'recovery-required' || cold.activeGeneration !== null || cold.acknowledgements.length || (await manager.list()).length !== 1) throw new Error('Cold read claimed current runtime health');
            let restarted = false; try { await manager.install(request); restarted = true; } catch (error) { if (!(error instanceof PlanningBlockedError)) throw error; } if (restarted || existsSync(join(configuration.installationDirectory, '.cordis/writer.lock'))) throw new Error('Stopped owner was implicitly restarted');
            if (registry.authorization || existsSync(join(input.root, 'MUST_NOT_RUN'))) throw new Error('Lifecycle or ambient credential canary executed');
            process.stdout.write(JSON.stringify({ fixtureOnly: true, freshOwner: true, active: true, sourceFree: true, noScripts: true }) + '\n');
        } catch (error) { try { const last = new Deployment.ServicePlanStore(configuration.installationDirectory).records().at(-1); process.stderr.write(JSON.stringify({ phase: this.phase, application: last?.phase, recovery: last?.recovery }) + "\n"); } catch {} throw error; } finally {
            if (!pid) { try { const child = JSON.parse(readFileSync(join(configuration.installationDirectory, '.cordis/launch/child.json'), 'utf8')), file = statSync(join(configuration.installationDirectory, '.cordis/worker')), running = statSync('/proc/' + child.pid + '/exe'); if (file.uid === process.getuid?.() && file.dev === running.dev && file.ino === running.ino) pid = child.pid; } catch {} }
            if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} const deadline = Date.now() + 15000; while (existsSync(join(configuration.installationDirectory, '.cordis/writer.lock')) && Date.now() < deadline) await new Promise(this.delay); }
            await registry.close();
        }
    }
    static failed(error: unknown): never { if (error instanceof PlanningBlockedError) throw new Error(error.blockers.map(this.code).join(',')); throw error; }
    private static ambiguous(blocker: { code: string }): boolean { return blocker.code === 'INITIAL_PLAN_AMBIGUOUS'; }
    private static code(blocker: { code: string }): string { return blocker.code; }
}
await InstalledPluginProgram.run(process.argv[2]!).catch(InstalledPluginProgram.failed.bind(InstalledPluginProgram));
