import { readFileSync, writeFileSync, existsSync, chmodSync, statSync, unlinkSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CanonicalJson, PlanningBlockedError, ServiceSchemas, type ServicePlan, type ServiceSnapshot } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, ServicePlanStore, ServiceImages, ServiceCredentials, ServiceNativeScope, ServiceRuntimeInspection, ServiceAuthorityExports, LocalDockerCommands, ServiceContainerEngine, ServiceProviderStager } from '@treeseed-cordis/deployment';
class CancellingCommands extends LocalDockerCommands {
    constructor(private readonly controller: AbortController) { super(); }
    override async archive(engine: ServicePlan['expectedEngine'], id: string, path: string, timeout?: number): Promise<Uint8Array> { const bytes = await super.archive(engine, id, path, timeout); this.controller.abort(); return bytes; }
}
class AuthorityCustodyProgram {
    private static options(): { deadline: number; signal: AbortSignal } { return { deadline: Date.now() + 10000, signal: new AbortController().signal }; }
    static async run(file: string, certificate: string, fenced=false): Promise<void> {
        const configuration = ServiceSchemas.configuration.parse(JSON.parse(readFileSync(file, 'utf8'))), plan = await new ComposeDeploymentHost().plan(configuration);
        if (plan.formatVersion !== 3) throw new Error('Wrong plan format');
        const store = new ServicePlanStore(configuration.installationDirectory), writer = store.writer(), scopes: ServiceNativeScope[] = [];
        try {
            let event = store.accept({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'authority-custody-program' }, writer).record;
            const first = plan.composition.services[0]!, second = plan.composition.services[1]!, reference = 'secret://' + first.serviceId + '/public-ca', root = join(configuration.installationDirectory, '.cordis/artifacts/authorities');
            let denied = false;
            try { await new ServiceAuthorityExports(plan, writer).read(first.serviceId, reference, this.options()); } catch (error) { denied = error instanceof PlanningBlockedError; }
            if (!denied || existsSync(root)) throw new Error('Unaccepted export created custody');
            event = { ...event, sequence: 1, phase: 'stage', result: null }; store.append(event, writer);
            await new ServiceImages(plan).stage(writer);
            const prepared = []; for (const service of plan.composition.services) prepared.push(await ServiceNativeScope.prepare(plan, service.serviceId, writer));
            event = { ...event, sequence: 2, phase: 'prepare' }; store.append(event, writer); await new ServiceCredentials(plan).prepare(writer);
            event = { ...event, sequence: 3, phase: 'activate' }; store.append(event, writer);
            for (let index = 0; index < plan.composition.services.length; index++) scopes.push(await ServiceNativeScope.open(plan, plan.composition.services[index]!.serviceId, prepared[index]!, writer));
            const target = await new ServiceRuntimeInspection(plan).service(first.serviceId), until = Date.now() + 10000;
            while (true) { try { const response = await fetch(target.endpoint); await response.arrayBuffer(); if (response.ok) break; } catch { } if (Date.now() >= until) throw new Error('Fixture did not listen'); await new Promise(this.delay); }
            const controller = new AbortController(); denied = false;
            try { await new ServiceAuthorityExports(plan, writer, new CancellingCommands(controller)).read(first.serviceId, reference, { deadline: Date.now() + 10000, signal: controller.signal }); } catch (error) { denied = error instanceof PlanningBlockedError; }
            if (!denied || existsSync(root) || store.resources().some(this.authority)) throw new Error('Cancelled copy published authority state');
            const exports = new ServiceAuthorityExports(plan, writer), expected = readFileSync(certificate), repeated = await Promise.all([exports.read(first.serviceId, reference, this.options()), exports.read(first.serviceId, reference, this.options())]);
            if (!repeated.every(this.equal.bind(null, expected)) || store.resources().filter(this.authority).length !== 1) throw new Error('Concurrent reads forked authority custody');
            if (!(await exports.read(second.serviceId, reference, this.options())).equals(expected)) throw new Error('Declared cross-service authority grant failed');
            denied = false; try { await exports.read(plan.composition.services[2]!.serviceId, reference, this.options()); } catch (error) { denied = error instanceof PlanningBlockedError; } if (!denied) throw new Error('Undeclared grant accepted');
            if(fenced){event={...event,sequence:event.sequence+1,phase:'failed',result:'failed',recovery:'repair-required'};store.append(event,writer);await this.effects(plan,store,writer,exports,true);const journal=CanonicalJson.stringify(store.resources());rmSync(configuration.release.directory,{recursive:true});await this.refused(new ServiceAuthorityExports(plan),first.serviceId,reference);if(journal!==CanonicalJson.stringify(store.resources()))throw new Error('Fenced cached refusal changed private custody');process.stdout.write(JSON.stringify({fixtureOnly:true,fenced:true,cachedRefused:true,unchanged:true})+'\n');return;}
            const acknowledgements:ServiceSnapshot['acknowledgements']=[];for (const scope of scopes) { const report = await scope.ready(); if (!report.ready) throw new Error('Native authority probe did not qualify'); acknowledgements.push(...report.acknowledgements??[]); }
            const authorities = store.resources().filter(this.authority); if (authorities.length !== 5) throw new Error('Wrong authority receipt inventory');
            const receipt = authorities.find(this.selected.bind(null, first.serviceId))!; if (!receipt.path || !receipt.contentDigest || !receipt.actualId) throw new Error('Unbound receipt');
            const path = join(configuration.installationDirectory, '.cordis', receipt.path), bytes = readFileSync(path), cached = new ServiceAuthorityExports(plan), journal = CanonicalJson.stringify(store.resources());
            if ((statSync(path).mode & 0o777) !== 0o600 || (statSync(root).mode & 0o777) !== 0o700) throw new Error('Non-private custody');
            rmSync(configuration.release.directory, { recursive: true });
            if (!(await cached.read(first.serviceId, reference, this.options())).equals(expected) || journal !== CanonicalJson.stringify(store.resources())) throw new Error('Cached read reopened source or changed receipts');
            const unknown = join(root, 'unreceipted.pem'); writeFileSync(unknown, expected, { mode: 0o600 }); await this.refused(cached, first.serviceId, reference); unlinkSync(unknown);
            chmodSync(root, 0o755); await this.refused(cached, first.serviceId, reference); chmodSync(root, 0o700);
            chmodSync(path, 0o644); await this.refused(cached, first.serviceId, reference); chmodSync(path, 0o600);
            unlinkSync(path); symlinkSync(certificate, path); await this.refused(cached, first.serviceId, reference); unlinkSync(path); writeFileSync(path, bytes, { mode: 0o600 });
            unlinkSync(path); await this.refused(cached, first.serviceId, reference); if (existsSync(path)) throw new Error('Missing export repaired implicitly'); writeFileSync(path, bytes, { mode: 0o600 });
            if (!(await cached.read(first.serviceId, reference, this.options())).equals(expected)) throw new Error('Fixture custody not restored');
            const latest=new Map<string,ReturnType<ServicePlanStore['resources']>[number]>();for(const resource of store.resources()){const prior=latest.get(resource.resourceId);if(!prior||prior.references.length<resource.references.length)latest.set(resource.resourceId,resource);}const bindings:ServiceSnapshot['resources']=[];for(const resource of latest.values())if(resource.references.includes(plan.compositionGeneration))bindings.push({resourceId:resource.resourceId,kind:resource.kind,serviceId:resource.serviceId,creatingGeneration:resource.creatingGeneration,receiptDigest:CanonicalJson.digest(resource)});bindings.sort(this.resourceOrder);const snapshot=ServiceSchemas.snapshot.parse({formatVersion:3,installationId:plan.configuration.installationId,installationDirectory:plan.configuration.installationDirectory,compositionGeneration:plan.compositionGeneration,resources:bindings,acknowledgements});event={...event,sequence:event.sequence+1,phase:'readiness'};store.append(event,writer);store.saveSnapshot(snapshot,writer);event={...event,sequence:event.sequence+1,phase:'commit'};store.append(event,writer);event={...event,sequence:event.sequence+1,phase:'completed',result:'ready',activeComposition:plan.compositionGeneration,resourceSetDigest:CanonicalJson.digest(snapshot.resources),acknowledgements:snapshot.acknowledgements};store.append(event,writer);await this.effects(plan,store,writer,exports,false);if(!(await cached.read(first.serviceId,reference,this.options())).equals(expected))throw new Error('Completed cached authority was unavailable');
            process.stdout.write(JSON.stringify({ fixtureOnly: true, nativeProbes: true, grants: true, concurrent: true, cancellation: true, privateState: true, sourceFree: true }) + '\n');
        } finally { for (const scope of scopes) await scope.close(); writer.close(); }
    }
    private static async effects(plan:ServicePlan,store:ServicePlanStore,writer:ReturnType<ServicePlanStore['writer']>,exports:ServiceAuthorityExports,uncached:boolean):Promise<void>{const before=CanonicalJson.stringify(store.resources()),refused:boolean[]=[];refused.push(await this.blocked(new ServiceContainerEngine(plan,writer).start(plan.composition.services[0]!.serviceId,plan.composition.services[0]!.definition),'ACCEPTED_ACTIVATION_REQUIRED'));refused.push(await this.blocked(new ServiceImages(plan).stage(writer),'ACCEPTED_STAGE_REQUIRED'));refused.push(await this.blocked(new ServiceCredentials(plan).prepare(writer),'ACCEPTED_PREPARATION_REQUIRED'));refused.push(await this.blocked(new ServiceProviderStager(plan).stage(plan.composition.services[0]!.serviceId,'container',writer),'ACCEPTED_STAGE_REQUIRED'));if(uncached){const id=plan.composition.services[2]!.serviceId;refused.push(await this.blocked(exports.read(id,'secret://'+id+'/public-ca',this.options()),'ACCEPTED_ACTIVATION_REQUIRED'));}if(!refused.every(this.truth)||before!==CanonicalJson.stringify(store.resources()))throw new Error('Historical phase authorized a retained effect adapter');}
    private static async blocked(pending:Promise<unknown>,code:string):Promise<boolean>{try{await pending;}catch(error){return error instanceof PlanningBlockedError&&error.blockers.some(this.code.bind(null,code));}return false;}
    private static code(code:string,value:{code:string}):boolean{return value.code===code;}
    private static truth(value:boolean):boolean{return value;}
    private static resourceOrder(a:{resourceId:string},b:{resourceId:string}):number{return a.resourceId<b.resourceId?-1:a.resourceId>b.resourceId?1:0;}
    private static async refused(exports: ServiceAuthorityExports, service: string, reference: string): Promise<void> { let denied = false; try { await exports.read(service, reference, this.options()); } catch (error) { denied = error instanceof PlanningBlockedError; } if (!denied) throw new Error('Uncertain authority custody adopted'); }
    private static equal(expected: Buffer, bytes: Buffer): boolean { return bytes.equals(expected); }
    private static authority(item: { kind: string }): boolean { return item.kind === 'authority'; }
    private static selected(id: string, item: { serviceId: string | null }): boolean { return item.serviceId === id; }
    private static delay(done: (value: void) => void): void { setTimeout(done, 100); }
}
await AuthorityCustodyProgram.run(process.argv[2]!, process.argv[3]!,process.argv[4]==='fenced');
