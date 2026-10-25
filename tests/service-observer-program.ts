import { readFileSync, rmSync } from 'node:fs';
import { ServiceSchemas } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, ServiceHostRuntime, ServiceWorkerOwnerClient, ServiceWorkerClient, ServicePlanStore, ServiceRuntimeInspection } from '@treeseed-cordis/deployment';
class ObserverProgram {
    static async run(file: string): Promise<void> {
        const configuration = ServiceSchemas.configuration.parse(JSON.parse(readFileSync(file, 'utf8'))), plan = await new ComposeDeploymentHost().plan(configuration); if (plan.formatVersion !== 3) throw new Error('Wrong format'); const host = await ServiceHostRuntime.start(plan), owner = new ServiceWorkerOwnerClient({ installationDirectory: configuration.installationDirectory }), observer = new ServiceWorkerClient({ installationDirectory: configuration.installationDirectory });
        try {
            const accepted = await owner.submit({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'observer-mounted-fixture' }), until = Date.now() + 90000; let application = await owner.application(accepted.id);
            while (!['completed', 'failed', 'cancelled'].includes(application.phase) && Date.now() < until) { await new Promise(this.delay); application = await owner.application(accepted.id); }
            if (application.phase !== 'completed') throw new Error('Observer fixture failed: ' + JSON.stringify(application.blockers)); const status = await observer.status(); if (!status.ready || status.services.length !== 1 || new ServicePlanStore(configuration.installationDirectory).records().length !== 1) throw new Error('Observer submitted owner work or was not ready');
            rmSync(configuration.release.directory, { recursive: true }); if (!(await observer.status()).ready) throw new Error('Observer required original sources'); await host.close(); if (!(await new ServiceRuntimeInspection(plan).service('observer-17')).running) throw new Error('Host close stopped container');
            process.stdout.write(JSON.stringify({ fixtureOnly: true, observerRead: true, readonly: true, ownerDenied: true, measuredEntry: true, sourceFree: true, retained: true }) + '\n');
        } finally { await host.close(); }
    }
    private static delay(accept: (value: void) => void): void { setTimeout(accept, 100); }
}
await ObserverProgram.run(process.argv[2]!);
