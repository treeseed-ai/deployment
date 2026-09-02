import { authorizeHostedTopologyRollbackExecution, authorizedHostedTopologyPlanSchema, hostedTopologyPlanSchema, hostedTopologyReceiptSchema, planHostedTopologyRollbackExecution } from '@treeseed/sdk/deployment';
import { infrastructureDigest } from './toolchain.js';
import { renderHostedInfrastructureWorkspace, type HostedInfrastructureWorkspace } from './workspace.js';

export function renderHostedInfrastructureRollbackWorkspace(input: {
	execution: unknown;
	approval: unknown;
	sourceReceipt: unknown;
	sourcePlan: unknown;
	targetPlan: unknown;
}): HostedInfrastructureWorkspace {
	const authorized = authorizeHostedTopologyRollbackExecution(input.execution as never, input.approval as never);
	const rollback = authorized.execution.rollback, sourceReceipt = hostedTopologyReceiptSchema.parse(input.sourceReceipt);
	const sourcePlan = input.sourcePlan && typeof input.sourcePlan === 'object' && 'approval' in input.sourcePlan
		? authorizedHostedTopologyPlanSchema.parse(input.sourcePlan)
		: hostedTopologyPlanSchema.parse(input.sourcePlan);
	const targetPlan = hostedTopologyPlanSchema.parse(input.targetPlan);
	const expectedExecution = planHostedTopologyRollbackExecution({ rollback, sourceReceipt, sourcePlan, targetPlan });
	if (expectedExecution.executionDigest !== authorized.execution.executionDigest) throw new Error('Hosted infrastructure rollback execution does not match its approved source and target plans.');
	if (sourceReceipt.receiptId !== rollback.sourceReceiptId || sourceReceipt.planDigest !== sourcePlan.planDigest) throw new Error('Hosted infrastructure rollback source receipt is stale.');
	if ([sourceReceipt.environment, sourcePlan.environment, targetPlan.environment].some((environment) => environment !== rollback.environment)) throw new Error('Hosted infrastructure rollback environment does not match its source and target plans.');
	if (sourcePlan.topologyId !== targetPlan.topologyId || sourcePlan.topologyId !== sourceReceipt.topologyId) throw new Error('Hosted infrastructure rollback topology identity changed.');
	const sourceActions = new Map(sourcePlan.actions.map((action) => [action.resourceId, action]));
	const targetActions = new Map(targetPlan.actions.map((action) => [action.resourceId, action]));
	const sourceResources = new Map(sourceReceipt.resources.map((resource) => [resource.resourceId, resource]));
	if (rollback.operations.length !== sourceActions.size || new Set(rollback.operations.map(({ resourceId }) => resourceId)).size !== sourceActions.size) throw new Error('Hosted infrastructure rollback does not cover the complete source resource set.');
	for (const operation of rollback.operations) {
		const source = sourceActions.get(operation.resourceId), observed = sourceResources.get(operation.resourceId), target = targetActions.get(operation.resourceId);
		if (!source || !observed || observed.providerResourceId !== operation.providerResourceId) throw new Error(`Hosted infrastructure rollback source mismatch for ${operation.resourceId}.`);
		if (operation.action === 'delete-created') {
			if (target) throw new Error(`Hosted infrastructure rollback target must remove created resource ${operation.resourceId}.`);
		} else if (!target || !operation.targetDigest || target.desiredDigest !== operation.targetDigest || target.provider !== source.provider || target.kind !== source.kind) {
			throw new Error(`Hosted infrastructure rollback target specification mismatch for ${operation.resourceId}.`);
		}
	}
	if ([...targetActions.keys()].some((resourceId) => !sourceActions.has(resourceId))) throw new Error('Hosted infrastructure rollback target introduces an unapproved resource.');
	const sourceWorkspace = renderHostedInfrastructureWorkspace({ plan: sourcePlan });
	const targetWorkspace = renderHostedInfrastructureWorkspace({ plan: targetPlan });
	const authorities = [...sourceWorkspace.authorities, ...targetWorkspace.authorities].reduce((map, authority) => {
		const existing = map.get(authority.requestId);
		if (existing && (existing.environment !== authority.environment || existing.provider !== authority.provider || existing.connectionRef !== authority.connectionRef || existing.secretRef !== authority.secretRef || existing.credentialProfileId !== authority.credentialProfileId || existing.purpose !== authority.purpose)) throw new Error(`Hosted infrastructure rollback authority ${authority.requestId} changed.`);
		map.set(authority.requestId, existing ? { ...existing, capabilities: [...new Set([...existing.capabilities, ...authority.capabilities])].sort() } : authority);
		return map;
	}, new Map<string, HostedInfrastructureWorkspace['authorities'][number]>());
	const files = { ...targetWorkspace.files, 'main.tf': targetWorkspace.files['main.tf']!.replaceAll('prevent_destroy = true', 'prevent_destroy = false') };
	const core = { ...targetWorkspace, planDigest: rollback.rollbackDigest, executable: true, files,
		authorities: [...authorities.values()].sort((left, right) => left.requestId.localeCompare(right.requestId)),
		removedResources: rollback.operations.filter(({ action }) => action === 'delete-created').map(({ resourceId }) => {
			const source = sourceActions.get(resourceId)!; return { resourceId, provider: source.provider, kind: source.kind };
		}).sort((left, right) => left.resourceId.localeCompare(right.resourceId)),
	};
	const { bundleDigest: _bundleDigest, schemaVersion: _schemaVersion, ...closure } = core;
	return { ...core, bundleDigest: infrastructureDigest(closure) };
}
