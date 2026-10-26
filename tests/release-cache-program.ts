import * as Deployment from '@treeseed-cordis/deployment';
import { CanonicalJson, type ServicePlan, PlanningBlockedError } from '@treeseed-cordis/sdk';
import { readFileSync, writeFileSync, rmSync, statSync, chmodSync, existsSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
interface FileIdentity {
    path: string;
    sha256: string;
    size: number;
    mode: number;
}
interface Reader {
    readonly path: string;
    readonly files: readonly FileIdentity[];
    read(path: string): Buffer;
    verify(): void;
    close(): void;
}
interface Cache {
    stage(writer: ReturnType<Deployment.ServicePlanStore['writer']>): Promise<Reader>;
    open(): Reader | null;
}
class CacheProgressProbe {
    observed=false;private readonly timer:ReturnType<typeof setInterval>;
    constructor(private readonly plan:ServicePlan){this.timer=setInterval(this.sample.bind(this),1);}
    private sample():void{const root=join(this.plan.configuration.installationDirectory,'.cordis/artifacts/releases');if(!existsSync(root))return;for(const name of readdirSync(root))if(name.startsWith('.pending-')){const worker=join(root,name,'bundle',this.plan.composition.worker.path);if(existsSync(worker)){const size=statSync(worker).size;if(size>0&&size<this.plan.composition.worker.size)this.observed=true;}}}
    close():void{clearInterval(this.timer);}
}
class ReleaseCacheProgram {
    private static snapshot(): string { const commands = new Deployment.DockerCommands(), values = []; for (const args of [['ps', '--all', '--format', '{{.ID}}'], ['network', 'ls', '--format', '{{.ID}}'], ['volume', 'ls', '--format', '{{.Name}}']]) {
        const output = commands.execute(args);
        if (output === null)
            throw new Error('Docker prerequisite missing');
        values.push(output.split('\n').sort());
    } return CanonicalJson.stringify(values); }
    static async run(file: string): Promise<void> { const configuration = JSON.parse(readFileSync(file, 'utf8')), before = this.snapshot(), plan = await new Deployment.ComposeDeploymentHost().plan(configuration); if (plan.formatVersion !== 3)
        throw new Error('Wrong plan'); const store = new Deployment.ServicePlanStore(configuration.installationDirectory), writer = store.writer(); try {
        const constructor = Reflect.get(Deployment, 'ManagedReleaseCache') as new (p: ServicePlan) => Cache;
        if (typeof constructor !== 'function')
            throw new Error('EXACT_RELEASE_CUSTODY_UNAVAILABLE');
        const cache = new constructor(plan);
        let refused = false;
        try {
            await cache.stage(writer);
        }
        catch (error) {
            refused = error instanceof PlanningBlockedError;
        }
        if (!refused)
            throw new Error('Unaccepted release staged');
        const accepted = store.accept({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'stage-cache-fixture' }, writer).record;
        store.append({ ...accepted, sequence: 1, phase: 'stage', result: null }, writer);
        writeFileSync(join(configuration.release.directory, 'NEVER_COPY_UNLISTED'), 'UNRELATED_SECRET_CANARY');
        const progress=new CacheProgressProbe(plan);let reader:Reader;try{reader=await cache.stage(writer);}finally{progress.close();}if(!progress.observed)throw new Error('LARGE_ARTIFACT_COPY_BLOCKED_HOST_EVENT_LOOP');
        try {
            reader.verify();
            for (const row of reader.files) {
                if (!reader.read(row.path).equals(readFileSync(join(configuration.release.directory, row.path))))
                    throw new Error('Retained artifact bytes differ');
                if ((statSync(join(reader.path, row.path)).mode & 0o777) !== row.mode)
                    throw new Error('Retained mode differs');
            }
            if (existsSync(join(reader.path, 'NEVER_COPY_UNLISTED')) || (statSync(reader.path).mode & 0o777) !== 0o500)
                throw new Error('Cache inventory or mode differs');
            const again = await cache.stage(writer);
            try {
                if (again.path !== reader.path)
                    throw new Error('Repeated cache changed identity');
            }
            finally {
                again.close();
            }
            rmSync(configuration.release.directory, { recursive: true });
            const independent = cache.open();
            if (!independent)
                throw new Error('Source-free cache missing');
            try {
                independent.verify();
            }
            finally {
                independent.close();
            }
            const selected = reader.files.find(this.archive)!;
            const path = join(reader.path, selected.path), bytes = readFileSync(path);
            chmodSync(path, 0o600);
            refused = false;
            try {
                reader.read(selected.path);
            }
            catch (error) {
                refused = error instanceof PlanningBlockedError;
            }
            if (!refused)
                throw new Error('Non-immutable retained file accepted');
            chmodSync(path, 0o400);
            reader.verify();
            chmodSync(path, 0o600);
            writeFileSync(path, Buffer.alloc(bytes.length, 1));
            chmodSync(path, 0o400);
            refused = false;
            try {
                reader.read(selected.path);
            }
            catch (error) {
                refused = error instanceof PlanningBlockedError;
            }
            if (!refused)
                throw new Error('Tampered retained archive adopted');
            chmodSync(path, 0o600);
            writeFileSync(path, bytes);
            chmodSync(path, 0o400);
            reader.verify();
            if (before !== this.snapshot() || store.current() !== null || existsSync(configuration.installationDirectory + '/.cordis/credentials'))
                throw new Error('Cache stage changed runtime or credentials');
            process.stdout.write(JSON.stringify({ fixture: true, exact: true, private: true, allowlisted: true, reused: true, sourceFree: true, tamperRefused: true, noRuntimeEffects: true }) + '\n');
        }
        finally {
            reader.close();
        }
    }
    finally {
        writer.close();
    } }
    private static archive(row: FileIdentity): boolean { return row.path.endsWith('.tgz'); }
}
await ReleaseCacheProgram.run(process.argv[2]!);
