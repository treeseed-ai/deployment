import * as Deployment from '@treeseed-cordis/deployment';
import { CanonicalJson, PlanningBlockedError, type ServicePlan, type PluginInstallRequest, type PluginRequestRecord } from '@treeseed-cordis/sdk';
import { readFileSync, rmSync, readdirSync, statSync, writeFileSync, chmodSync, renameSync, symlinkSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
interface Registry {
    begin(request: PluginInstallRequest, policyDigest: string, expectedGeneration: string | null): {
        record: PluginRequestRecord;
        fresh: boolean;
    };
    append(record: PluginRequestRecord): PluginRequestRecord;
    records(): PluginRequestRecord[];
}
class PluginRegistryProgram {
    static async run(file: string): Promise<void> {
        const configuration = JSON.parse(readFileSync(file, 'utf8')), plan = await new Deployment.ComposeDeploymentHost().plan(configuration);
        if (plan.formatVersion !== 3)
            throw new Error('Wrong plan format');
        const store = new Deployment.ServicePlanStore(configuration.installationDirectory), writer = store.writer();
        try {
            const constructor = Reflect.get(Deployment, 'PluginRequestStore') as new (plan: ServicePlan, heldWriter: typeof writer) => Registry;
            if (typeof constructor !== 'function')
                throw new Error('PLUGIN_REQUEST_CUSTODY_UNAVAILABLE');
            const registry = new constructor(plan, writer), request: PluginInstallRequest = { source: '@fixture/plugin@latest', installationDirectory: configuration.installationDirectory, scope: 'installation', target: 'deployment', idempotencyKey: 'lost-reply-one', configuration: {} }, policy = 'a'.repeat(64);
            const first = registry.begin(request, policy, null);
            if (!first.fresh || first.record.stage !== 'received' || first.record.expectedGeneration !== null)
                throw new Error('Initial intent missing');
            const before = CanonicalJson.stringify(registry.records());
            this.refused(registry.begin.bind(registry, request, 'e'.repeat(64), null));
            this.refused(registry.begin.bind(registry, { ...request, installationDirectory: '/tmp/foreign-plugin-scope' }, policy, null));
            this.refused(registry.append.bind(registry, { ...first.record, sequence: 2, stage: 'resolving' }));
            this.refused(registry.append.bind(registry, { ...first.record, expectedGeneration: 'e'.repeat(64), sequence: 1, stage: 'resolving' }));
            let refused = false;
            try {
                registry.begin({ ...request, source: '@fixture/changed' }, policy, null);
            }
            catch {
                refused = true;
            }
            if (!refused || before !== CanonicalJson.stringify(registry.records()))
                throw new Error('Conflicting retry changed accepted intent');
            if (registry.begin(request, policy, 'b'.repeat(64)).fresh)
                throw new Error('Retry did not recover pinned generation');
            const resolution = { kind: 'npm' as const, registry: 'https://registry.npmjs.org/', name: '@fixture/plugin', version: '1.0.0', tarball: 'https://registry.npmjs.org/fixture.tgz', sri: 'sha256-' + Buffer.alloc(32).toString('base64'), metadataDigest: 'c'.repeat(64), helperDigests: ['d'.repeat(64)] };
            const resolving = registry.append({ ...first.record, sequence: 1, stage: 'resolving' }), resolved = registry.append({ ...resolving, sequence: 2, stage: 'resolved', resolution });
            if (registry.begin(request, policy, null).record.resolution?.kind !== 'npm')
                throw new Error('Resolution lost');
            refused = false;
            try {
                registry.append({ ...resolved, sequence: 3, resolution: { ...resolution, version: '2.0.0' } });
            }
            catch {
                refused = true;
            }
            if (!refused)
                throw new Error('Resolution overwritten');
            rmSync(configuration.release.directory, { recursive: true });
            if (!store.inspect() || registry.records()[0]!.resolution?.kind !== 'npm')
                throw new Error('Source-free registry unavailable');
            const folder = join(configuration.installationDirectory, '.cordis/plugins/requests'), files = readdirSync(folder).sort();
            if ((statSync(folder).mode & 0o777) !== 0o700 || files.length !== 3)
                throw new Error('Private inventory mismatch');
            for (const name of files)
                if ((statSync(join(folder, name)).mode & 0o777) !== 0o600)
                    throw new Error('Private record mode');
            const tail = join(folder, files.at(-1)!), tailBytes = readFileSync(tail);
            unlinkSync(tail);
            this.refused(store.inspect.bind(store));
            writeFileSync(tail, tailBytes, { mode: 0o600, flag: 'wx' });
            const firstPath = join(folder, files[0]!);
            chmodSync(firstPath, 0o644);
            this.refused(store.inspect.bind(store));
            chmodSync(firstPath, 0o600);
            renameSync(firstPath, firstPath + '.saved');
            symlinkSync(firstPath + '.saved', firstPath);
            this.refused(store.inspect.bind(store));
            unlinkSync(firstPath);
            renameSync(firstPath + '.saved', firstPath);
            mkdirSync(join(folder, '.uncertain'), { mode: 0o700 });
            this.refused(store.inspect.bind(store));
            rmSync(join(folder, '.uncertain'), { recursive: true });
            if (!store.inspect())
                throw new Error('Restored exact journal unavailable');
            const bytes = readFileSync(join(folder, files[1]!));
            writeFileSync(join(folder, files[1]!), bytes.toString() + ' ');
            this.refused(store.inspect.bind(store));
            writeFileSync(join(folder, files[1]!), bytes);
            writeFileSync(join(folder, files[1]!), bytes.toString().replace('resolving', 'resolved'));
            refused = false;
            try {
                store.inspect();
            }
            catch {
                refused = true;
            }
            if (!refused)
                throw new Error('Tampered registry adopted');
            writeFileSync(join(folder, files[1]!), bytes);
            if (!store.inspect())
                throw new Error('Restored record unavailable');
            writer.close();
            this.refused(registry.records.bind(registry));
            process.stdout.write(JSON.stringify({ fixture: true, persistedIntent: true, retry: true, resolutionPinned: true, sourceFree: true, tamperRefused: true }) + '\n');
        }
        finally {
            writer.close();
        }
    }
    private static refused(action: () => unknown): void {
        let refused = false;
        try {
            action();
        }
        catch (error) {
            refused = error instanceof PlanningBlockedError;
        }
        if (!refused)
            throw new Error('Uncertain plugin custody adopted');
    }
}
await PluginRegistryProgram.run(process.argv[2]!);
