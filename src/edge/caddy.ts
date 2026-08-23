import type { ComponentRelease } from '@treeseed/sdk/deployment';
import { collectHostAliases } from '@treeseed/sdk/deployment';

export interface EdgeRoute { alias: string; upstream: string; authentication: 'none' | 'application' | 'mtls' }

export function edgeRoutes(components: readonly ComponentRelease[], overrides: Record<string, string> = {}): EdgeRoute[] {
	for (const component of components) for (const service of component.runtime.services) for (const endpoint of service.endpoints) {
		const key = `${component.componentId}.${service.id}.${endpoint.id}`;
		if (overrides[key] && !endpoint.aliasOverride) throw new Error(`Host endpoint ${key} does not permit alias overrides.`);
	}
	const aliases = collectHostAliases(components, overrides), routes: EdgeRoute[] = [];
	for (const [alias, target] of aliases) {
		const release = components.find((component) => component.componentId === target.componentId)!;
		const service = release.runtime.services.find((candidate) => candidate.id === target.serviceId)!;
		const endpoint = service.endpoints.find((candidate) => candidate.id === target.endpointId)!;
		routes.push({ alias, upstream: `${endpoint.protocol === 'https' ? 'https://' : ''}${service.composeService}:${endpoint.port}`, authentication: endpoint.authentication });
	}
	return routes.sort((left, right) => left.alias.localeCompare(right.alias));
}

export function renderCaddyfile(routes: readonly EdgeRoute[], certificate = '/etc/treeseed/edge/tls/host.crt', key = '/etc/treeseed/edge/tls/host.key') {
	if (routes.length === 0) throw new Error('At least one accepted host route is required.');
	return `${routes.map((route) => `${route.alias} {\n\ttls ${certificate} ${key}${route.authentication === 'mtls' ? ' {\n\t\tclient_auth {\n\t\t\tmode require_and_verify\n\t\t\ttrusted_ca_cert_file /etc/treeseed/edge/tls/client-ca.crt\n\t\t}\n\t}' : ''}\n\treverse_proxy ${route.upstream}\n}`).join('\n')}\n`;
}

export function subjectAlternativeNames(routes: readonly EdgeRoute[]) {
	return [...new Set(routes.map((route) => route.alias))].sort();
}
