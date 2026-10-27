import { ProviderV4Schemas, PluginManagementSchemas, type ProbeContext, type ServiceReadiness } from '@treeseed-cordis/sdk';
import { ServiceHttpClient } from '@treeseed-cordis/deployment';
import { RuntimeContainerFixture, ProbeFixture } from './service-fixture-plugins.js';
/** Explicit routing protocol fixtures; neither is a genuine API/Keycloak implementation. */
export class ApiBackendFixture extends RuntimeContainerFixture {
    static override readonly declaration = ProviderV4Schemas.declaration.parse({ ...RuntimeContainerFixture.declaration, id: 'fixture.api-backend' });
    static override readonly container = PluginManagementSchemas.container.parse({ ...RuntimeContainerFixture.container, providedContracts: [{ port: 'http', contractId: 'platform.api', contractVersion: '1.0.0' }] });
}
export class IdentityBackendFixture extends RuntimeContainerFixture {
    static override readonly declaration = ProviderV4Schemas.declaration.parse({ ...RuntimeContainerFixture.declaration, id: 'fixture.identity-backend' });
    static override readonly container = PluginManagementSchemas.container.parse({ ...RuntimeContainerFixture.container, providedContracts: [{ port: 'oidc', contractId: 'identity.oidc', contractVersion: '1.0.0' }] });
}
export class EdgeProbeFixture extends ProbeFixture {
    static override readonly declaration = ProviderV4Schemas.declaration.parse({ ...ProbeFixture.declaration, id: 'fixture.edge-probe' });
    static override readonly probe = { observationContracts: ['edge.https'], schemes: ['https'], maximumDeadlineMs: 5000 };
    private static api(value: { port: string }): boolean { return value.port === 'api'; }
    override async observe(context: ProbeContext): Promise<ServiceReadiness> {
        let ready = false;
        try { const expected = context.observation?.dependencies.find(EdgeProbeFixture.api)?.identity.serviceId, bytes = await new ServiceHttpClient().read(context, { path: '/health/ready', authorityReference: 'secret://' + context.serviceId + '/public-ca' }), body = JSON.parse(bytes.toString()) as { serviceId?: string }; ready = !!expected && body.serviceId === expected; } catch { }
        return { serviceId: context.serviceId, ready, observations: [ready ? 'fixture.edge.tls' : 'fixture.edge.unavailable'] };
    }
}
