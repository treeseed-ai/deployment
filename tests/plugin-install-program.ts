import{FixtureListeners,FixturePublications}from'./fixture-listeners.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CanonicalJson, PlanningBlockedError, ServiceSchemas, type PluginInstallRequest, type PluginInstallResult, type ServiceResourceReceipt } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, ServiceHostRuntime, ServicePlanStore, ServiceWorkerOwnerClient } from '@treeseed-cordis/deployment';
import {InstallationSources} from './git-source-fixture.js';

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
    private static listeners(): string[] { return FixtureListeners.sample(); }
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
        const current = this.receipts(store), application = store.records().filter(this.completed).at(-1)!, accepted = store.read(application.planId,application.digest);
        for (const [id, old] of prior.receipts) {
            const next = current.get(id); if (!next) throw new Error('Prior resource retired');
            const { references: before, ...left } = old, { references: after, ...right } = next;
            if (CanonicalJson.stringify(left) !== CanonicalJson.stringify(right) || after.length < before.length) throw new Error('Prior physical resource identity changed');
            if (old.kind === 'container' && old.actualId && this.docker(['container', 'inspect', '--format', '{{.State.Running}}', old.actualId]) !== 'true') throw new Error('Prior container stopped');
            if (next.kind === 'container' && next.actualId) { const service=accepted.composition.services.find(this.named.bind(null,next.serviceId!))!;FixturePublications.assert(service.definition.ports,JSON.parse(this.docker(['container','inspect','--format','{{json .HostConfig.PortBindings}}',next.actualId]))); }
        }
        for (const [path, digest] of prior.files) if (this.hash(readFileSync(join(store.path, path))) !== digest) throw new Error('Prior credential or authority bytes changed');
        if (this.authority(current) !== prior.authority) throw new Error('Prior authority changed');
        const listeners = this.listeners();
        if (CanonicalJson.stringify(listeners) !== CanonicalJson.stringify(prior.listeners)) throw new Error('Prior listeners changed:' + JSON.stringify({ before: prior.listeners, after: listeners }));
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
            FixturePublications.assert([],JSON.parse(this.docker(['container','inspect','--format','{{json .HostConfig.PortBindings}}',receipt.actualId])));
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
        const input = JSON.parse(readFileSync(file, 'utf8')), configuration = ServiceSchemas.configuration.parse(input.configuration), registry = new InstallationSources(input,configuration.installationDirectory);
        await registry.listen(); let host: ServiceHostRuntime | undefined;
        try {
            const path = join(configuration.release.directory, 'release.json'), release = JSON.parse(readFileSync(path, 'utf8'));
            release.acquisitionPolicy=registry.policy(release.helpers.releaseIdentity,{path:'source-ca.pem',sha256:this.hash(readFileSync(join(configuration.release.directory,'source-ca.pem')))});
            const bytes = CanonicalJson.stringify(release) + '\n'; writeFileSync(path, bytes); configuration.release.manifestDigest = this.hash(bytes);
            const plan = await new ComposeDeploymentHost().plan(configuration); if (plan.formatVersion !== 3) throw new Error('Wrong format');
            host = await ServiceHostRuntime.start(plan);
            const owner = new ServiceWorkerOwnerClient({ installationDirectory: configuration.installationDirectory }), store = new ServicePlanStore(configuration.installationDirectory);
            const initial = await owner.submit({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'initial-four' }); await this.application(owner, initial.id);
            if ((await owner.status()).services.length !== 4) throw new Error('Fixture did not start at four services');
            if (!existsSync(join(input.root, 'SCRIPT_CANARY'))) throw new Error('Initial fixture provider was not genuinely imported');
            const before = this.retained(store), request: PluginInstallRequest = { source: registry.source('1.0.0'), serviceId: 'private-addon-one', idempotencyKey: 'install-private-one', installationDirectory: store.path, scope: 'installation', target: 'deployment', configuration: {} }, first = await this.install(owner, request);
            if (first.state !== 'active' || !first.planId || !first.applicationId || !first.activeGeneration || !first.acknowledgements.length || first.activeGeneration !== store.current()?.compositionGeneration) throw new Error('SAFE_CONTAINER_INSTALL_NOT_ACTIVE:' + first.state + ':' + first.blockers.map(this.code).join(','));
            this.same(store, before); await this.direct(store, 'private-addon-one');
            if(input.selection){
                const selected=await owner.select({capability:'container.service',providerId:'extension.container',serviceId:'private-addon-one',idempotencyKey:'select-registered-one',installationDirectory:store.path,scope:'installation',target:'deployment',expectedGeneration:first.activeGeneration,configuration:{}});
                let result=selected;const deadline=Date.now()+150000;while(result.state==='pending'&&Date.now()<deadline){await new Promise(this.delay);result=await owner.inspect('select-registered-one');}
                if(result.state!=='already-active'||result.applicationId!==first.applicationId||result.activeGeneration!==first.activeGeneration)throw new Error('REGISTERED_PROVIDER_SELECTION_NOT_ACTIVE:'+result.state+':'+result.blockers.map(this.code).join(','));
                const repeated=await owner.select({capability:'container.service',providerId:'extension.container',serviceId:'private-addon-one',idempotencyKey:'select-registered-one',installationDirectory:store.path,scope:'installation',target:'deployment',expectedGeneration:first.activeGeneration,configuration:{}});
                if(CanonicalJson.stringify(repeated)!==CanonicalJson.stringify(result))throw new Error('Registered selection retry changed accepted result');
                const missing=await owner.select({capability:'container.service',providerId:'fixture.unregistered',serviceId:'private-addon-one',idempotencyKey:'select-unregistered',installationDirectory:store.path,scope:'installation',target:'deployment',configuration:{}});
                let denied=missing;while(denied.state==='pending'&&Date.now()<deadline){await new Promise(this.delay);denied=await owner.inspect('select-unregistered');}
                if(denied.state!=='blocked'||!denied.blockers.some(this.unregistered))throw new Error('Unregistered provider was not refused');
                this.same(store,before);
            }
            const current = this.retained(store);
            if(!input.rebase){const repeated = await this.install(owner, { ...request, idempotencyKey: 'already-private-one' });
            if (repeated.state !== 'already-active' || repeated.applicationId !== first.applicationId || repeated.activeGeneration !== first.activeGeneration) throw new Error('Exact selected provider was not already-active');}
            if(input.rebase){await registry.close();const count=registry.requests;let checkpoint=this.retained(store);for(const id of ['private-addon-two','private-addon-three']){let selected=await owner.select({capability:'container.service',providerId:'extension.container',serviceId:id,idempotencyKey:'registered-'+id,installationDirectory:store.path,scope:'installation',target:'deployment',expectedGeneration:store.current()!.compositionGeneration,configuration:{}});const deadline=Date.now()+150000;while(selected.state==='pending'&&Date.now()<deadline){await new Promise(this.delay);selected=await owner.inspect(selected.requestId);}if(selected.state!=='active')throw new Error('REGISTERED_CURRENT_CLOSURE_NOT_ACTIVE:'+selected.state+':'+selected.blockers.map(this.code).join(','));this.same(store,checkpoint);await this.direct(store,id);checkpoint=this.retained(store);if(registry.requests!==count)throw new Error('Registered selection reopened source');}if((await owner.status()).services.length!==7)throw new Error('Registered instances missing');process.stdout.write(JSON.stringify({fixtureOnly:true,registered:true,services:7,sourceFree:true,retained:true})+'\n');return;}
            const applications = store.records().length, unsafe = await this.install(owner, { ...request, source: registry.source('2.0.0'), idempotencyKey: 'unsafe-state-change' });
            if (unsafe.state !== 'prepared' || unsafe.applicationId !== null || unsafe.activeGeneration !== null || !unsafe.nextActions.includes('review-migration') || store.records().length !== applications) throw new Error('Unsafe stateful replacement was activated or hidden');
            this.same(store, current);
            if(input.selection){const count=registry.requests,ambiguous={capability:'container.service',providerId:'extension.container',serviceId:'private-addon-one',idempotencyKey:'ambiguous-selection',installationDirectory:store.path,scope:'installation' as const,target:'deployment' as const,configuration:{}};let result=await owner.select(ambiguous);const deadline=Date.now()+150000;while(result.state==='pending'&&Date.now()<deadline){await new Promise(this.delay);result=await owner.inspect(ambiguous.idempotencyKey);}if(result.state!=='blocked'||!result.blockers.some(this.ambiguous)||registry.requests!==count||store.records().length!==applications)throw new Error('Ambiguous registered selection resolved a source or activated');let refused=false;try{await owner.select({...ambiguous,idempotencyKey:'stale-selection',expectedGeneration:'e'.repeat(64)});}catch(error){if(error instanceof PlanningBlockedError)refused=error.blockers.some(this.stale);else throw error;}if(!refused)throw new Error('Stale registered selection was accepted');}
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
    private static ambiguous(value:{code:string}):boolean{return value.code==='AMBIGUOUS_REGISTERED_PROVIDER';}
    private static stale(value:{code:string}):boolean{return value.code==='STALE_GENERATION';}
    private static unregistered(blocker:{code:string}):boolean{return blocker.code==='REGISTERED_PROVIDER_NOT_FOUND';}
    private static completed(value:{phase:string}):boolean{return value.phase==='completed';}
    private static named(id:string,value:{serviceId:string}):boolean{return id===value.serviceId;}
    private static code(blocker: { code: string }): string { return blocker.code; }
    static failed(error: unknown): never { if (error instanceof PlanningBlockedError) throw new Error(error.blockers.map(this.code).join(',')); throw error; }
}
await PluginInstallProgram.run(process.argv[2]!).catch(PluginInstallProgram.failed.bind(PluginInstallProgram));
