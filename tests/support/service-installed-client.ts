import { readFileSync } from 'node:fs';
import { ComposeDeploymentHost } from '@treeseed-cordis/deployment';
import { ServiceSchemas, InstalledSchemas, PlanningBlockedError } from '@treeseed-cordis/sdk';
class InstalledClient {
    static async run(file: string): Promise<void> {
        try {
            const input = JSON.parse(readFileSync(file, 'utf8')), planId = ServiceSchemas.plan.shape.id.parse(input.planId), digest = ServiceSchemas.plan.shape.digest.parse(input.digest), options = InstalledSchemas.applyOptions.parse(input.options);
            const result = await new ComposeDeploymentHost().apply(planId, digest, options);
            process.stdout.write(JSON.stringify(result) + '\n');
        } catch (error) {
            process.stderr.write(JSON.stringify({ code: error instanceof PlanningBlockedError ? error.blockers[0]?.code : 'CLIENT_RUNTIME_FAILURE' }) + '\n');
            process.exitCode = error instanceof PlanningBlockedError ? 3 : 1;
        }
    }
}
await InstalledClient.run(process.argv[2]!);
