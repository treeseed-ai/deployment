import { ComposeDeploymentHost, ServicePlanStore, DockerCommands, ServiceApplicationRuntime } from '@treeseed-cordis/deployment';
import { CanonicalJson, ServiceSchemas, type ServicePlan } from '@treeseed-cordis/sdk';
import { readFileSync, rmSync, existsSync } from 'node:fs';
class SourcePolicyProgram {
    private static snapshot(): string {
        const commands = new DockerCommands(), values = [];
        for (const args of [['ps', '--all', '--format', '{{.ID}}'], ['network', 'ls', '--format', '{{.ID}}'], ['volume', 'ls', '--format', '{{.Name}}']]) {
            const value = commands.execute(args);
            if (value === null)
                throw new Error('Docker prerequisite missing');
            values.push(value.split('\n').sort());
        }
        return CanonicalJson.stringify(values);
    }
    static async run(file: string, mode?: string): Promise<void> {
        const configuration = JSON.parse(readFileSync(file, 'utf8')), before = this.snapshot(), host = new ComposeDeploymentHost(), plan = await host.plan(configuration);
        if (plan.formatVersion !== 3 || !plan.acquisitionPolicy)
            throw new Error('ACCEPTED_SOURCE_POLICY_MISSING');
        if (mode?.startsWith('forged-')) {
            await this.forged(plan, mode);
            if (before !== this.snapshot())
                throw new Error('Forged metadata changed Docker');
            process.stdout.write(JSON.stringify({ fixture: true, forgedMetadataRefused: true, noRuntimeEffects: true }) + '\n');
            return;
        }
        if (plan.acquisitionPolicy.npm[0]!.packages.join(',') !== '@fixture/a,@fixture/z' || plan.acquisitionPolicy.npm[0]!.targets.join(',') !== 'cli,deployment')
            throw new Error('Source policy semantic sets not normalized');
        const repeated = await host.plan(configuration);
        if (CanonicalJson.stringify(repeated) !== CanonicalJson.stringify(plan))
            throw new Error('Policy plan is nondeterministic');
        rmSync(configuration.release.directory, { recursive: true });
        const read = new ServicePlanStore(configuration.installationDirectory).read(plan.id, plan.digest);
        if (CanonicalJson.stringify(read.acquisitionPolicy) !== CanonicalJson.stringify(plan.acquisitionPolicy))
            throw new Error('Source-free policy custody differs');
        if (before !== this.snapshot() || existsSync(configuration.installationDirectory + '/.cordis/credentials'))
            throw new Error('Policy planning changed runtime or credentials');
        process.stdout.write(JSON.stringify({ fixture: true, policy: true, normalized: true, deterministic: true, sourceFree: true, noRuntimeEffects: true }) + '\n');
    }
    private static async forged(plan: ServicePlan, mode: string): Promise<void> { const copy = structuredClone(plan); if (mode === 'forged-policy')
        copy.acquisitionPolicy!.npm[0]!.packages.push('@unapproved/plugin');
    else
        copy.helpers!.helpers[0]!.version = '9.9.9'; const { id, digest, ...payload } = copy, hash = CanonicalJson.digest(payload), forged = ServiceSchemas.plan.parse({ ...payload, id: 'plan-' + hash, digest: hash }), store = new ServicePlanStore(plan.configuration.installationDirectory); store.publish(forged); const host = await ServiceApplicationRuntime.start(forged); try {
        const accepted = await host.submit({ protocol: 3, operation: 'submit', planId: forged.id, digest: forged.digest, idempotencyKey: 'forged-metadata' });
        const deadline = Date.now() + 10000;
        let record = await host.application(accepted.id);
        while (!['failed', 'completed'].includes(record.phase) && Date.now() < deadline) {
            await new Promise(this.delay);
            record = await host.application(accepted.id);
        }
        if (record.phase !== 'failed' || store.resources().length || existsSync(plan.configuration.installationDirectory + '/.cordis/artifacts') || existsSync(plan.configuration.installationDirectory + '/.cordis/credentials'))
            throw new Error('Forged metadata reached staging or active');
    }
    finally {
        await host.close();
    } }
    private static delay(done: (value: void) => void): void { setTimeout(done, 50); }
}
await SourcePolicyProgram.run(process.argv[2]!, process.argv[3]);
