export interface HostSecurityActivationStatus {
	backingExists: boolean;
	mapperOpen: boolean;
	mounted: boolean;
	credentialKeksReady: boolean;
	recoveryBundleVerified: boolean;
	sandboxSocketReady: boolean;
}

export function hostSecurityActivationBlockers(required: boolean, status: HostSecurityActivationStatus) {
	if (!required) return [];
	return (Object.entries(status) as Array<[keyof HostSecurityActivationStatus, boolean]>)
		.filter(([, ready]) => !ready)
		.map(([name]) => name)
		.sort();
}
