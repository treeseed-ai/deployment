import { readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { ComposeDeploymentHost, ServicePlanStore, DockerCommands } from '@treeseed-cordis/deployment';
import { ServiceSchemas } from '@treeseed-cordis/sdk';
class ServicePlanProgram {
    private static listeners(path: string): string[] { const result: string[] = []; for (const line of readFileSync(path, 'utf8').trim().split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields[3] === '0A')
            result.push(fields.slice(1, 4).join(' '));
    } return result.sort(); }
    private static snapshot(): string { const docker = new DockerCommands(), result: unknown[] = []; for (const args of [['ps', '--all', '--format', '{{.ID}} {{.Names}} {{.Labels}} {{.Image}}'], ['network', 'ls', '--format', '{{.ID}} {{.Name}} {{.Labels}}'], ['volume', 'ls', '--format', '{{.Name}} {{.Driver}} {{.Labels}}'], ['image', 'ls', '--no-trunc', '--format', '{{.ID}} {{.Repository}} {{.Tag}} {{.Digest}}']]) {
        const text = docker.execute(args);
        if (text === null)
            throw new Error('Missing Docker prerequisite');
        result.push(text.split('\n').sort());
    } result.push(this.listeners('/proc/net/tcp'), this.listeners('/proc/net/tcp6')); return JSON.stringify(result); }
    static async run(file: string): Promise<void> { const input = ServiceSchemas.configuration.parse(JSON.parse(readFileSync(file, 'utf8'))), before = this.snapshot(), host = new ComposeDeploymentHost(), plan = await host.plan(input); if (plan.formatVersion !== 3 || plan.composition.services.length !== 5 || plan.changes.length !== 5 || plan.blockers.length)
        throw new Error('Invalid service plan'); const again = await host.plan(input); if (JSON.stringify(again) !== JSON.stringify(plan))
        throw new Error('Plan repetition differs'); const store = new ServicePlanStore(input.installationDirectory); if (JSON.stringify(store.read(plan.id, plan.digest)) !== JSON.stringify(plan))
        throw new Error('Read-back differs'); if ((statSync(input.installationDirectory + '/.cordis/plans/' + plan.id + '.json').mode & 0o777) !== 0o600)
        throw new Error('Plan is not private'); rmSync(input.release.directory, { recursive: true }); store.read(plan.id, plan.digest); if (existsSync(input.installationDirectory + '/.cordis/credentials'))
        throw new Error('Unexpected credentials'); if (before !== this.snapshot())
        throw new Error('Runtime or listeners changed'); process.stdout.write(JSON.stringify({ id: plan.id, digest: plan.digest, formatVersion: 3 }) + '\n'); }
}
await ServicePlanProgram.run(process.argv[2]!);
