import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceReleaseFixture } from './release-fixture.js';
import { ServiceProjection } from '../src/service-projection.js';
import { CredentialContainerFixture } from './service-fixture-plugins.js';
import { ServiceSchemas, CanonicalJson } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, ServicePlanStore, ServiceCredentials } from '../src/diagnose.js';
class CredentialTests {
    async bounded():Promise<void>{const fixture=await new ServiceReleaseFixture().withCredentials();try{const initial=await new ComposeDeploymentHost().plan(fixture.configuration);if(initial.formatVersion!==3)throw new Error('Wrong format');const {id:_id,digest:_digest,...payload}=structuredClone(initial);payload.composition.services[0]!.resources.slots.seed={kind:'text',value:'x'.repeat(65536)};payload.composition.services[0]!.resources.slots.amplified={kind:'text',value:{$template:new Array(128).fill({$secret:'secret://instance-0/seed'})}};payload.configuration.credentialReferences.push('secret://instance-0/seed','secret://instance-0/amplified');payload.configurationDigest=CanonicalJson.digest(payload.configuration);payload.compositionGeneration=CanonicalJson.digest({configuration:payload.configuration,composition:payload.composition,expectedEngine:payload.expectedEngine,artifacts:payload.artifacts});const digest=CanonicalJson.digest(payload),synthetic=ServiceSchemas.plan.parse({...payload,id:'plan-'+digest,digest}),store=new ServicePlanStore(fixture.installation);store.publish(synthetic);const writer=store.writer();try{let record=store.accept({protocol:3,operation:'submit',planId:synthetic.id,digest:synthetic.digest,idempotencyKey:'synthetic-bounded-template'},writer).record;for(const phase of ['stage','prepare'] as const){record={...record,sequence:record.sequence+1,phase,result:null};store.append(record,writer);}await expect(new ServiceCredentials(synthetic).prepare(writer)).rejects.toThrow();expect(existsSync(join(fixture.installation,'.cordis/credentials'))).toBe(false);expect(store.resources()).toEqual([]);}finally{writer.close();}}finally{fixture.close();}}

