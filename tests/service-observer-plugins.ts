import { type Context } from 'cordis';
import { CanonicalJson, ProviderV4Schemas, ServiceProjectionSchemas, ServiceTokens, type ProbeContext, type ServiceReadiness } from '@treeseed-cordis/sdk';
import { ContainerFixture, ProbeFixture } from './service-fixture-plugins.js';
export class ObserverContainerFixture extends ContainerFixture {
    static override readonly declaration = ProviderV4Schemas.declaration.parse({ ...ContainerFixture.declaration, id: 'fixture.observer-container' });
    static override readonly container = ServiceProjectionSchemas.container.parse({ ...ContainerFixture.container, definition: { ...ContainerFixture.container.definition, user: 'installation-owner', environment: { FIXTURE_SERVICE_ID: { $context: 'serviceId' } }, workerSocket: true } });
}
export class ObserverProbeFixture extends ProbeFixture {
    static override readonly declaration = ProviderV4Schemas.declaration.parse({ ...ProbeFixture.declaration, id: 'fixture.observer-probe' });
    constructor(context: Context) { super(context); }
    override async observe(context: ProbeContext): Promise<ServiceReadiness> {
        let ready = false;
        try { const response = await fetch(context.endpoint, { signal: context.signal }), body = await response.json() as { identity: unknown; entryDigest: string; readonly: boolean; controlHidden: boolean; denied: boolean }; ready = response.ok && body.readonly && body.controlHidden && body.denied && CanonicalJson.stringify(body.identity) === CanonicalJson.stringify(context.observation?.identity) && body.entryDigest === context.observation?.identity.runtime?.entryDigest; } catch { }
        return { serviceId: context.serviceId, ready, observations: [ready ? 'fixture.observer.verified' : 'fixture.observer.unavailable'] };
    }
}
