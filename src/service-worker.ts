import { resolve } from 'node:path';
import { z } from 'zod';
import { PlatformSchemas, ServiceSchemas } from '@treeseed-cordis/sdk';
import { BootstrapSchemas, BootstrapPermit } from './service-bootstrap.js';
import { ServicePlanStore } from './service-plan.js';
import { ServiceHostRuntime } from './service-host.js';
class ServiceWorkerArguments {
    static readonly schema = z.strictObject({ installation: PlatformSchemas.absolute, plan: ServiceSchemas.plan.shape.id, digest: PlatformSchemas.digest, nonce: BootstrapSchemas.reference.shape.nonce, protocol: z.literal('3') });
    static parse(args: string[]): z.infer<typeof this.schema> {
        const values: Record<string, string> = {};
        for (let index = 0; index < args.length; index += 2) {
            const flag = args[index], value = args[index + 1];
            if (!flag || !['--installation', '--plan', '--digest', '--nonce', '--protocol'].includes(flag) || value === undefined || Object.hasOwn(values, flag.slice(2))) throw new Error('WORKER_ARGUMENTS');
            values[flag.slice(2)] = value;
        }
        const parsed = this.schema.parse(values);
        if (resolve(parsed.installation) !== parsed.installation || parsed.plan !== 'plan-' + parsed.digest) throw new Error('WORKER_ARGUMENTS');
        return parsed;
    }
}
/** Fixed standalone entry; no activation occurs until owner protocol acceptance. */
export class ServiceWorkerProgram {
    private host: ServiceHostRuntime | null = null;
    private stopping = false;
    private closing: Promise<void> | null = null;
    static async run(args: string[]): Promise<0 | 2 | 3> { return new ServiceWorkerProgram().start(args); }
    private async start(args: string[]): Promise<0 | 2 | 3> {
        let options: z.infer<typeof ServiceWorkerArguments.schema>;
        try {
            options = ServiceWorkerArguments.parse(args);
        } catch {
            return 2;
        }
        try {
            await this.establish(options);
            return 0;
        } catch {
            if (this.host) await this.close();
            return 3;
        }
    }
    private async establish(options: z.infer<typeof ServiceWorkerArguments.schema>): Promise<void> {
        const store = new ServicePlanStore(options.installation);
        const plan = store.readPublished(options.plan, options.digest);
        await BootstrapPermit.wait(plan, options.nonce);
        process.once('SIGTERM', this.signal.bind(this));
        process.once('SIGINT', this.signal.bind(this));
        this.host = await ServiceHostRuntime.start(plan, { nonce: options.nonce });
        if (this.stopping) await this.close();
    }
    private signal(): void { this.stopping = true; if (this.host) void this.close(); }
    private close(): Promise<void> { if (!this.closing) this.closing = this.drain(); return this.closing; }
    private async drain(): Promise<void> {
        const deadline = setTimeout(ServiceWorkerProgram.expired, 12000);
        try { await this.host?.close(10000); } catch { ServiceWorkerProgram.expired(); }
        finally { clearTimeout(deadline); }
    }
    private static expired(): never { process.exit(1); }
    static async main(): Promise<void> { if (import.meta.main) process.exitCode = await this.run(process.argv.slice(2)); }
}
await ServiceWorkerProgram.main();
