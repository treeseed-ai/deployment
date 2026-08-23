import type { DeploymentTrack, HostConfiguration } from '@treeseed/sdk/deployment';

const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

export function activationEligible(host: HostConfiguration, track: DeploymentTrack, now = new Date()) {
	if (track === 'development') return true;
	const window = host.updates.stable.maintenanceWindow;
	const [hour, minute] = window.localTime.split(':').map(Number) as [number, number];
	return weekdays[now.getDay()] === window.weekday && now.getHours() === hour && now.getMinutes() >= minute;
}

export function pollIntervalSeconds(host: HostConfiguration, track: DeploymentTrack) {
	return track === 'development' ? host.updates.development.pollSeconds : host.updates.stable.metadataPollSeconds;
}
