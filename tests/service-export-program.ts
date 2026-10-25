import { readFileSync } from 'node:fs';
import { CanonicalJson, ServiceSchemas } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, ServiceApplicationRuntime, ServicePlanStore, LocalDockerCommands, AuthorityArchive } from '@treeseed-cordis/deployment';
class AuthorityExportProgram {
    static async run(file: string, certificate: string): Promise<void> {
        const configuration = ServiceSchemas.configuration.parse(JSON.parse(readFileSync(file, 'utf8'))), plan = await new ComposeDeploymentHost().plan(configuration);
        if (plan.formatVersion !== 3) throw new Error('Wrong plan format');
        const runtime = await ServiceApplicationRuntime.start(plan);
        try {
            const accepted = await runtime.submit({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'authority-export-program' });
            const deadline = Date.now() + 120000;
            let application = await runtime.application(accepted.id);
            while (!['completed', 'failed', 'cancelled'].includes(application.phase) && Date.now() < deadline) { await new Promise(this.delay); application = await runtime.application(accepted.id); }
            if (application.phase !== 'completed' || !(await runtime.status()).ready) throw new Error('Fixture not ready');
            const store = new ServicePlanStore(configuration.installationDirectory), commands = new LocalDockerCommands(), service = plan.composition.services[0]!;
            const container = store.resources().find(this.selected.bind(null, service.serviceId));
            if (!container?.actualId) throw new Error('Missing receipted container');
            const journal = CanonicalJson.stringify({ applications: store.records(), resources: store.resources(), snapshot: store.current() }), resources = await this.resources(commands, plan.expectedEngine);
            await commands.verify(plan.expectedEngine);
            const bytes = await AuthorityArchive.read(await commands.archive(plan.expectedEngine, container.actualId, '/data/root.crt', 5000), 'root.crt');
            await commands.verify(plan.expectedEngine);
            if (!bytes.equals(readFileSync(certificate)) || journal !== CanonicalJson.stringify({ applications: store.records(), resources: store.resources(), snapshot: store.current() }) || resources !== await this.resources(commands, plan.expectedEngine)) throw new Error('Authority read changed state or bytes');
            process.stdout.write(JSON.stringify({ fixtureOnly: true, publicCa: true, readOnly: true }) + '\n');
        } finally { await runtime.close(); }
    }
    private static selected(serviceId: string, item: { serviceId: string | null; kind: string }): boolean { return item.serviceId === serviceId && item.kind === 'container'; }
    private static async resources(commands: LocalDockerCommands, engine: Parameters<LocalDockerCommands['verify']>[0]): Promise<string> { const result: string[] = []; for (const kind of ['container', 'network', 'volume']) result.push(await commands.run(engine, kind === 'container' ? [kind, 'ls', '--all', '--no-trunc', '--format', '{{json .}}'] : [kind, 'ls', '--format', '{{json .}}'])); return result.join('\n'); }
    private static delay(done: (value: void) => void): void { setTimeout(done, 100); }
}
await AuthorityExportProgram.run(process.argv[2]!, process.argv[3]!);
