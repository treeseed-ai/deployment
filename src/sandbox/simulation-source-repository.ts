import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { sourceWorkspaceKeySchema, type SourceWorkspaceKey } from '@treeseed/sdk/capacity-provider/sandbox';

/** One manager-owned simulation repository per immutable source security domain. */
export function simulationSourceRepository(root: string, input: SourceWorkspaceKey) {
	const source = sourceWorkspaceKeySchema.parse(input);
	const identity = {
		controlPlaneId: source.controlPlaneId,
		teamId: source.teamId,
		projectId: source.projectId,
		repositoryId: source.repositoryId,
		formatVersion: source.formatVersion,
		profile: source.profile,
	};
	const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
	return join(root, 'simulations', `${id}.git`);
}
