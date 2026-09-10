import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { loadHostConfiguration } from '../core/configuration.js';
import { atomicJson } from '../core/files.js';
import { withLocalPostgresBootstrap } from '../postgres/connection.js';
import { activatePostgresAllocation } from '../postgres/activation.js';
import { disablePostgresAllocation } from '../postgres/disable.js';
import { runPostgresComponentLifecycle } from '../postgres/lifecycle.js';
import { postgresDigest } from '../postgres/plan.js';
import { verifyPostgresAllocationRuntime } from '../postgres/runtime-state.js';
import { inspectGenerationBackup } from './backup.js';
import { componentStateRoot } from './component.js';
import { installedComponentRelease } from './component-release.js';
import { componentComposeArguments } from './compose-runtime.js';
import { readComponentCredential } from './component-sealed.js';
import { clearPostgresClient, materializePostgresClient } from './postgres-client-files.js';
import { preparePostgresCredentials } from './postgres-credentials.js';
import { postgresDocker } from './postgres-process.js';
import { localPostgresTopology, reconcileLocalPostgres } from './postgres.js';
import { aiModeActivationServices } from '../manager/ai-mode.js';
import { requirePostgresTransition } from './postgres-transition.js';
import type { PostgresTransferIntent } from '../postgres/transfer.js';
import { postgresComponentRuntimeHealthy } from './postgres-runtime-health.js';

const active = new Set<string>();

/** Supervisor-only adapter: installed artifacts, fixed socket/custody, no caller commands. */
export async function activateLocalPostgresComponent(componentId: string, selections: Array<{ componentId: string; release: string }>, backupGeneration?: number, transferred?: PostgresTransferIntent) {
  if (active.has(componentId)) throw new Error('PostgreSQL component lifecycle is already active');
  active.add(componentId);
  try {
    const host = loadHostConfiguration(), hostDigest = deploymentDigest(host);
    const releases = selections.map(item => installedComponentRelease(item.componentId, item.release));
    const component = releases.find(item => item.componentId === componentId);
    if (!component) throw new Error('Selected PostgreSQL component missing');
    requirePostgresTransition(host, component, transferred);
    const migrations = new Set(component.runtime.postgresLifecycle?.map(item => item.migration.composeService));
    const selection = () => aiModeActivationServices(component)?.filter(service => !migrations.has(service));
    const selectedRuntime = selection(), selectionDigest = deploymentDigest(selectedRuntime ?? null);
    const topology = localPostgresTopology(host, releases);
    const plan = await reconcileLocalPostgres(selections);
    if (!('ready' in plan) || !plan.ready) throw new Error('PostgreSQL allocation plan is blocked');
    await reconcileLocalPostgres(selections, plan);
    const stateRoot = componentStateRoot(host, 'postgres');
    const receiptRoot = `${stateRoot}/lifecycle`;
    mkdirSync(receiptRoot, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(receiptRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o077)) throw new Error('Unsafe PostgreSQL lifecycle receipt custody');
    for (let path = dirname(receiptRoot); ; path = dirname(path)) {
      const ancestor = lstatSync(path);
      if (!ancestor.isDirectory() || ancestor.isSymbolicLink() || ancestor.uid !== 0 || (ancestor.mode & 0o022)) throw new Error('Unsafe PostgreSQL lifecycle ancestor');
      if (path === '/') break;
    }
    const receipt = `${receiptRoot}/${componentId}.json`;
    const unchanged = () => { if (deploymentDigest(loadHostConfiguration()) !== hostDigest || deploymentDigest(selection() ?? null) !== selectionDigest) throw new Error('Host configuration or AI mode changed during PostgreSQL activation'); };
    const allocation = (id: string) => {
      const value = topology.allocations.find(item => item.requirementId === id);
      if (!value || !topology.requirements.some(item => item.id === id && item.componentId === componentId && item.enabled)) throw new Error('Invalid component allocation');
      return value;
    };
    const session = <T>(id: string, run: Parameters<typeof withLocalPostgresBootstrap<T>>[2]) => withLocalPostgresBootstrap('/run/treeseed/postgres/socket', allocation(id).database, run);
    const files = component.runtime.compose.files.map(file => `${componentId}/${component.release}/${file.path}`);
    const compose = () => ['compose', ...componentComposeArguments(componentId, files), '--project-name', component.runtime.compose.projectName];
    return await runPostgresComponentLifecycle(component, postgresDigest(topology), {
      accepted: async (runtimeDigest, topologyDigest) => {
        if (!existsSync(receipt)) return false;
        const stat = lstatSync(receipt);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) || stat.size > 4096) throw new Error('Unsafe PostgreSQL lifecycle receipt');
        const value = JSON.parse(readFileSync(receipt, 'utf8'));
        return value.runtimeDigest === runtimeDigest && value.topologyDigest === topologyDigest;
      },
      verifyRuntime: async id => session(id, async connection => (await verifyPostgresAllocationRuntime(topology, id, readComponentCredential(host, allocation(id).runtimeCredentialReference), connection)).verified),
      requireRestorePoint: async () => {
        if (backupGeneration !== undefined) {
          const backup = await inspectGenerationBackup(backupGeneration);
          if (!backup.coverage.stateDirectories.includes(`${stateRoot}/postgres`.slice(1))) throw new Error('Restore point does not cover the shared PostgreSQL server');
          return;
        }
        for (const lifecycle of component.runtime.postgresLifecycle ?? []) {
          const empty = await session(lifecycle.requirementId, connection => connection.query("SELECT NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','m','S')) AS empty"));
          if (empty.rows[0]?.empty !== true) throw new Error('Verified shared-server restore point required');
        }
      },
      stopServices: async services => { await postgresDocker([...compose(), 'stop', '--timeout', '30', ...services], 60); },
      ensureCredentials: async id => { unchanged(); await session(id, connection => preparePostgresCredentials(host, id, connection)); },
      activate: async (id, phase) => { unchanged(); const selected = allocation(id); await session(id, connection => activatePostgresAllocation(topology, id, phase,
        readComponentCredential(host, phase === 'migration' ? selected.migrationCredentialReference : selected.runtimeCredentialReference), connection)); },
      materialize: async (id, phase) => { unchanged(); materializePostgresClient(host, component, id, phase); },
      migrate: async migration => {
        unchanged();
        const command = migration.completion === 'exit-zero'
          ? ['up', '--no-deps', '--abort-on-container-exit', '--exit-code-from', migration.composeService, migration.composeService]
          : ['up', '--detach', '--no-deps', '--wait', '--wait-timeout', String(migration.timeoutSeconds), migration.composeService];
        await postgresDocker([...compose(), ...command], migration.timeoutSeconds + 5);
      },
      clear: async (id, phase) => { clearPostgresClient(componentId, id, phase); },
      disable: async id => { await session(id, connection => disablePostgresAllocation(topology, id, connection)); },
      startRuntime: async services => { unchanged(); await postgresDocker([...compose(), 'up', '--detach', '--no-deps', '--wait', '--wait-timeout', '180', ...services], 190); },
      runtimeHealthy: async services => {
        unchanged();
        return postgresComponentRuntimeHealthy(component, services);
      },
      record: async (runtimeDigest, topologyDigest) => { unchanged(); atomicJson(receipt, { runtimeDigest, topologyDigest }, 0o600); },
    }, selectedRuntime);
  } finally { active.delete(componentId); }
}
