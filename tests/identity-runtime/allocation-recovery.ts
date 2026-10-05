import assert from 'node:assert/strict';
import { postgresTopologySchema } from '@treeseed/sdk/deployment';
import { applyPostgresAllocations, inspectPostgresAllocations, planPostgresAllocations } from '../../dist/src/postgres/plan.js';
import type { PostgresInspectionSession } from '../../dist/src/postgres/inventory.js';

/** Real CREATE DATABASE interruptions, not mocked catalog state. */
export async function verifyAllocationRecovery(input: unknown, session: PostgresInspectionSession) {
  for (const boundary of ['before', 'after'] as const) {
    const topology = postgresTopologySchema.parse(input), name = `resume_${boundary}`;
    topology.requirements[0]!.id = `resume-${boundary}`;
    topology.allocations = [{ ...topology.allocations[0]!, requirementId: `resume-${boundary}`, database: name,
      ownerRole: `${name}_owner`, migrationRole: `${name}_migrator`, runtimeRole: `${name}_runtime` }];
    const inspect = () => inspectPostgresAllocations('shared', session);
    let interrupted = false;
    const fault: PostgresInspectionSession = { async query(sql, values) {
      if (!interrupted && sql.startsWith('CREATE DATABASE')) {
        interrupted = true;
        if (boundary === 'after') await session.query(sql, values);
        throw new Error('Synthetic interruption');
      }
      return session.query(sql, values);
    } };
    await assert.rejects(applyPostgresAllocations(topology, planPostgresAllocations(topology, [await inspect()]), new Map([['shared', fault]])));
    assert.equal(interrupted, true);
    const pending = await inspect();
    const plan = planPostgresAllocations(topology, [pending]);
    assert.equal(plan.ready, true);
    assert.equal(plan.actions[0]?.action, 'resume');
    const changed = structuredClone(topology); changed.allocations[0]!.database = `${name}_other`;
    assert.equal(planPostgresAllocations(changed, [pending]).ready, false);
    const result = await applyPostgresAllocations(topology, plan, new Map([['shared', session]]));
    assert.deepEqual(result.created, [`resume-${boundary}`]);
    const final = await inspect();
    assert.equal(planPostgresAllocations(topology, [final]).actions[0]?.action, 'verify');
    assert.equal(final.databases.find(database => database.name === name)?.allowConnections, true);
    assert.ok(final.roles.filter(role => role.name.startsWith(name)).every(role => role.login === false && role.pendingDigest === undefined));
  }
}
