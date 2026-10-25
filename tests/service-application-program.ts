import { createServer, type Server } from 'node:net';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { CanonicalJson, ServiceSchemas } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, ServiceApplicationRuntime, ServicePlanStore } from '@treeseed-cordis/deployment';
class ApplicationProgram {
    private static listener: Server | null = null;
    static async run(file: string, expected = 'completed'): Promise<void> {
        const configuration = ServiceSchemas.configuration.parse(JSON.parse(readFileSync(file, 'utf8'))), plan = await new ComposeDeploymentHost().plan(configuration);
        if (plan.formatVersion !== 3)
            throw new Error('Wrong format');
        const runtime = await ServiceApplicationRuntime.start(plan);
        if (expected === 'drain-only') {
            const pending = runtime.status();
            let refused = false;
            try {
                await runtime.close(0);
            }
            catch {
                refused = true;
            }
            try {
                await pending;
            }
            catch { }
            if (!refused)
                throw new Error('Undrained root closed');
            await runtime.close();
            if (existsSync(configuration.installationDirectory + '/.cordis/writer.lock'))
                throw new Error('Host falsely reported cleanup');
            const fresh = await ServiceApplicationRuntime.start(plan);
            await fresh.close();
            process.stdout.write(JSON.stringify({ fixtureOnly: true, ready: false, application: { phase: 'none', result: 'none' }, resourceCount: 0, status: { services: [] } }) + '\n');
            return;
        }
        let result;
        try {
            if (expected === 'port-conflict')
                await this.occupy(Number(new URL(configuration.origin).port));
            const request = { protocol: 3 as const, operation: 'submit' as const, planId: plan.id, digest: plan.digest, idempotencyKey: 'application-program' }, first = await runtime.submit(request), again = await runtime.submit(request);
            if (first.id !== again.id)
                throw new Error('Lost response changed application');
            const store = new ServicePlanStore(configuration.installationDirectory), initial = store.records()[0]!;
            if (initial.id !== first.id || initial.idempotencyKey !== request.idempotencyKey)
                throw new Error('Missing durable intent');
            if (expected !== 'port-conflict') {
                let denied = false;
                try {
                    await runtime.submit({ ...request, idempotencyKey: 'concurrent-new-request' });
                }
                catch {
                    denied = true;
                }
                if (!denied)
                    throw new Error('Concurrent application admitted');
            }
            const deadline = Date.now() + 120000;
            let application = await runtime.application(first.id);
            while (!['completed', 'failed', 'cancelled'].includes(application.phase) && Date.now() < deadline) {
                await new Promise(ApplicationProgram.delay);
                application = await runtime.application(first.id);
            }
            if (expected === 'port-conflict') {
                if (application.phase !== 'failed' || application.recovery !== null || store.resources().length || existsSync(configuration.installationDirectory + '/.cordis/artifacts'))
                    throw new Error('Prerequisite failure performed effects');
                result = { fixtureOnly: true, ready: false, application, resourceCount: 0, status: await runtime.status() };
            }
            else if (expected === 'failed') {
                if (application.phase !== 'failed' || application.recovery !== 'repair-required' || store.current() !== null || store.resources().length === 0)
                    throw new Error('Unready effects were accepted or discarded');
                const status = await runtime.status();
                if (status.ready || status.activeComposition !== null || status.acknowledgements.length || !status.blockers.some(ApplicationProgram.repair))
                    throw new Error('Unsafe failure envelope');
                let refused = false;
                try {
                    await runtime.submit({ ...request, idempotencyKey: 'after-uncertain-effects' });
                }
                catch {
                    refused = true;
                }
                if (!refused)
                    throw new Error('Uncertain application retried');
                result = { fixtureOnly: true, ready: false, application, resourceCount: store.resources().length, status };
            }
            else {
                if (application.phase !== 'completed')
                    throw new Error('Application failed: ' + application.phase + ' ' + application.recovery);
                if (configuration.runtimeState === 'running') {
                    const status = await runtime.status(), snapshot = store.current();
                    if (!status.ready || status.activeComposition !== plan.compositionGeneration || !snapshot || status.services.length !== 5 || status.acknowledgements.length !== 5 || status.resourceSetDigest !== CanonicalJson.digest(snapshot.resources))
                        throw new Error('Unverified active snapshot');
                    rmSync(configuration.release.directory, { recursive: true });
                    if (!(await runtime.status()).ready || (await runtime.submit(request)).id !== first.id)
                        throw new Error('Stored operation reopened original bundle');
                    const container = store.resources().find(ApplicationProgram.container);
                    if (!container?.actualId)
                        throw new Error('Missing runtime container');
                    const stop = spawnSync('docker', ['container', 'stop', container.actualId], { encoding: 'utf8', timeout: 30000 });
                    if (stop.status !== 0)
                        throw new Error('Fixture stop failed');
                    const unavailable = await runtime.status();
                    if (unavailable.ready || unavailable.activeComposition !== plan.compositionGeneration)
                        throw new Error('Stopped container reported ready');
                    result = { fixtureOnly: true, ready: true, application, resourceCount: snapshot.resources.length, status, downReady: unavailable.ready };
                }
                else {
                    const status = await runtime.status();
                    if (application.result !== 'stopped' || status.ready || status.activeComposition !== null || store.current() !== null || store.resources().length)
                        throw new Error('Stopped apply activated resources');
                    result = { fixtureOnly: true, ready: false, application, resourceCount: 0, status };
                }
            }
        }
        finally {
            await runtime.close();
            if (this.listener)
                await new Promise<void>(this.closePort.bind(this));
        }
        let refused = false;
        try {
            await ServiceApplicationRuntime.start(plan);
        }
        catch {
            refused = true;
        }
        if (!refused)
            throw new Error('Prior runtime silently adopted');
        process.stdout.write(JSON.stringify(result) + '\n');
    }
    private static occupy(port: number): Promise<void> { this.listener = createServer(); return new Promise<void>(this.listen.bind(this, port)); }
    private static listen(port: number, done: (value: void) => void): void { this.listener!.listen(port, '127.0.0.1', done); }
    private static closePort(done: (value: void) => void): void { this.listener!.close(this.portClosed.bind(this, done)); }
    private static portClosed(done: (value: void) => void): void { this.listener = null; done(); }
    private static repair(value: {
        code: string;
    }): boolean { return value.code === 'APPLICATION_RECOVERY_REQUIRED'; }
    private static container(value: {
        kind: string;
    }): boolean { return value.kind === 'container'; }
    private static delay(done: (value: void) => void): void { setTimeout(done, 50); }
}
await ApplicationProgram.run(process.argv[2]!, process.argv[3]);
