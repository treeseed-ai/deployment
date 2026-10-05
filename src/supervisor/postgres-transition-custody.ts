import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { componentReleaseSchema, deploymentDigest, postgresTransitionSelectionSchema, type HostConfiguration, type ComponentRelease } from '@treeseed/sdk/deployment';
import { paths } from '../core/paths.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { PostgresTransitionStore } from '../postgres/transition-store.js';
import { componentStateRoot } from './component.js';
import { postgresTransferJournal } from './postgres-transfer-guard.js';
import { requiredBackupState } from './backup-coverage.js';

export function privatePostgresState(host: HostConfiguration, component: ComponentRelease) {
  const volumes = component.runtime.stateVolumes.filter(item => item.id === 'postgres' && item.backup === 'required');
  if (volumes.length !== 1) throw new Error('One retained private PostgreSQL volume required');
  return requiredBackupState(host, [{ ...component, runtime: { ...component.runtime, stateVolumes: volumes } }]);
}

export function postgresTransitionStore(host: HostConfiguration) {
  if (process.getuid?.() !== 0 || !host.components.postgres?.enabled) throw new Error('Managed PostgreSQL transition custody required');
  return new PostgresTransitionStore(`${componentStateRoot(host, 'postgres')}/lifecycle/transfers`);
}
export function previousPostgresComponent(componentId: string) {
  const path = `${paths.managerState}/active-components.json`;
  const releases = existsSync(path) ? z.array(componentReleaseSchema).parse(JSON.parse(readFileSync(path, 'utf8'))) : [];
  const values = releases.filter(item => item.componentId === componentId);
  if (values.length > 1 || values.some(value => deploymentDigest(value.runtime) !== value.runtimeDigest)) throw new Error('Previous PostgreSQL custody changed');
  return values[0];
}
export async function prepareLocalPostgresTransition(input: unknown, planOnly = false) {
  const selection = postgresTransitionSelectionSchema.parse(input), journal = postgresTransferJournal();
  return journal.locked(async () => {
    if (journal.active()) throw new Error('Interrupted PostgreSQL transfer requires recovery');
    const host = loadHostConfiguration(), previous = previousPostgresComponent(selection.componentId);
    if (!previous || previous.runtime.postgresLifecycle?.length || previous.runtimeDigest !== selection.sourceRuntimeDigest ||
      previous.runtimeDigest === selection.targetRuntimeDigest || !previous.runtime.stateVolumes.some(item => item.id === 'postgres' && item.backup === 'required'))
      throw new Error('Exact existing private PostgreSQL source required');
    if (!host.components.postgres?.enabled) throw new Error('Managed PostgreSQL foundation required');
    if (planOnly) return { action: 'planned' as const, selectionDigest: deploymentDigest(selection) };
    return postgresTransitionStore(host).prepare(selection);
  });
}
