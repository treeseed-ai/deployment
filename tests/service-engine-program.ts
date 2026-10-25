import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CanonicalJson, ServiceSchemas } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, ServicePlanStore, ServiceImages, ServiceCredentials, ServiceContainerEngine, ScopedServiceEngine, ServiceRuntimeInspection } from '@treeseed-cordis/deployment';
class EngineProgram {
    static async run(file: string): Promise<void> { const configuration = ServiceSchemas.configuration.parse(JSON.parse(readFileSync(file, 'utf8'))), plan = await new ComposeDeploymentHost().plan(configuration); if (plan.formatVersion !== 3)
        throw new Error('Wrong format'); const store = new ServicePlanStore(configuration.installationDirectory), writer = store.writer(); try {
        let event = store.accept({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'engine-fixture' }, writer).record;
        const engine = new ServiceContainerEngine(plan, writer);
        let refused = false;
        try {
            await engine.start(plan.composition.services[0]!.serviceId, plan.composition.services[0]!.definition);
        }
        catch {
            refused = true;
        }
        if (!refused || store.resources().length)
            throw new Error('Unaccepted activation');
        event = { ...event, sequence: 1, phase: 'stage', result: null };
        store.append(event, writer);
        await new ServiceImages(plan).stage(writer);
        event = { ...event, sequence: 2, phase: 'prepare' };
        store.append(event, writer);
        await new ServiceCredentials(plan).prepare(writer);
        event = { ...event, sequence: 3, phase: 'activate' };
        store.append(event, writer);
        const identities = [];
        for (const service of plan.composition.services) {
            const scope = new ScopedServiceEngine(service.serviceId, engine);
            await scope.start(service.serviceId, service.definition);
            identities.push(scope.identity(service.serviceId));
            const observed = await new ServiceRuntimeInspection(plan).service(service.serviceId);
            if (!observed.running)
                throw new Error('Not running');
            let response: Response | undefined;
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
                try {
                    response = await fetch(observed.endpoint, { signal: AbortSignal.timeout(500) });
                    if (response.ok)
                        break;
                }
                catch { }
                await new Promise(EngineProgram.delay);
            }
            if (!response?.ok)
                throw new Error('Direct fixture protocol unavailable');
            const result = await response.json() as {
                serviceId: string;
                passwordPresent: boolean;
                volumeMarker: string;
            };
            if (result.serviceId !== service.serviceId || result.volumeMarker !== service.serviceId || !result.passwordPresent)
                throw new Error('Cross-instance configuration');
            if ((await scope.ready(service.serviceId)).ready)
                throw new Error('Engine claimed protocol readiness');
            let denied = false;
            try {
                await scope.start('foreign', service.definition);
            }
            catch {
                denied = true;
            }
            if (!denied)
                throw new Error('Scope escape');
        }
        const before = CanonicalJson.stringify(store.resources());
        for (const service of plan.composition.services)
            await engine.start(service.serviceId, service.definition);
        if (before !== CanonicalJson.stringify(store.resources()))
            throw new Error('Resource reuse changed receipts');
        await new ServiceRuntimeInspection(plan).audit();
        const last = plan.composition.services.at(-1)!;
        let denied = false;
        try {
            await engine.start(last.serviceId, { ...last.definition, command: ['sh', '-c', 'true'] });
        }
        catch {
            denied = true;
        }
        if (!denied)
            throw new Error('Unaccepted recipe');
        const foreign = plan.projectName + '_uncertain';
        EngineProgram.docker(['volume', 'create', '--label', 'com.docker.compose.project=' + plan.projectName, foreign]);
        try {
            let blocked = false;
            try {
                await new ServiceRuntimeInspection(plan).audit();
            }
            catch {
                blocked = true;
            }
            if (!blocked)
                throw new Error('Unreceipted resource adopted');
        }
        finally {
            EngineProgram.docker(['volume', 'rm', foreign]);
        }
        const stopped = await new ServiceRuntimeInspection(plan).service(last.serviceId);
        EngineProgram.docker(['container', 'stop', stopped.actualId]);
        let restarted = false;
        try {
            await engine.start(last.serviceId, last.definition);
            restarted = true;
        }
        catch { }
        if (restarted || (await new ServiceRuntimeInspection(plan).service(last.serviceId)).running)
            throw new Error('Implicit restart');
        process.stdout.write(JSON.stringify({ fixtureOnly: true, identities, resources: store.resources(), ready: false }) + '\n');
    }
    finally {
        writer.close();
    } }
    private static docker(args: string[]): void { const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 }); if (result.status !== 0)
        throw new Error('Disposable fixture Docker operation failed'); }
    private static delay(done: (value: void) => void): void { setTimeout(done, 100); }
}
await EngineProgram.run(process.argv[2]!);
