import * as Deployment from '@treeseed-cordis/deployment';
import { PlanningBlockedError, type ServicePlan, type PluginRequestRecord, type PluginInstallRequest } from '@treeseed-cordis/sdk';
import { readFileSync, rmSync, chmodSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
interface Tools {
    version(id: string, request: PluginRequestRecord): Promise<string>;
    run(id: string, args: string[], cwd: string, request: PluginRequestRecord): Promise<Buffer>;
    path(id: string, request: PluginRequestRecord): Promise<string>;
}
class ManagedToolsProgram {
    static async run(file: string): Promise<void> { const configuration = JSON.parse(readFileSync(file, 'utf8')), plan = await new Deployment.ComposeDeploymentHost().plan(configuration); if (plan.formatVersion !== 3 || !plan.helpers)
        throw new Error('Wrong helper fixture'); const store = new Deployment.ServicePlanStore(configuration.installationDirectory), writer = store.writer(); try {
        const registry = new Deployment.PluginRequestStore(plan, writer), intent: PluginInstallRequest = { source: '@fixture/managed@1.0.0', installationDirectory: configuration.installationDirectory, scope: 'installation', target: 'deployment', idempotencyKey: 'managed-helper-request', configuration: {} }, initial = registry.begin(intent, 'a'.repeat(64), null).record, request = registry.append({ ...initial, sequence: 1, stage: 'resolving' }), constructor = Reflect.get(Deployment, 'ManagedSourceTools') as new (p: ServicePlan, w: typeof writer, release: string) => Tools;
        if (typeof constructor !== 'function')
            throw new Error('MANAGED_SOURCE_TOOLS_UNAVAILABLE');
        const tools = new constructor(plan, writer, plan.helpers.releaseIdentity), version = await tools.version('bun', request);
        if (version !== '1.4.4')
            throw new Error('Wrong native helper');
        let refused = false;
        try {
            new constructor(plan, writer, 'e'.repeat(64));
        }
        catch (error) {
            refused = error instanceof PlanningBlockedError;
        }
        if (!refused)
            throw new Error('Unapproved release admitted');
        const forged = structuredClone(plan);
        forged.helpers!.helpers[0]!.files[0]!.sha256 = 'f'.repeat(64);
        refused = false;
        try {
            new constructor(forged, writer, plan.helpers.releaseIdentity);
        }
        catch (error) {
            refused = error instanceof PlanningBlockedError;
        }
        if (!refused)
            throw new Error('Changed helper table reused approved release identity');
        const work = mkdtempSync(join(configuration.installationDirectory, '.cordis/artifacts/source-work-'));
        const environment = await tools.run('bun', ['--eval', "class Canary{static run(){if(process.env.SECRET_CANARY!==undefined||process.env.NPM_TOKEN!==undefined)throw new Error('ambient credential inherited');process.stdout.write('private-environment-ok');}}Canary.run();"], work, request);
        if (environment.toString() !== 'private-environment-ok')
            throw new Error('Unsafe helper environment');
        let escaped = false;
        const childCode = "import {spawn} from 'node:child_process';import{writeFileSync}from'node:fs';class Parent{static run(){const child=spawn(process.execPath,['--eval',\"class Child{static run(){setTimeout(Child.run,1000);}}Child.run();\"],{stdio:'ignore'});writeFileSync('child.pid',String(child.pid));child.unref();}}Parent.run();";
        try {
            await tools.run('bun', ['--eval', childCode], work, request);
        }
        catch (error) {
            escaped = error instanceof Error && error.message === 'SOURCE_TOOL_FAILED';
        }
        if (!escaped)
            throw new Error('Helper retained live child after exit');
        const childId = Number(readFileSync(join(work, 'child.pid'), 'utf8'));
        await new Promise(this.delay);
        if (existsSync('/proc/' + childId + '/status') && !/^State:\s+Z/m.test(readFileSync('/proc/' + childId + '/status', 'utf8')))
            throw new Error('Helper child remained active');
        rmSync(configuration.release.directory, { recursive: true });
        if (await tools.version('bun', request) !== version)
            throw new Error('Offline helper reuse failed');
        const path = await tools.path('bun', request), bytes = readFileSync(path);
        chmodSync(path, 0o700);
        writeFileSync(path, 'NEVER_EXECUTE_TAMPERED_HELPER');
        chmodSync(path, 0o500);
        refused = false;
        try {
            await tools.version('bun', request);
        }
        catch (error) {
            refused = error instanceof PlanningBlockedError;
        }
        if (!refused)
            throw new Error('Tampered helper executed');
        chmodSync(path, 0o700);
        writeFileSync(path, bytes);
        chmodSync(path, 0o500);
        if (await tools.version('bun', request) !== version)
            throw new Error('Restored exact helper unavailable');
        process.stdout.write(JSON.stringify({ fixture: true, genuineHelper: true, noAmbientTools: true, privateEnvironment: true, offlineReuse: true, tamperRefused: true }) + '\n');
    }
    finally {
        writer.close();
    } }
    private static delay(done: (value: void) => void): void { setTimeout(done, 100); }
}
await ManagedToolsProgram.run(process.argv[2]!);
