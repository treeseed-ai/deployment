import { existsSync, readFileSync } from 'node:fs';
import { posix,resolve } from 'node:path';
import { componentReleaseSchema, deploymentDigest, type ComponentRelease, type HostConfiguration } from '@treeseed/sdk/deployment';
import { z } from 'zod';
import { paths } from '../core/paths.js';
import { componentStateRoot } from './component.js';
import { activePostgresTransferJournal } from './postgres-transfer-guard.js';
import type { PostgresTransferIntent } from '../postgres/transfer.js';

/** A new empty allocation must never silently replace an existing application
 * database. This is a transition gate, not another credential read path. The
 * only bypass is an internally executing, exact verified transfer activation;
 * it is deliberately absent from the supervisor wire contract.
 */
export function requirePostgresTransition(host: HostConfiguration, component: ComponentRelease,
  transferred?: PostgresTransferIntent) {
  const state = `${paths.managerState}/active-components.json`;
  // Do not use the manager's quarantine-and-empty loader at this boundary:
  // corrupted custody is not evidence of a fresh installation.
  const active = existsSync(state) ? z.array(componentReleaseSchema).parse(JSON.parse(readFileSync(state,'utf8'))) : [];
  const prior = active.filter(item => item.componentId === component.componentId);
  if (prior.length > 1) throw new Error('Ambiguous previous PostgreSQL application custody');
  const previous = prior[0];
  if (previous && previous.runtimeDigest !== deploymentDigest(previous.runtime)) throw new Error('Previous PostgreSQL runtime custody is invalid');
  const privateSource = previous && !previous.runtime.postgresLifecycle?.length &&
    previous.images.some(image => image.repository === 'postgres' || image.repository.endsWith('/postgres'));
  const prefix=`/var/lib/treeseed/components/${component.componentId}/`;
  const sourceVolumes=component.runtime.stateVolumes.filter(volume=>volume.id==='postgres');
  const sourcePaths=sourceVolumes.map(volume=>{
    if(!volume.volume.startsWith(prefix))throw new Error('Invalid retained PostgreSQL source path');
    const relative=volume.volume.slice(prefix.length);
    if(!relative || posix.normalize(relative)!==relative || relative.split('/').includes('..'))throw new Error('Invalid retained PostgreSQL source path');
    return resolve(componentStateRoot(host,component.componentId),relative,'PG_VERSION');
  });
  const retainedSource = !previous?.runtime.postgresLifecycle?.length && sourcePaths.some(path=>existsSync(path));
  if (!privateSource && !retainedSource) return;
  const journal = activePostgresTransferJournal()?.active();
  if (!transferred || !host.postgres || !journal || journal.stage !== 'activate' ||
    journal.intentDigest !== deploymentDigest(transferred) || journal.restoreDigest !== transferred.restorePointDigest ||
    transferred.topologyDigest !== deploymentDigest(host.postgres) || transferred.runtimeDigest !== component.runtimeDigest ||
    transferred.installationId !== host.postgres.installationId || transferred.environment !== host.postgres.environment ||
    component.runtime.postgresLifecycle?.length !== 1 || component.runtime.postgresLifecycle[0]?.requirementId !== transferred.requirementId)
    throw new Error('Existing application PostgreSQL data requires verified managed transfer before shared-database activation; source retained');
}
