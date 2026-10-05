import { statSync } from 'node:fs';

export interface HostRuntimeOperations {
	sandboxBrokerGid(): number;
}

const hostRuntimeOperations: HostRuntimeOperations = {
	sandboxBrokerGid: () => statSync('/run/treeseed/sandbox').gid,
};

export function managedHostRuntimeEnvironment(componentId: string, operations: HostRuntimeOperations = hostRuntimeOperations) {
	if (componentId !== 'agent') return {};
	const gid = operations.sandboxBrokerGid();
	if (!Number.isInteger(gid) || gid < 0) throw new Error('Sandbox broker group identity is invalid.');
	return { TREESEED_SANDBOX_BROKER_GID: String(gid) };
}
