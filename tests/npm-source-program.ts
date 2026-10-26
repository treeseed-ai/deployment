import * as Deployment from '@treeseed-cordis/deployment';
import { PlanningBlockedError, CanonicalJson, type PluginRequestRecord, type PluginInstallRequest, type PluginInstallResult, type ServicePlan, type ServiceGraph, type PluginPackageDescriptor } from '@treeseed-cordis/sdk';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, chmodSync, renameSync, symlinkSync, unlinkSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
interface FetchedArchive {
    path: string;
    sha256: string;
    size: number;
    descriptor: PluginPackageDescriptor;
}
interface SourceRuntime {
    plan?(configuration: ServicePlan['configuration']): Promise<ServicePlan>;
    prepare?(record: PluginRequestRecord, composition: ServiceGraph): Promise<ServicePlan['configuration']>;
    acquire?(record: PluginRequestRecord): Promise<PluginRequestRecord>;
    fetch?(record: PluginRequestRecord): Promise<FetchedArchive>;
    begin(source: string, key: string, target?: 'deployment' | 'cli'): PluginRequestRecord;
    resolve(record: PluginRequestRecord): Promise<PluginRequestRecord>;
    close(): Promise<void>;
}
interface ManagerClient {
    install?(request: PluginInstallRequest): Promise<PluginInstallResult>;
    list?(scope?: 'installation' | 'client', target?: PluginInstallRequest['target']): Promise<PluginInstallResult[]>;
    inspect?(requestId: string): Promise<PluginInstallResult>;
}
class RegistryFixture {
    private readonly server: Server;
    private closed = false;
    version = '1.0.0';
    requests = 0;
    authorization = false;
    tamperTrust = false;
    crossOrigin = false;
    invalidIntegrity = false;
    trustChanges = 0;
    archiveRequests = 0;
    forbiddenRequests = 0;
    corruptArchive = false;
    metadataDelayMs = 0;
    private port = 0;
    constructor(private readonly root: string, private readonly installation: string) { this.server = createServer({ key: readFileSync(join(root, 'key.pem')), cert: readFileSync(join(root, 'cert.pem')) }, this.reply.bind(this)); }
    private reply(request: IncomingMessage, response: ServerResponse): void {
        if (this.metadataDelayMs && !(request.url ?? '').endsWith('.tgz')) { setTimeout(this.serve.bind(this, request, response), this.metadataDelayMs); return; }
        this.serve(request, response);
    }
    private serve(request: IncomingMessage, response: ServerResponse): void {
        const match = /^\/(source-(?:1\.0\.0|2\.0\.0|3\.0\.0|4\.0\.0)|runtime-1\.0\.0)\.tgz$/.exec(request.url ?? '');
        if (match) {
            this.archiveRequests++;
            const bytes = readFileSync(join(this.root, match[1] + '.tgz'));
            response.end(this.corruptArchive ? Buffer.alloc(bytes.length, 0x41) : bytes);
            return;
        }
        const decoded = decodeURIComponent((request.url ?? '').split('?')[0]!);
        if (decoded === '/@fixture/forbidden')
            this.forbiddenRequests++;
        const ordinary = decoded === '/@fixture/runtime', name = ordinary ? '@fixture/runtime' : '@fixture/npm-source';
        this.requests++;
        this.changeTrust();
        this.authorization ||= request.headers.authorization !== undefined;
        const versions: Record<string, unknown> = {};
        for (const version of ordinary ? ['1.0.0'] : ['1.0.0', '2.0.0', '3.0.0', '4.0.0']) {
            const archive = readFileSync(join(this.root, ordinary ? 'runtime-1.0.0.tgz' : 'source-' + version + '.tgz'));
            versions[version] = { name, version, dist: { tarball: (this.crossOrigin ? 'https://unapproved.invalid/' : this.origin()) + (ordinary ? 'runtime-1.0.0.tgz' : 'source-' + version + '.tgz'), integrity: this.invalidIntegrity ? 'sha512-AAAA' : 'sha512-' + createHash('sha512').update(archive).digest('base64') }, scripts: { postinstall: 'bun postinstall.ts' } };
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ name, 'dist-tags': { latest: ordinary ? '1.0.0' : this.version }, versions }));
    }
    private changeTrust(): void {
        if (!this.tamperTrust)
            return;
        const artifacts = join(this.installation, '.cordis/artifacts');
        for (const name of readdirSync(artifacts))
            if (name.startsWith('source-resolution-')) {
                const path = join(artifacts, name, 'source-ca.pem');
                if (existsSync(path)) {
                    const bytes = readFileSync(path);
                    chmodSync(path, 0o600);
                    writeFileSync(path, bytes);
                    chmodSync(path, 0o400);
                    this.trustChanges++;
                }
            }
    }
    origin(): string {
        const address = this.server.address();
        if (!address || typeof address === 'string')
            throw new Error('Registry not listening');
        return 'https://127.0.0.1:' + address.port + '/';
    }
    async listen(): Promise<void> { this.closed = false; await new Promise<void>(this.start.bind(this)); const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('Registry not listening'); this.port = address.port; }
    private start(done: () => void, reject: (error: Error) => void): void { this.server.once('error', reject); this.server.listen(this.port, '127.0.0.1', done); }
    async close(): Promise<void> {
        if (this.closed)
            return;
        this.closed = true;
        await new Promise<void>(this.stop.bind(this));
    }
    private stop(done: () => void): void { this.server.closeAllConnections(); this.server.close(this.stopped.bind(this, done)); }
    private stopped(done: () => void, error?: Error): void {
        if (error)
            throw error;
        done();
    }
}
class NpmSourceProgram {
    private static notAddition(change: ServicePlan['changes'][number]): boolean { return change.kind !== 'add'; }
    private static fixtureBytes(path: string, bytes: Buffer): void { chmodSync(path, 0o600); writeFileSync(path, bytes); chmodSync(path, 0o400); }
    private static async rewrittenPrepared(runtime: SourceRuntime, record: PluginRequestRecord, graph: ServiceGraph, configuration: ServicePlan['configuration']): Promise<void> {
        if (typeof runtime.prepare !== 'function') throw new Error('PRIVATE_PREPARED_RELEASE_UNAVAILABLE');
        const rootPath = join(configuration.release.directory, 'package.json'), releasePath = join(configuration.release.directory, 'release.json'), receiptPath = join(dirname(configuration.release.directory), 'receipt.json'), original = [{ path: rootPath, bytes: readFileSync(rootPath) }, { path: releasePath, bytes: readFileSync(releasePath) }, { path: receiptPath, bytes: readFileSync(receiptPath) }];
        const root = JSON.parse(original[0]!.bytes.toString()) as Record<string, unknown>, release = JSON.parse(original[1]!.bytes.toString()) as { packageJson: { sha256: string } }, receipt = JSON.parse(original[2]!.bytes.toString()) as { configuration: ServicePlan['configuration']; files: { path: string; sha256: string; size: number }[] };
        root.name = 'coherently-rewritten-fixture';
        const rootBytes = Buffer.from(CanonicalJson.stringify(root) + '\n'); release.packageJson.sha256 = createHash('sha256').update(rootBytes).digest('hex');
        const releaseBytes = Buffer.from(CanonicalJson.stringify(release) + '\n'); receipt.configuration.release.manifestDigest = createHash('sha256').update(releaseBytes).digest('hex');
        for (const file of receipt.files) { const bytes = file.path === 'package.json' ? rootBytes : file.path === 'release.json' ? releaseBytes : null; if (bytes) { file.sha256 = createHash('sha256').update(bytes).digest('hex'); file.size = bytes.length; } }
        let refused = false;
        try {
            this.fixtureBytes(rootPath, rootBytes); this.fixtureBytes(releasePath, releaseBytes); this.fixtureBytes(receiptPath, Buffer.from(CanonicalJson.stringify(receipt) + '\n'));
            try { await runtime.prepare(record, graph); } catch (error) { refused = error instanceof PlanningBlockedError && error.blockers[0]?.code === 'PREPARED_SOURCE_BINDING'; }
        } finally { for (const file of original) this.fixtureBytes(file.path, file.bytes); }
        if (!refused) throw new Error('Coherently rewritten prepared custody escaped exact acquired source binding');
    }
    static failed(error: unknown): never {
        if (error instanceof PlanningBlockedError)
            throw new Error(error.blockers.map(NpmSourceProgram.code).join(","));
        throw error;
    }
    private static code(blocker: {
        code: string;
    }): string { return blocker.code; }
    static async run(file: string): Promise<void> {
        const constructor = Reflect.get(Deployment, 'NpmSourceRuntime') as {
            start(plan: ServicePlan): Promise<SourceRuntime>;
        };
        if (!constructor?.start)
            throw new Error('NATIVE_NPM_SOURCE_UNAVAILABLE');
        const input = JSON.parse(readFileSync(file, 'utf8')), registry = new RegistryFixture(input.root, input.configuration.installationDirectory);
        await registry.listen();
        let runtime: SourceRuntime | undefined;
        let managerHost: Deployment.ServiceHostRuntime | undefined;
        try {
            const configuration = input.configuration, releasePath = join(configuration.release.directory, 'release.json'), release = JSON.parse(readFileSync(releasePath, 'utf8'));
            release.acquisitionPolicy = { formatVersion: 1, helperReleaseIdentity: release.helpers.releaseIdentity, npm: [{ registry: registry.origin(), packages: ['@fixture/npm-source', '@fixture/runtime'], targets: ['deployment'], certificateAuthority: { path: 'source-ca.pem', sha256: createHash('sha256').update(readFileSync(join(configuration.release.directory, 'source-ca.pem'))).digest('hex') } }], git: [], builds: [] };
            const bytes = CanonicalJson.stringify(release) + '\n';
            writeFileSync(releasePath, bytes);
            configuration.release.manifestDigest = createHash('sha256').update(bytes).digest('hex');
            const plan = await new Deployment.ComposeDeploymentHost().plan(configuration);
            if (plan.formatVersion !== 3)
                throw new Error('Wrong plan');
            runtime = await constructor.start(plan);
            const record = runtime.begin('@fixture/npm-source', 'exact-npm-request'), resolved = await runtime.resolve(record);
            if (resolved.stage !== 'resolved' || resolved.resolution?.kind !== 'npm' || resolved.resolution.version !== '1.0.0' || resolved.sourceReceipt !== null)
                throw new Error('Missing exact resolution before acquisition');
            const count = registry.requests;
            let conflicted = false;
            try {
                runtime.begin('@fixture/npm-source@2.0.0', 'exact-npm-request');
            }
            catch {
                conflicted = true;
            }
            if (!conflicted || registry.requests !== count)
                throw new Error('Conflicting source intent admitted');
            registry.version = '2.0.0';
            rmSync(configuration.release.directory, { recursive: true });
            const replay = await runtime.resolve(record);
            if (CanonicalJson.stringify(replay) !== CanonicalJson.stringify(resolved) || registry.requests !== count)
                throw new Error('Retry re-resolved mutable source');
            const next = await runtime.resolve(runtime.begin('@fixture/npm-source', 'new-npm-request'));
            if (next.resolution?.kind !== 'npm' || next.resolution.version !== '2.0.0')
                throw new Error('New key did not resolve moved tag');
            let denied = false;
            try {
                await runtime.resolve(runtime.begin('@fixture/npm-source', 'denied-target', 'cli'));
            }
            catch {
                denied = true;
            }
            if (!denied || registry.requests !== count + 1)
                throw new Error('Unapproved target performed network lookup');
            for (const mode of ['cross-origin', 'integrity', 'ca-race']) {
                registry.crossOrigin = mode === 'cross-origin';
                registry.invalidIntegrity = mode === 'integrity';
                registry.tamperTrust = mode === 'ca-race';
                let rejected = false;
                try {
                    await runtime.resolve(runtime.begin('@fixture/npm-source', 'unsafe-' + mode));
                }
                catch (error) {
                    const expected: Record<string, string> = { 'cross-origin': 'NPM_TARBALL_ORIGIN', integrity: 'NPM_METADATA_INTEGRITY', 'ca-race': 'SOURCE_CA_CHANGED' };
                    if (!(error instanceof PlanningBlockedError) || error.blockers[0]?.code !== expected[mode])
                        throw error;
                    rejected = true;
                }
                if (mode === 'ca-race' && registry.trustChanges === 0)
                    throw new Error('Trust-race fixture did not perturb a real CA file');
                if (!rejected)
                    throw new Error('Unapproved npm metadata or changed trust admitted: ' + mode);
            }
            registry.crossOrigin = false;
            registry.invalidIntegrity = false;
            registry.tamperTrust = false;
            const uncertain = runtime.begin('@fixture/npm-source@missing', 'interrupted-npm-request');
            let failed = false;
            try {
                await runtime.resolve(uncertain);
            }
            catch {
                failed = true;
            }
            if (!failed)
                throw new Error('Missing tag was resolved');
            const failedCount = registry.requests;
            try {
                await runtime.resolve(uncertain);
            }
            catch { }
            if (registry.requests !== failedCount)
                throw new Error('Uncertain lookup silently retried');
            if (typeof runtime.fetch !== 'function')
                throw new Error('EXACT_NPM_ARCHIVE_ACQUISITION_UNAVAILABLE');
            const fetched = await runtime.fetch(resolved);
            if (fetched.descriptor.package.name !== '@fixture/npm-source' || fetched.descriptor.package.version !== '1.0.0' || fetched.sha256 !== createHash('sha256').update(readFileSync(join(input.root, 'source-1.0.0.tgz'))).digest('hex') || !fetched.path.startsWith(configuration.installationDirectory + '/.cordis/artifacts/'))
                throw new Error('Wrong verified original archive');
            const bad = await runtime.resolve(runtime.begin('@fixture/npm-source@2.0.0', 'corrupt-archive-request'));
            registry.corruptArchive = true;
            let corrupt = false;
            try {
                await runtime.fetch(bad);
            }
            catch (error) {
                corrupt = error instanceof PlanningBlockedError && error.blockers[0]?.code === 'SOURCE_ARCHIVE_INTEGRITY';
            }
            registry.corruptArchive = false;
            if (!corrupt)
                throw new Error('Changed archive SRI accepted');
            const valid = await runtime.fetch(bad);
            if (valid.descriptor.package.version !== '2.0.0')
                throw new Error('Exact archive retry failed');
            const malformed = await runtime.resolve(runtime.begin('@fixture/npm-source@3.0.0', 'undeclared-archive-request'));
            let malformedDenied = false;
            try {
                await runtime.fetch(malformed);
            }
            catch (error) {
                malformedDenied = error instanceof PlanningBlockedError && error.blockers[0]?.code === 'INVALID_PLUGIN_PACKAGE';
            }
            if (!malformedDenied)
                throw new Error('Undeclared plugin archive admitted');
            if (typeof runtime.acquire !== 'function')
                throw new Error('COMPLETE_SOURCE_CLOSURE_UNAVAILABLE');
            const acquiredPair = await Promise.all([runtime.acquire(resolved), runtime.acquire(resolved)]), acquired = acquiredPair[0]!;
            if (CanonicalJson.stringify(acquiredPair[1]) !== CanonicalJson.stringify(acquired) || acquired.stage !== 'acquired' || acquired.sourceReceipt?.kind !== 'npm' || acquired.sourceReceipt.archiveDigest !== fetched.sha256 || !acquired.sourceReceipt.closureDigest)
                throw new Error('Acquired receipt lacks complete joined closure');
            const deniedRecord = await runtime.resolve(runtime.begin('@fixture/npm-source@4.0.0', 'unapproved-closure-request'));
            let dependencyDenied = false;
            try {
                await runtime.acquire(deniedRecord);
            }
            catch (error) {
                dependencyDenied = error instanceof PlanningBlockedError && error.blockers[0]?.code === 'NPM_SOURCE_NOT_APPROVED';
            }
            if (!dependencyDenied || registry.forbiddenRequests !== 0)
                throw new Error('Unapproved dependency performed source lookup');
            const denialLookups = registry.requests;
            let incomplete = false;
            try {
                await runtime.acquire(deniedRecord);
            }
            catch (error) {
                incomplete = error instanceof PlanningBlockedError && error.blockers[0]?.code === 'SOURCE_CLOSURE_UNCERTAIN';
            }
            if (!incomplete || registry.requests !== denialLookups)
                throw new Error('Incomplete closure silently re-resolved dependencies');
            const stoppedCount = registry.requests;
            await runtime.close();
            runtime = undefined;
            await registry.close();
            runtime = await constructor.start(plan);
            if (CanonicalJson.stringify(await runtime.resolve(record)) !== CanonicalJson.stringify(acquired) || registry.requests !== stoppedCount)
                throw new Error('Stopped-owner retry lost pinned resolution');
            if (typeof runtime.acquire !== 'function' || CanonicalJson.stringify(await runtime.acquire(resolved)) !== CanonicalJson.stringify(acquired))
                throw new Error('Completed closure did not read source-free after owner restart');
            if (typeof runtime.prepare !== 'function')
                throw new Error('PRIVATE_PREPARED_RELEASE_UNAVAILABLE');
            const graph = structuredClone(plan.composition);
            for (const service of graph.services)
                for (const provider of [service.provider, service.readiness.provider])
                    provider.package = { name: acquired.sourceReceipt!.name, version: acquired.sourceReceipt!.version, sha256: acquired.sourceReceipt!.archiveDigest };
            const prepared = await runtime.prepare(acquired, graph);
            if (!prepared.release.directory.startsWith(configuration.installationDirectory + '/.cordis/artifacts/prepared/') || CanonicalJson.stringify(await runtime.prepare(acquired, graph)) !== CanonicalJson.stringify(prepared))
                throw new Error('Private prepared release not deterministic');
            const checked = await new Deployment.ServiceArtifactResolver().resolve(prepared);
            if (checked.inventory.composition.services.length !== graph.services.length || checked.releaseDigest !== prepared.release.manifestDigest || registry.requests !== stoppedCount)
                throw new Error('Prepared release not independently verified source-free');
            for (const path of [join(dirname(prepared.release.directory), 'receipt.json'), join(prepared.release.directory, 'compose.json')]) {
                const original = readFileSync(path);
                chmodSync(path, 0o600); writeFileSync(path, '{}'); chmodSync(path, 0o400);
                let refused = false;
                try { await runtime.prepare(acquired, graph); } catch (error) { refused = error instanceof PlanningBlockedError; }
                chmodSync(path, 0o600); writeFileSync(path, original); chmodSync(path, 0o400);
                if (!refused) throw new Error('Changed private prepared release adopted');
            }
            if (CanonicalJson.stringify(await runtime.prepare(acquired, graph)) !== CanonicalJson.stringify(prepared))
                throw new Error('Restored prepared release changed');
            const preparedRoot = dirname(prepared.release.directory), preparedReceipt = join(preparedRoot, 'receipt.json'), receiptBackup = join(input.root, 'prepared-receipt-backup'), bundleBackup = join(input.root, 'prepared-bundle-backup');
            if ((lstatSync(preparedRoot).mode & 0o777) !== 0o500 || (lstatSync(preparedReceipt).mode & 0o777) !== 0o400)
                throw new Error('Prepared release is not sealed');
            for (const mode of ['missing-receipt', 'symlink-bundle']) {
                chmodSync(preparedRoot, 0o700);
                if (mode === 'missing-receipt') renameSync(preparedReceipt, receiptBackup);
                else { chmodSync(prepared.release.directory, 0o700); renameSync(prepared.release.directory, bundleBackup); chmodSync(bundleBackup, 0o500); symlinkSync(bundleBackup, prepared.release.directory); }
                chmodSync(preparedRoot, 0o500);
                let refused = false;
                try { await runtime.prepare(acquired, graph); } catch (error) { refused = error instanceof PlanningBlockedError; }
                chmodSync(preparedRoot, 0o700);
                if (mode === 'missing-receipt') renameSync(receiptBackup, preparedReceipt);
                else { unlinkSync(prepared.release.directory); chmodSync(bundleBackup, 0o700); renameSync(bundleBackup, prepared.release.directory); chmodSync(prepared.release.directory, 0o500); }
                chmodSync(preparedRoot, 0o500);
                if (!refused) throw new Error('Incomplete or linked prepared release adopted');
            }
            if (CanonicalJson.stringify(await runtime.prepare(acquired, graph)) !== CanonicalJson.stringify(prepared) || registry.requests !== stoppedCount)
                throw new Error('Prepared custody repair changed source identity');
            await this.rewrittenPrepared(runtime, acquired, graph, prepared);
            let outsideOwner = false;
            try { await new Deployment.ComposeDeploymentHost().plan(prepared); } catch (error) { outsideOwner = error instanceof PlanningBlockedError && error.blockers[0]?.code === 'OVERLAPPING_STORAGE'; }
            if (!outsideOwner) throw new Error('Public planner admitted private overlapping storage');
            if (typeof runtime.plan !== 'function') throw new Error('OWNER_PREPARED_PLANNING_UNAVAILABLE');
            const privatePlan = await runtime.plan(prepared);
            if (privatePlan.expectedComposition !== null || privatePlan.configuration.release.manifestDigest !== prepared.release.manifestDigest || privatePlan.changes.some(NpmSourceProgram.notAddition))
                throw new Error('Fresh owner plan claimed an active or retained composition');
            const closureRoot = join(plan.configuration.installationDirectory, '.cordis', 'artifacts', 'closures', acquired.sourceReceipt!.closureDigest);
            for (const name of ['receipt.json', 'bun.lock']) {
                const path = join(closureRoot, name), original = readFileSync(path);
                chmodSync(path, 0o600);
                writeFileSync(path, '{}');
                chmodSync(path, 0o400);
                let rejected = false;
                try {
                    await runtime.acquire(resolved);
                }
                catch (error) {
                    rejected = error instanceof PlanningBlockedError;
                }
                chmodSync(path, 0o600);
                writeFileSync(path, original);
                chmodSync(path, 0o400);
                if (!rejected)
                    throw new Error('Changed completed closure ' + name + ' adopted');
            }
            if (CanonicalJson.stringify(await runtime.acquire(resolved)) !== CanonicalJson.stringify(acquired) || registry.requests !== stoppedCount)
                throw new Error('Restored closure required mutable source access');
            if (typeof runtime.fetch !== 'function' || CanonicalJson.stringify(await runtime.fetch(resolved)) !== CanonicalJson.stringify(fetched))
                throw new Error('Offline exact archive custody changed');
            const savedBytes = readFileSync(fetched.path);
            chmodSync(fetched.path, 0o600);
            writeFileSync(fetched.path, Buffer.alloc(savedBytes.length, 0x42));
            chmodSync(fetched.path, 0o400);
            let tamper = false;
            try {
                await runtime.fetch(resolved);
            }
            catch (error) {
                tamper = error instanceof PlanningBlockedError;
            }
            if (!tamper)
                throw new Error('Changed cached archive adopted');
            chmodSync(fetched.path, 0o600);
            writeFileSync(fetched.path, savedBytes);
            chmodSync(fetched.path, 0o400);
            const receiptPath = join(dirname(fetched.path), 'receipt.json'), receiptBytes = readFileSync(receiptPath);
            chmodSync(receiptPath, 0o600);
            writeFileSync(receiptPath, '{}\n');
            chmodSync(receiptPath, 0o400);
            let malformedReceipt = false;
            try {
                await runtime.fetch(resolved);
            }
            catch (error) {
                malformedReceipt = error instanceof PlanningBlockedError;
            }
            if (!malformedReceipt)
                throw new Error('Malformed archive receipt did not produce a safe typed blocker');
            chmodSync(receiptPath, 0o600);
            writeFileSync(receiptPath, receiptBytes);
            chmodSync(receiptPath, 0o400);
            await runtime.close(); runtime = undefined;
            managerHost = await Deployment.ServiceHostRuntime.start(plan);
            const client = new Deployment.ServiceWorkerOwnerClient({ installationDirectory: configuration.installationDirectory }) as ManagerClient;
            if (typeof client.install !== 'function' || typeof client.list !== 'function' || typeof client.inspect !== 'function') throw new Error('NATIVE_PLUGIN_MANAGER_UNAVAILABLE');
            await registry.listen(); registry.metadataDelayMs = 1200;
            const managed: PluginInstallRequest = { source: '@fixture/npm-source@1.0.0', idempotencyKey: 'native-manager-registration', installationDirectory: configuration.installationDirectory, scope: 'installation', target: 'deployment', configuration: {} }, beforeManager = registry.requests, first = await client.install(managed);
            if (first.state !== 'pending' || first.planId !== null || first.applicationId !== null || first.activeGeneration !== null || first.acknowledgements.length) throw new Error('Unfinished source request claimed activation');
            let registered = first;
            const deadline = Date.now() + 60000;
            while (registered.state === 'pending' && Date.now() < deadline) { await new Promise(NpmSourceProgram.delay); registered = await client.inspect(managed.idempotencyKey); }
            if (registered.state !== 'prepared' || registered.artifact?.package !== '@fixture/npm-source' || registered.activeGeneration !== null || registered.acknowledgements.length || registered.planId !== null || registered.applicationId !== null || registry.requests <= beforeManager) throw new Error('Native manager did not register exact non-active alternative');
            await registry.close();
            if (CanonicalJson.stringify(await client.install(managed)) !== CanonicalJson.stringify(registered) || !(await client.list('installation', 'deployment')).some(NpmSourceProgram.request.bind(null, managed.idempotencyKey))) throw new Error('Native registration retry/read-back reopened source');
            let conflict = false;
            try { await client.install({ ...managed, configuration: { conflicting: true } }); } catch (error) { conflict = error instanceof PlanningBlockedError && error.blockers[0]?.code === 'IDEMPOTENCY_CONFLICT'; }
            if (!conflict || new Deployment.ServicePlanStore(configuration.installationDirectory).records().length || new Deployment.ServicePlanStore(configuration.installationDirectory).resources().length) throw new Error('Manager conflict mutated runtime');
            if (registry.authorization || existsSync(join(input.root, 'MUST_NOT_RUN')) || existsSync(join(input.root, 'SCRIPT_CANARY')) || existsSync(configuration.installationDirectory + '/.cordis/credentials'))
                throw new Error('Credentials or lifecycle canary escaped');
            process.stdout.write(JSON.stringify({ fixture: true, native: true, exact: true, pinnedRetry: true, movedNewKey: true, sourceFree: true, grantRefused: true, noCredentialsOrScripts: true, exactArchive: true, offlineArchive: true, tamperRefused: true, closure: true, joined: true, closureSourceFree: true, unapprovedDependencyRefused: true }) + '\n');
        }
        finally {
            await managerHost?.close();
            await runtime?.close();
            await registry.close();
        }
    }
    private static delay(done: (value: void) => void): void { setTimeout(done, 50); }
    private static request(id: string, result: PluginInstallResult): boolean { return result.requestId === id; }
}
await NpmSourceProgram.run(process.argv[2]!).catch(NpmSourceProgram.failed);
