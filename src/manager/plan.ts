import { collectTopologyBlockers, deploymentDigest, hostPlanSchema, resolveMixedTrackCatalog, type HostConfiguration, type HostPlan, type HostReceipt, type ReleaseCatalog } from '@treeseed/sdk/deployment';
import { edgeRoutes } from '../edge/caddy.js';

export interface AcceptedPlan { plan: HostPlan; components: ReturnType<typeof resolveMixedTrackCatalog>['components']; routes: ReturnType<typeof edgeRoutes> }

export function createPlan(host: HostConfiguration, stable: ReleaseCatalog, development: ReleaseCatalog | undefined, receipt?: HostReceipt): AcceptedPlan {
	const resolution = resolveMixedTrackCatalog({ host, stable, ...(development ? { development } : {}) });
	const installed = new Map(receipt?.packages.map((item) => [item.name, item.version]) ?? []);
	const changes = resolution.components.map((component) => {
		const target = component.packages[0]!, from = installed.get(target.name) ?? null;
		return { componentId: component.componentId, action: from === null ? 'install' as const : from === target.version ? 'noop' as const : 'upgrade' as const, from, to: target.version };
	});
	const configurationDigest = deploymentDigest(host);
	const catalogDigest = development ? deploymentDigest({ stable: stable.catalogDigest, development: development.catalogDigest }) : stable.catalogDigest;
	const blockers = collectTopologyBlockers(host, resolution.components).map(({ code, message }) => ({ code, message }));
	const plan = hostPlanSchema.parse({ schemaVersion: 'treeseed.host-plan/v1', planId: `plan-${configurationDigest.slice(7, 19)}`, configurationDigest, catalogDigest, changes, blockers });
	const overrides = Object.fromEntries(Object.values(host.components).flatMap((component) => Object.entries(component.aliases)));
	const routes = edgeRoutes(resolution.components, overrides);
	for (const alias of host.network.manager.aliases) routes.push({ alias, upstream: 'unix//run/treeseed/manager/api.sock', authentication: 'mtls' });
	const aliases = new Set<string>();
	for (const route of routes) {
		if (aliases.has(route.alias)) throw new Error(`Duplicate host alias ${route.alias}.`);
		aliases.add(route.alias);
	}
	routes.sort((left, right) => left.alias.localeCompare(right.alias));
	return { plan, components: resolution.components, routes };
}
