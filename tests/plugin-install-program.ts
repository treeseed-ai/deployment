import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CanonicalJson, PlanningBlockedError, ServiceSchemas, type PluginInstallRequest, type PluginInstallResult, type ServiceResourceReceipt } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, ServiceHostRuntime, ServicePlanStore, ServiceWorkerOwnerClient } from '@treeseed-cordis/deployment';
import { RegistryFixture } from './source-registry-fixture.js';

interface RetainedFixture {
    receipts: Map<string, ServiceResourceReceipt>;
    files: Map<string, string>;
    listeners: string[];
    authority: string;
}
class PluginInstallProgram {
    private static hash(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
    private static delay(done: (value: void) => void): void { setTimeout(done, 50); }
    private static docker(args: string[]): string { const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 }); if (result.status !== 0) throw new Error('Fixture Docker read-back failed'); return result.stdout.trim(); }
    private static listeners(): string[] { const entries: string[] = []; for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) for (const line of readFileSync(path, 'utf8').split('\n').slice(1)) { const fields = line.trim().split(/\s+/); if (fields[3] === '0A') entries.push(path + ':' + fields[1]); } return entries.sort(); }
    private static receipts(store: ServicePlanStore): Map<string, ServiceResourceReceipt> {
        const result = new Map<string, ServiceResourceReceipt>(), snapshot = store.current();
        if (!snapshot) throw new Error('Missing active fixture snapshot');
        const all = store.resources();
        for (const binding of snapshot.resources) for (const receipt of all) if (CanonicalJson.digest(receipt) === binding.receiptDigest) result.set(receipt.resourceId, receipt);
        return result;
    }
    private static authority(receipts: Map<string, ServiceResourceReceipt>): string { for (const receipt of receipts.values()) if (receipt.kind === 'container' && receipt.serviceId === 'instance-0' && receipt.actualId) return this.hash(this.docker(['exec', receipt.actualId, 'node', '-e', "class ReadFixtureAuthority{static run(){process.stdout.write(require('node:fs').readFileSync('/data/root.crt'));}}ReadFixtureAuthority.run();"])); throw new Error('Fixture authority container missing'); }
    private static retained(store: ServicePlanStore): RetainedFixture {
        const receipts = this.receipts(store), files = new Map<string, string>();
        for (const receipt of receipts.values()) if (receipt.path && existsSync(join(store.path, receipt.path))) files.set(receipt.path, this.hash(readFileSync(join(store.path, receipt.path))));
        return { receipts, files, listeners: this.listeners(), authority: this.authority(receipts) };
    }
    private static same(store: ServicePlanStore, prior: RetainedFixture): void {
        const current = this.receipts(store);
        for (const [id, old] of prior.receipts) {
            const next = current.get(id); if (!next) throw new Error('Prior resource retired');
            const { references: before, ...left } = old, { references: after, ...right } = next;
            if (CanonicalJson.stringify(left) !== CanonicalJson.stringify(right) || after.length < before.length) throw new Error('Prior physical resource identity changed');
            if (old.kind === 'container' && old.actualId && this.docker(['container', 'inspect', '--format', '{{.State.Running}}', old.actualId]) !== 'true') throw new Error('Prior container stopped');
        }
        for (const [path, digest] of prior.files) if (this.hash(readFileSync(join(store.path, path))) !== digest) throw new Error('Prior credential or authority bytes changed');
        if (this.authority(current) !== prior.authority || CanonicalJson.stringify(this.listeners()) !== CanonicalJson.stringify(prior.listeners)) throw new Error('Prior authority or listener changed');
    }
    private static async application(owner: ServiceWorkerOwnerClient, id: string): Promise<void> {
        const deadline = Date.now() + 120000; let result = await owner.application(id);
        while (!['completed', 'failed', 'cancelled'].includes(result.phase) && Date.now() < deadline) { await new Promise(this.delay); result = await owner.application(id); }
        if (result.phase !== 'completed' || result.result !== 'ready') throw new Error('Initial fixture application failed');
    }
    private static async install(owner: ServiceWorkerOwnerClient, request: PluginInstallRequest): Promise<PluginInstallResult> {
        let result = await owner.install(request); const deadline = Date.now() + 150000;
        while (result.state === 'pending' && Date.now() < deadline) { await new Promise(this.delay); result = await owner.inspect(request.idempotencyKey); }
        return result;
    }
    private static async direct(store: ServicePlanStore, id: string): Promise<void> {
        for (const receipt of this.receipts(store).values()) if (receipt.kind === 'container' && receipt.serviceId === id && receipt.actualId) {
            const networks = JSON.parse(this.docker(['container', 'inspect', '--format', '{{json .NetworkSettings.Networks}}', receipt.actualId])) as Record<string, { IPAddress: string }>;
            let address: string | undefined; for (const network of Object.values(networks)) address = network.IPAddress;
            if (!address) throw new Error('Private fixture endpoint missing');
            const response = await fetch('http://' + address + ':8080/'), body = await response.json() as { serviceId: string; passwordPresent: boolean; volumeMarker: string };
            if (!response.ok || body.serviceId !== id || body.volumeMarker !== id || body.passwordPresent !== true) throw new Error('Installed provider failed direct private protocol');
            return;
        }
        throw new Error('Installed fixture container missing');
    }
    static async run(file: string): Promise<void> {
        const input = JSON.parse(readFileSync(file, 'utf8')), configuration = ServiceSchemas.configuration.parse(input.configuration), registry = new RegistryFixture(input.root, configuration.installationDirectory, '@fixture/extension', ['1.0.0', '2.0.0']);
        await registry.listen(); let host: ServiceHostRuntime | undefined;
        try {
            const path = join(configuration.release.directory, 'release.json'), release = JSON.parse(readFileSync(path, 'utf8'));
            release.acquisitionPolicy = { formatVersion: 1, helperReleaseIdentity: release.helpers.releaseIdentity, npm: [{ registry: registry.origin(), packages: ['@fixture/extension'], targets: ['deployment'], certificateAuthority: { path: 'source-ca.pem', sha256: this.hash(readFileSync(join(configuration.release.directory, 'source-ca.pem'))) } }], git: [], builds: [] };
            const bytes = CanonicalJson.stringify(release) + '\n'; writeFileSync(path, bytes); configuration.release.manifestDigest = this.hash(bytes);
            const plan = await new ComposeDeploymentHost().plan(configuration); if (plan.formatVersion !== 3) throw new Error('Wrong format');
            host = await ServiceHostRuntime.start(plan);
            const owner = new ServiceWorkerOwnerClient({ installationDirectory: configuration.installationDirectory }), store = new ServicePlanStore(configuration.installationDirectory);
            const initial = await owner.submit({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'initial-four' }); await this.application(owner, initial.id);
            if ((await owner.status()).services.length !== 4) throw new Error('Fixture did not start at four services');
            if (!existsSync(join(input.root, 'SCRIPT_CANARY'))) throw new Error('Initial fixture provider was not genuinely imported');
            const before = this.retained(store), request: PluginInstallRequest = { source: '@fixture/extension@1.0.0', serviceId: 'private-addon-one', idempotencyKey: 'install-private-one', installationDirectory: store.path, scope: 'installation', target: 'deployment', configuration: {} }, first = await this.install(owner, request);
            if (first.state !== 'active' || !first.planId || !first.applicationId || !first.activeGeneration || !first.acknowledgements.length || first.activeGeneration !== store.current()?.compositionGeneration) throw new Error('SAFE_CONTAINER_INSTALL_NOT_ACTIVE:' + first.state + ':' + first.blockers.map(this.code).join(','));
            this.same(store, before); await this.direct(store, 'private-addon-one');
            const current = this.retained(store), repeated = await this.install(owner, { ...request, idempotencyKey: 'already-private-one' });
            if (repeated.state !== 'already-active' || repeated.applicationId !== first.applicationId || repeated.activeGeneration !== first.activeGeneration) throw new Error('Exact selected provider was not already-active');
            const applications = store.records().length, unsafe = await this.install(owner, { ...request, source: '@fixture/extension@2.0.0', idempotencyKey: 'unsafe-state-change' });
            if (unsafe.state !== 'prepared' || unsafe.applicationId !== null || unsafe.activeGeneration !== null || !unsafe.nextActions.includes('review-migration') || store.records().length !== applications) throw new Error('Unsafe stateful replacement was activated or hidden');
            this.same(store, current);
            const second = await this.install(owner, { ...request, serviceId: 'private-addon-two', idempotencyKey: 'install-private-two' });
            if (second.state !== 'active' || (await owner.status()).services.length !== 6) throw new Error('Second typed instance did not activate');
            this.same(store, current); await this.direct(store, 'private-addon-two');
            const historical = await owner.inspect(request.idempotencyKey);
            if (['active', 'already-active'].includes(historical.state) || historical.activeGeneration !== null || historical.acknowledgements.length) throw new Error('Historical request claimed current-generation activation');
            await registry.close(); const count = registry.requests, replay = await owner.install({ ...request, serviceId: 'private-addon-two', idempotencyKey: 'install-private-two' });
            if (CanonicalJson.stringify(replay) !== CanonicalJson.stringify(second) || registry.requests !== count || !(await owner.list('installation', 'deployment')).length) throw new Error('Exact accepted install retry reopened source or changed application');
            if (registry.authorization || existsSync(join(input.root, 'MUST_NOT_RUN'))) throw new Error('Package lifecycle or credential canary executed');
            process.stdout.write(JSON.stringify({ fixtureOnly: true, services: 6, active: true, alreadyActive: true, unsafePrepared: true, retained: true, sourceFree: true, noScripts: true }) + '\n');
        } finally { await host?.close(120000); await registry.close(); }
    }
    private static code(blocker: { code: string }): string { return blocker.code; }
    static failed(error: unknown): never { if (error instanceof PlanningBlockedError) throw new Error(error.blockers.map(this.code).join(',')); throw error; }
}
await PluginInstallProgram.run(process.argv[2]!).catch(PluginInstallProgram.failed.bind(PluginInstallProgram));
