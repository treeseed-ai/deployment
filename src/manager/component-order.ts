import type { ComponentRelease, HostConfiguration } from '@treeseed/sdk/deployment';

/** Stable dependency order, including the selected shared database service. */
export function componentActivationOrder(host: HostConfiguration, releases: ComponentRelease[]) {
  const selected = new Map(releases.map(release => [release.componentId, release]));
  const indegree = new Map(releases.map(release => [release.componentId, 0]));
  const consumers = new Map(releases.map(release => [release.componentId, new Set<string>()]));
  const depend = (provider: string, consumer: string) => {
    if (!selected.has(provider)) throw new Error(`Component ${consumer} requires unavailable local component ${provider}.`);
    const ids = consumers.get(provider)!;
    if (!ids.has(consumer)) { ids.add(consumer); indegree.set(consumer, indegree.get(consumer)! + 1); }
  };
  for (const consumer of releases) {
    const selection = host.components[consumer.componentId];
    if (consumer.runtime.postgresRequirements?.length && host.postgres?.servers.some(server => server.mode !== 'external')) depend('postgres', consumer.componentId);
    for (const dependency of consumer.runtime.dependencies) {
      const connection = selection?.connections[dependency.id];
      if (connection?.kind === 'local') depend(connection.componentId, consumer.componentId);
    }
  }
  const pending = releases.filter(release => indegree.get(release.componentId) === 0), ordered: ComponentRelease[] = [];
  while (pending.length) {
    const dependency = pending.shift()!; ordered.push(dependency);
    for (const consumerId of consumers.get(dependency.componentId)!) {
      const remaining = indegree.get(consumerId)! - 1; indegree.set(consumerId, remaining);
      if (remaining === 0) pending.push(selected.get(consumerId)!);
    }
  }
  if (ordered.length !== releases.length) throw new Error(`Local component dependency cycle: ${releases.filter(release => !ordered.includes(release)).map(release => release.componentId).join(', ')}.`);
  return ordered;
}

export function componentStopOrder(host: HostConfiguration, releases: ComponentRelease[]) {
  return componentActivationOrder(host, releases).reverse();
}