    async retained(): Promise<void> { const fixture = await new ServiceReleaseFixture().withCredentials(); try {
        const host = new ComposeDeploymentHost(), first = await host.plan(fixture.configuration);
        if (first.formatVersion !== 3)
            throw new Error('Wrong format');
        const store = new ServicePlanStore(fixture.installation);
        let writer = store.writer(), before = new Map<string, {
            resourceId: string;
            creator: string;
            path: string;
            bytes: Buffer;
        }>();
        try {
            let record = store.accept({ protocol: 3, operation: 'submit', planId: first.id, digest: first.digest, idempotencyKey: 'retained-first' }, writer).record;
            for (const phase of ['stage', 'prepare'] as const) {
                record = { ...record, sequence: record.sequence + 1, phase, result: null };
                store.append(record, writer);
            }
            await new ServiceCredentials(first).prepare(writer);
            for (const receipt of store.resources())
                before.set(receipt.path!, { resourceId: receipt.resourceId, creator: receipt.creatingGeneration, path: receipt.path!, bytes: readFileSync(join(fixture.installation, '.cordis', receipt.path!)) });
            store.append({ ...record, sequence: record.sequence + 1, phase: 'cancelled', result: null }, writer);
        }
        finally {
            writer.close();
        }
        const graph = fixture.release.composition, service = ServiceSchemas.service.parse({ ...graph.services[1]!, serviceId: 'instance-5', bindings: [{ port: 'http', bindingId: 'instance-5', contractId: 'fixture.echo', contractVersion: '1.0.0' }], readiness: { ...graph.services[1]!.readiness, endpoint: { serviceId: 'instance-5', portId: 'http' } } });
        graph.services.push(service);
        const projected = ServiceProjection.resolve(service, CredentialContainerFixture.container, graph, fixture.configuration);
        service.definition = projected.definition;
        service.resources = projected.resources;
        const secrets: string[] = [];
        fixture.recipe.services['instance-5'] = { image: fixture.release.images[0]!.reference, secrets };
        for (const slot of Object.keys(service.resources.slots)) {
            const key = 'r-' + CanonicalJson.digest({ serviceId: service.serviceId, slot }).slice(0, 48);
            fixture.recipe.secrets[key] = { file: '.cordis/credentials/' + service.serviceId + '/' + slot };
            fixture.configuration.credentialReferences.push('secret://' + service.serviceId + '/' + slot);
        }
        for (const item of service.definition.secrets)
            secrets.push('r-' + CanonicalJson.digest({ serviceId: service.serviceId, slot: item.slot }).slice(0, 48));
        fixture.refreshService();
        const second = await host.plan(fixture.configuration);
        if (second.formatVersion !== 3)
            throw new Error('Wrong format');
        expect(second.compositionGeneration).not.toBe(first.compositionGeneration);
        writer = store.writer();
        try {
            let record = store.accept({ protocol: 3, operation: 'submit', planId: second.id, digest: second.digest, idempotencyKey: 'retained-second' }, writer).record;
            for (const phase of ['stage', 'prepare'] as const) {
                record = { ...record, sequence: record.sequence + 1, phase, result: null };
                store.append(record, writer);
            }
            const credentials = new ServiceCredentials(second);
            await credentials.prepare(writer);
            const latest = new Map<string, string>();
            for (const resource of store.resources()) {
                latest.set(resource.resourceId, resource.path!);
                const prior = before.get(resource.path!);
                if (prior) {
                    expect(resource.creatingGeneration).toBe(prior.creator);
                    expect(resource.resourceId).toBe(prior.resourceId);
                    expect(readFileSync(join(fixture.installation, '.cordis', resource.path!)).equals(prior.bytes)).toBe(true);
                }
            }
            expect(latest.size).toBe(11);
            expect(credentials.read('instance-5', 'secret://instance-5/password').equals(credentials.read('instance-1', 'secret://instance-1/password'))).toBe(false);
        }
        finally {
            writer.close();
        }
    }
    finally {
        fixture.close();
    } }
    async program(): Promise<void> { const fixture = await new ServiceReleaseFixture().withCredentials(); try {
        const input = join(fixture.root, 'credential-input.json');
        writeFileSync(input, JSON.stringify(fixture.configuration));
        const result = spawnSync('node', ['dist/tests/service-credentials-program.js', input], { encoding: 'utf8', timeout: 30000 });
        if (result.status !== 0)
            throw new Error(result.stderr);
        expect(JSON.parse(result.stdout)).toEqual({ fixtureOnly: true, slots: 8, referenceCount: 8, ready: false });
        const store = new ServicePlanStore(fixture.installation);
        for (const resource of store.resources()) {
            expect(resource.contentDigest).toMatch(/^[a-f0-9]{64}$/);
            expect(resource.path).toMatch(/^credentials\//);
            expect(statSync(join(fixture.installation, '.cordis', resource.path!)).mode & 0o777).toBe(0o600);
        }
        expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(false);
    }
    finally {
        fixture.close();
    } }
    async scopes(): Promise<void> { const fixture = await new ServiceReleaseFixture().withCredentials(); try {
        const plan = await new ComposeDeploymentHost().plan(fixture.configuration);
        if (plan.formatVersion !== 3)
            throw new Error('Wrong format');
        const store = new ServicePlanStore(fixture.installation), writer = store.writer(), credentials = new ServiceCredentials(plan);
        try {
            await expect(credentials.prepare(writer)).rejects.toThrow();
            expect(existsSync(join(fixture.installation, '.cordis/credentials'))).toBe(false);
            let record = store.accept({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'scope' }, writer).record;
            for (const phase of ['stage', 'prepare'] as const) {
                record = { ...record, sequence: record.sequence + 1, phase, result: null };
                store.append(record, writer);
            }
            await credentials.prepare(writer);
            expect(credentials.read.bind(credentials, 'instance-2', 'secret://instance-1/password')).toThrow();
            expect(credentials.probe.bind(credentials, 'instance-2', 'secret://instance-2/password')).toThrow();
            expect(credentials.probe('instance-2', 'secret://instance-0/password').length).toBeGreaterThan(0);const mount=credentials.mount('instance-0','password');expect(readFileSync(join(fixture.installation,'.cordis',mount.path)).equals(credentials.read('instance-0','secret://instance-0/password'))).toBe(true);expect(credentials.mount.bind(credentials,'instance-0','identity')).toThrow();
            const receipt = store.resources()[0]!, file = join(fixture.installation, '.cordis', receipt.path!), bytes = readFileSync(file);
            chmodSync(file, 0o644);
            expect(credentials.read.bind(credentials, receipt.serviceId!, 'secret://' + receipt.serviceId + '/' + receipt.name)).toThrow();
            chmodSync(file, 0o600);
            writeFileSync(file, 'changed');
            await expect(credentials.prepare(writer)).rejects.toThrow();
            writeFileSync(file, bytes);
        }
        finally {
            writer.close();
        }
    }
    finally {
        fixture.close();
    } }
    async incomplete(): Promise<void> { const fixture = await new ServiceReleaseFixture().withCredentials(); try {
        const plan = await new ComposeDeploymentHost().plan(fixture.configuration);
        if (plan.formatVersion !== 3)
            throw new Error('Wrong format');
        const store = new ServicePlanStore(fixture.installation), writer = store.writer();
        try {
            let record = store.accept({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'incomplete' }, writer).record;
            for (const phase of ['stage', 'prepare'] as const) {
                record = { ...record, sequence: record.sequence + 1, phase, result: null };
                store.append(record, writer);
            }
            mkdirSync(join(fixture.installation, '.cordis/credentials'), { mode: 0o700 });
            mkdirSync(join(fixture.installation, '.cordis/credentials/instance-0'), { mode: 0o700 });
            await expect(new ServiceCredentials(plan).prepare(writer)).rejects.toThrow();
            expect(store.resources()).toEqual([]);
        }
        finally {
            writer.close();
        }
    }
    finally {
        fixture.close();
    } }
}
const suite = new CredentialTests();
test('smoke: built slot custodian isolates instances resolves grants and retains private bytes', suite.program.bind(suite), 30000);
test('integration: credential reads enforce declared service and probe grants with tamper refusal', suite.scopes.bind(suite));
test('integration: incomplete credential state is never silently adopted', suite.incomplete.bind(suite));
test('integration: added instance preserves existing credential bytes paths and creator receipts', suite.retained.bind(suite), 30000);

test('integration: synthetic oversized template contract fails before private publication',suite.bounded.bind(suite),30000);
