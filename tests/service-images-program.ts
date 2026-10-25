import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ComposeDeploymentHost, ServicePlanStore, ServiceImages } from '@treeseed-cordis/deployment';
import { ServiceSchemas, CanonicalJson } from '@treeseed-cordis/sdk';
class ImageProgram {
    private static resources(): string { const values = []; for (const args of [['container', 'ls', '--all', '--no-trunc', '--quiet'], ['network', 'ls', '--quiet'], ['volume', 'ls', '--quiet']]) {
        const result = spawnSync('docker', args, { encoding: 'utf8' });
        if (result.status !== 0)
            throw new Error('Missing Docker prerequisite');
        values.push(result.stdout.split('\n').sort());
    } return CanonicalJson.stringify(values); }
    static async run(file: string): Promise<void> { const configuration = ServiceSchemas.configuration.parse(JSON.parse(readFileSync(file, 'utf8'))), before = this.resources(), plan = await new ComposeDeploymentHost().plan(configuration); if (plan.formatVersion !== 3)
        throw new Error('Wrong format'); const store = new ServicePlanStore(configuration.installationDirectory), writer = store.writer(); try {
        const record = store.accept({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'image-fixture' }, writer).record;
        store.append({ ...record, sequence: 1, phase: 'stage', result: null }, writer);
        const images = new ServiceImages(plan), first = await images.stage(writer), again = await images.stage(writer);
        if (CanonicalJson.stringify(first) !== CanonicalJson.stringify(again))
            throw new Error('Image reuse differs');
        const bindings = Object.values(first);
        if (bindings.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(bindings[0]!.dockerId))
            throw new Error('Invalid image identity');
        if (before !== this.resources())
            throw new Error('Image preparation changed runtime resources');
        if (existsSync(configuration.installationDirectory + '/.cordis/credentials'))
            throw new Error('Images created credentials');
        process.stdout.write(JSON.stringify({ fixtureOnly: true, bindings: first, ready: false }) + '\n');
    }
    finally {
        writer.close();
    } }
}
await ImageProgram.run(process.argv[2]!);
