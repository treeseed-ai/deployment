import { readFileSync, rmSync } from 'node:fs';
import { ComposeDeploymentHost, ServicePlanStore } from '@treeseed-cordis/deployment';
import { ServiceSchemas, CanonicalJson } from '@treeseed-cordis/sdk';
class JournalProgram {
    static async run(file: string): Promise<void> { const configuration = ServiceSchemas.configuration.parse(JSON.parse(readFileSync(file, 'utf8'))), plan = await new ComposeDeploymentHost().plan(configuration); if (plan.formatVersion !== 3)
        throw new Error('Wrong format'); const store = new ServicePlanStore(configuration.installationDirectory), writer = store.writer(); try {
        const request = { protocol: 3 as const, operation: 'submit' as const, planId: plan.id, digest: plan.digest, idempotencyKey: 'fixture-explicit-observations' }, accepted = store.accept(request, writer);
        if (!accepted.fresh || store.accept(request, writer).fresh)
            throw new Error('Retry mismatch');
        let record = accepted.record;
        for (const phase of ['stage', 'prepare', 'activate', 'readiness', 'commit'] as const) {
            record = { ...record, sequence: record.sequence + 1, phase, result: null };
            store.append(record, writer);
        }
        const acknowledgement = { target: 'deployment' as const, scopeId: 'explicit-journal-fixture', generation: plan.compositionGeneration, runtimeGeneration: 'a'.repeat(64), observationDigest: CanonicalJson.digest({ fixtureOnly: true, noRuntimeInspection: true }), ready: true }, resource = ServiceSchemas.resourceReceipt.parse({ formatVersion: 3, installationId: configuration.installationId, installationDirectory: configuration.installationDirectory, resourceId: 'b'.repeat(64), kind: 'container', serviceId: plan.composition.services[0]!.serviceId, name: 'fixture-uncreated-container', creatingGeneration: plan.compositionGeneration, definitionDigest: 'c'.repeat(64), references: [plan.compositionGeneration], actualId: 'fixture-observation-only', contentDigest: null, imageDigest: 'd'.repeat(64), path: null, ownerUid: process.getuid!(), legacy: null });
        store.saveResource(resource, writer);
        const snapshot = ServiceSchemas.snapshot.parse({ formatVersion: 3, installationId: configuration.installationId, installationDirectory: configuration.installationDirectory, compositionGeneration: plan.compositionGeneration, resources: [{ resourceId: resource.resourceId, kind: resource.kind, serviceId: resource.serviceId, creatingGeneration: resource.creatingGeneration, receiptDigest: CanonicalJson.digest(resource) }], acknowledgements: [acknowledgement] });
        store.saveSnapshot(snapshot, writer);
        record = { ...record, sequence: record.sequence + 1, phase: 'completed', result: 'ready', activeComposition: plan.compositionGeneration, resourceSetDigest: CanonicalJson.digest(snapshot.resources), acknowledgements: snapshot.acknowledgements };
        store.append(record, writer);
        rmSync(configuration.release.directory, { recursive: true });
        if (store.records()[0]!.id !== record.id || store.current()!.compositionGeneration !== plan.compositionGeneration || store.resources().length !== 1)
            throw new Error('Read-back mismatch');
        process.stdout.write(JSON.stringify({ fixtureOnly: true, applicationId: record.id, records: store.records().length, resourceSetDigest: record.resourceSetDigest }) + '\n');
    }
    finally {
        writer.close();
    } }
}
await JournalProgram.run(process.argv[2]!);
