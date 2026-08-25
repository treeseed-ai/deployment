import { createHash } from 'node:crypto';
import type { DeploymentTrack, HostConfiguration } from '@treeseed/sdk/deployment';
import type { UpdateState } from './update-state.js';

const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

export function activationEligible(host: HostConfiguration, track: DeploymentTrack, now = new Date()) {
	if (track === 'development') return true;
	const { eligibleAt, closesAt } = stableActivationWindow(host, now);
	return now >= eligibleAt && now < closesAt;
}

export function stableActivationWindow(host: HostConfiguration, now = new Date()) {
	const window = host.updates.stable.maintenanceWindow;
	const [hour, minute] = window.localTime.split(':').map(Number) as [number, number];
	const targetWeekday = weekdays.indexOf(window.weekday);
	const startsAt = new Date(now);
	startsAt.setDate(now.getDate() - ((now.getDay() - targetWeekday + 7) % 7));
	startsAt.setHours(hour, minute, 0, 0);
	const weekIdentity = `${startsAt.getFullYear()}-${startsAt.getMonth() + 1}-${startsAt.getDate()}`;
	const availableSeconds = window.jitterMinutes * 60;
	const value = createHash('sha256').update(`${host.host.id}:${weekIdentity}`).digest().readUInt32BE(0);
	const jitterSeconds = availableSeconds === 0 ? 0 : value % (availableSeconds + 1);
	const eligibleAt = new Date(startsAt.getTime() + jitterSeconds * 1_000);
	const closesAt = new Date(startsAt.getTime() + 60 * 60 * 1_000);
	return { startsAt, eligibleAt, closesAt, jitterSeconds };
}

export function pollIntervalSeconds(host: HostConfiguration, track: DeploymentTrack) {
	return track === 'development' ? host.updates.development.pollSeconds : host.updates.stable.metadataPollSeconds;
}

export function metadataRefreshDue(host: HostConfiguration, track: DeploymentTrack, state: UpdateState, now = new Date()) {
	const last = state.metadataCheckedAt[track];
	return last === null || now.getTime() - new Date(last).getTime() >= pollIntervalSeconds(host, track) * 1_000;
}
