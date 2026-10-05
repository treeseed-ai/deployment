import type { ComponentRelease } from '@treeseed/sdk/deployment';
import { collectHostAliases } from '@treeseed/sdk/deployment';

export interface EdgeRoute {
	alias: string;
	upstream: string;
	authentication: 'none' | 'application' | 'mtls';
	projectId?: string;
	targetId?: string;
	managedUpstreamTls?: boolean;
}

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
		routes.push({ alias, upstream: `${endpoint.protocol === 'https' ? 'https://' : ''}${service.composeService}:${endpoint.port}`, authentication: endpoint.authentication,
			...(release.componentId === 'identity' && endpoint.protocol === 'https' ? { managedUpstreamTls: true } : {}) });
	}
	return routes.sort((left, right) => left.alias.localeCompare(right.alias));
}

export function renderCaddyfile(routes: readonly EdgeRoute[], certificate = '/etc/treeseed/edge/tls/host.crt', key = '/etc/treeseed/edge/tls/host.key') {
	if (routes.length === 0) throw new Error('At least one accepted host route is required.');
	const transport = (route: EdgeRoute) => route.managedUpstreamTls ? ' {\n\t\ttransport http {\n\t\t\ttls_trust_pool file /etc/treeseed/edge/tls/client-ca.crt\n\t\t}\n\t}' : '';
	return `${routes.map((route) => `${route.alias} {\n\ttls ${certificate} ${key}${route.authentication === 'mtls' ? ' {\n\t\tclient_auth {\n\t\t\tmode require_and_verify\n\t\t\ttrust_pool file {\n\t\t\t\tpem_file /etc/treeseed/edge/tls/client-ca.crt\n\t\t\t}\n\t\t}\n\t}' : ''}\n\treverse_proxy ${route.upstream}${transport(route)}\n}\n`).join('\n')}`;
}

export function subjectAlternativeNames(routes: readonly EdgeRoute[]) {
	return [...new Set(routes.map((route) => route.alias))].sort();
}
