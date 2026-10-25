import { readFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { CanonicalJson, ServiceSchemas, type ProbeContext, type ServicePlan } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, ServiceApplicationRuntime, ServicePlanStore, ServiceRuntimeInspection, ServiceAuthorityExports, ServiceHttpClient, ServiceCredentials } from '@treeseed-cordis/deployment';
class EdgeInput implements ProbeContext {
    readonly observation: NonNullable<ProbeContext['observation']>; readonly expected: ProbeContext['expected']; readonly credentialReferences: string[] = []; readonly authorityIds: readonly string[];
    readonly deadline = Date.now() + 10000; readonly signal = new AbortController().signal;
    private readonly exports: ServiceAuthorityExports;
    constructor(readonly serviceId: string, readonly endpoint: string, plan: ServicePlan, observation: NonNullable<ProbeContext['observation']>) { this.observation = observation; const identity = this.observation.identity; this.expected = { installationId: identity.installationId, compositionGeneration: identity.compositionGeneration, serviceGeneration: identity.serviceGeneration, assetDigest: identity.assetDigest }; this.exports = new ServiceAuthorityExports(plan); this.authorityIds = this.exports.references(serviceId).authorityIds; }
    credential(_reference: string): Promise<Uint8Array> { return Promise.reject(new Error('Fixture has no private grant')); }
    authority(reference: string): Promise<Uint8Array> { return this.exports.read(this.serviceId, reference, { deadline: this.deadline, signal: this.signal }); }
}
class CaddyServiceProgram {
    static async run(file: string): Promise<void> {
        const configuration = ServiceSchemas.configuration.parse(JSON.parse(readFileSync(file, 'utf8'))), plan = await new ComposeDeploymentHost().plan(configuration); if (plan.formatVersion !== 3) throw new Error('Wrong format');
        const runtime = await ServiceApplicationRuntime.start(plan);
        try {
            const accepted = await runtime.submit({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'caddy-default-program' }), until = Date.now() + 120000;
            let application = await runtime.application(accepted.id); while (!['completed', 'failed', 'cancelled'].includes(application.phase) && Date.now() < until) { await new Promise(this.delay); application = await runtime.application(accepted.id); }
            if (application.phase !== 'completed' || !(await runtime.status()).ready) throw new Error('Native Caddy fixture not ready');
            const [api, identity, edge] = plan.composition.services; if (!api || !identity || !edge || ['api', 'identity', 'edge'].includes(edge.serviceId)) throw new Error('Fixture did not rename instances');
            const inspection = new ServiceRuntimeInspection(plan), target = await inspection.service(edge.serviceId), context = new EdgeInput(edge.serviceId, target.endpoint, plan, await runtime.observationContext(edge.serviceId)), client = new ServiceHttpClient(), reference = 'secret://' + edge.serviceId + '/public-ca';
            const apiBody = JSON.parse((await client.read(context, { path: '/health/ready', authorityReference: reference })).toString()) as { serviceId: string }, identityBody = JSON.parse((await client.read(context, { path: '/identity/realms/cordis/fixture', authorityReference: reference })).toString()) as { serviceId: string };
            if (apiBody.serviceId !== api.serviceId || identityBody.serviceId !== identity.serviceId) throw new Error('Typed Caddy dependency routing failed');
            let denied = false; try { await client.read(context, { path: '/identity/admin', authorityReference: reference }); } catch { denied = true; } if (!denied) throw new Error('Private Identity path exposed');
            const store = new ServicePlanStore(configuration.installationDirectory), resources = store.resources(), receipt = resources.find(CaddyServiceProgram.authority), certificate = Buffer.from(await context.authority(reference)), config = new ServiceCredentials(plan).read(edge.serviceId, 'secret://' + edge.serviceId + '/edge-config').toString();
            if (!receipt?.path || receipt.contentDigest !== createHash('sha256').update(certificate).digest('hex') || !new X509Certificate(certificate).ca || !config.includes(api.serviceId + ':8080') || !config.includes(identity.serviceId + ':8080') || !config.includes('skip_install_trust') || !config.includes('respond 404')) throw new Error('Caddy private CA/configuration binding failed');
            const path = join(configuration.installationDirectory, '.cordis', receipt.path); if ((statSync(path).mode & 0o777) !== 0o600 || (statSync(dirname(path)).mode & 0o777) !== 0o700) throw new Error('Non-private CA receipt');
            const before = CanonicalJson.stringify({ resources, snapshot: store.current() }); rmSync(configuration.release.directory, { recursive: true }); if (!(await runtime.status()).ready || before !== CanonicalJson.stringify({ resources: store.resources(), snapshot: store.current() }) || !certificate.equals(Buffer.from(await new EdgeInput(edge.serviceId, target.endpoint, plan, context.observation).authority(reference)))) throw new Error('Source-free Caddy read changed state');
            await runtime.close(); await inspection.audit(); if (!(await inspection.service(edge.serviceId)).running) throw new Error('Scope disposal stopped Caddy');
            process.stdout.write(JSON.stringify({ fixtureOnly: true, caddy: true, renamed: true, tlsVerified: true, identityRoute: true, privateCa: true, sourceFree: true, retained: true }) + '\n');
        } finally { await runtime.close(); }
    }
    private static authority(receipt: { kind: string }): boolean { return receipt.kind === 'authority'; }
    private static delay(done: (value: void) => void): void { setTimeout(done, 100); }
}
await CaddyServiceProgram.run(process.argv[2]!);
