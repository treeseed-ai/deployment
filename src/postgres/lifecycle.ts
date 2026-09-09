import { componentReleaseSchema, deploymentDigest, type ComponentRelease } from '@treeseed/sdk/deployment';

export interface PostgresLifecyclePorts {
  accepted(runtimeDigest: string, topologyDigest: string): Promise<boolean>;
  verifyRuntime(requirementId: string): Promise<boolean>;
  requireRestorePoint(): Promise<void>;
  stopServices(services: string[]): Promise<void>;
  ensureCredentials(requirementId: string): Promise<void>;
  activate(requirementId: string, phase: 'migration' | 'runtime'): Promise<void>;
  materialize(requirementId: string, phase: 'migration' | 'runtime'): Promise<void>;
  migrate(migration: NonNullable<ComponentRelease['runtime']['postgresLifecycle']>[number]['migration']): Promise<void>;
  clear(requirementId: string, phase: 'migration' | 'runtime'): Promise<void>;
  disable(requirementId: string): Promise<void>;
  startRuntime(services: string[]): Promise<void>;
  runtimeHealthy(services: string[]): Promise<boolean>;
  record(runtimeDigest: string, topologyDigest: string): Promise<void>;
}

/** Coordinates only the immutable package-declared lifecycle. Concrete ports
 * belong to the privileged supervisor; none are supplied by an API caller.
 * Failure never silently resumes an old writer against a changed schema.
 */
export async function runPostgresComponentLifecycle(input: unknown, topologyDigest: string, ports: PostgresLifecyclePorts) {
  const component = componentReleaseSchema.parse(input);
  if (!/^[a-f0-9]{64}$/u.test(topologyDigest) || deploymentDigest(component.runtime) !== component.runtimeDigest) throw new Error('Exact PostgreSQL lifecycle binding required');
  const lifecycles = component.runtime.postgresLifecycle;
  if (!lifecycles?.length) throw new Error('Declared PostgreSQL lifecycle required');
  const migrations = lifecycles.map(item => item.migration.composeService);
  const runtime = component.runtime.services.map(item => item.composeService).filter(service => !migrations.includes(service));
  if (await ports.accepted(component.runtimeDigest, topologyDigest)) {
    const verified = await Promise.all(lifecycles.map(item => ports.verifyRuntime(item.requirementId)));
    if (verified.every(Boolean)) {
      if (await ports.runtimeHealthy(runtime)) return { componentId: component.componentId, action: 'noop' as const };
      for (const item of lifecycles) await ports.materialize(item.requirementId, 'runtime');
      await ports.startRuntime(runtime);
      if (!await ports.runtimeHealthy(runtime)) throw new Error('PostgreSQL component runtime remains unhealthy');
      return { componentId: component.componentId, action: 'restarted' as const };
    }
    // Drift needs an explicit repair, not unexpected database downtime.
    throw new Error('PostgreSQL runtime drift requires repair before activation');
  }
  await ports.requireRestorePoint();
  let stage = 'stop-writers';
  try {
    await ports.stopServices([...runtime, ...migrations]);
    for (const item of lifecycles) {
      const id = item.requirementId;
      stage = 'credential-custody'; await ports.ensureCredentials(id);
      stage = 'migration-activation'; await ports.activate(id, 'migration');
      await ports.materialize(id, 'migration');
      stage = 'schema-migration'; await ports.migrate(item.migration);
      await ports.stopServices([item.migration.composeService]);
      await ports.clear(id, 'migration');
      stage = 'runtime-activation'; await ports.activate(id, 'runtime');
      await ports.materialize(id, 'runtime');
      if (!await ports.verifyRuntime(id)) throw new Error();
    }
    stage = 'runtime-health'; await ports.startRuntime(runtime);
    if (!await ports.runtimeHealthy(runtime)) throw new Error();
    for (const item of lifecycles) if (!await ports.verifyRuntime(item.requirementId)) throw new Error();
    stage = 'receipt'; await ports.record(component.runtimeDigest, topologyDigest);
    return { componentId: component.componentId, action: 'activated' as const };
  } catch {
    const cleanup = await Promise.allSettled([
      ports.stopServices([...runtime, ...migrations]),
      ...lifecycles.map(item => ports.disable(item.requirementId)),
      ...lifecycles.flatMap(item => (['migration', 'runtime'] as const).map(phase => ports.clear(item.requirementId, phase))),
    ]);
    const cleanupFailed = cleanup.some(item => item.status === 'rejected');
    throw new Error(`PostgreSQL component activation failed (${stage}); ${cleanupFailed ? 'cleanup requires recovery' : 'writers disabled; explicit retry or coordinated restore required'}`);
  }
}
