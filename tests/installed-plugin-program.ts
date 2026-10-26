import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as Deployment from '@treeseed-cordis/deployment';
import { CanonicalJson, ServiceSchemas, type PluginInstallRequest, type PluginInstallResult } from '@treeseed-cordis/sdk';
import { RegistryFixture } from './source-registry-fixture.js';
class InstalledPluginProgram {
    private static delay(done: (value: void) => void): void { setTimeout(done, 50); }
    private static hash(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
    static async run(file: string): Promise<void> {
        const Manager = Reflect.get(Deployment, 'InstalledPluginManager') as (new (path: string) => Deployment.PluginManager) | undefined;
        if (typeof Manager !== 'function') throw new Error('INSTALLED_PLUGIN_MANAGER_UNAVAILABLE');
        const input = JSON.parse(readFileSync(file, 'utf8')), configuration = ServiceSchemas.configuration.parse(input.configuration), registry = new RegistryFixture(input.root, configuration.installationDirectory, '@fixture/extension', ['1.0.0', '2.0.0']);
        await registry.listen(); let pid: number | undefined;
        try {
            const path = join(configuration.release.directory, 'release.json'), release = JSON.parse(readFileSync(path, 'utf8'));
            release.acquisitionPolicy = { formatVersion: 1, helperReleaseIdentity: release.helpers.releaseIdentity, npm: [{ registry: registry.origin(), packages: ['@fixture/extension'], targets: ['deployment'], certificateAuthority: { path: 'source-ca.pem', sha256: this.hash(readFileSync(join(configuration.release.directory, 'source-ca.pem'))) } }], git: [], builds: [] };
            const bytes = CanonicalJson.stringify(release) + '\n'; writeFileSync(path, bytes); configuration.release.manifestDigest = this.hash(bytes);
            await new Deployment.ComposeDeploymentHost().plan(configuration);
            const manager = new Manager(configuration.installationDirectory);
            if ((await manager.list()).length || existsSync(join(configuration.installationDirectory, '.cordis/control')) || existsSync(join(configuration.installationDirectory, '.cordis/credentials'))) throw new Error('Cold read launched an owner or application');
            const request: PluginInstallRequest = { source: '@fixture/extension@1.0.0', serviceId: 'fresh-addon', idempotencyKey: 'fresh-install', installationDirectory: configuration.installationDirectory, scope: 'installation', target: 'deployment', configuration: {} };
            let result: PluginInstallResult = await manager.install(request);
            const writer = JSON.parse(readFileSync(join(configuration.installationDirectory, '.cordis/writer.lock/owner.json'), 'utf8')); pid = writer.pid;
            if (!pid || pid === process.pid) throw new Error('No independent durable owner');
            const deadline = Date.now() + 150000;
            while (result.state === 'pending' && Date.now() < deadline) { await new Promise(this.delay); result = await manager.inspect(request.idempotencyKey); }
            if (result.state !== 'active' || !result.planId || !result.applicationId || !result.acknowledgements.length) throw new Error('FRESH_INSTALL_NOT_ACTIVE:' + result.state + ':' + result.blockers.map(this.code).join(','));
            const owner = new Deployment.ServiceWorkerOwnerClient({ installationDirectory: configuration.installationDirectory });
            if (!(await owner.status()).ready || (await owner.status()).services.length !== 5) throw new Error('Fresh installation target readback failed');
            await registry.close(); const count = registry.requests, replay = await manager.install(request);
            if (CanonicalJson.stringify(replay) !== CanonicalJson.stringify(result) || registry.requests !== count) throw new Error('Fresh owner retry changed accepted request');
            process.kill(pid, 'SIGTERM'); const stopped = Date.now() + 15000;
            while (existsSync(join(configuration.installationDirectory, '.cordis/writer.lock')) && Date.now() < stopped) await new Promise(this.delay);
            if (existsSync(join(configuration.installationDirectory, '.cordis/writer.lock'))) throw new Error('Owner did not drain'); pid = undefined;
            const cold = await manager.inspect(request.idempotencyKey);
            if (cold.state !== 'recovery-required' || cold.activeGeneration !== null || cold.acknowledgements.length || (await manager.list()).length !== 1) throw new Error('Cold read claimed current runtime health');
            if (registry.authorization || existsSync(join(input.root, 'MUST_NOT_RUN'))) throw new Error('Lifecycle or ambient credential canary executed');
            process.stdout.write(JSON.stringify({ fixtureOnly: true, freshOwner: true, active: true, sourceFree: true, noScripts: true }) + '\n');
        } finally {
            if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} const deadline = Date.now() + 15000; while (existsSync(join(configuration.installationDirectory, '.cordis/writer.lock')) && Date.now() < deadline) await new Promise(this.delay); }
            await registry.close();
        }
    }
    private static code(blocker: { code: string }): string { return blocker.code; }
}
await InstalledPluginProgram.run(process.argv[2]!);
