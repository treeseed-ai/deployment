import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { atomicJson } from '../core/files.js';
import { paths } from '../core/paths.js';

const updateStateSchema = z.object({
	stablePaused: z.boolean(),
	developmentPaused: z.boolean(),
	changedAt: z.string().datetime(),
}).strict();

export type UpdateState = z.infer<typeof updateStateSchema>;
const statePath = `${paths.managerState}/update-state.json`;

export function loadUpdateState(): UpdateState {
	if (!existsSync(statePath)) return { stablePaused: false, developmentPaused: false, changedAt: new Date(0).toISOString() };
	return updateStateSchema.parse(JSON.parse(readFileSync(statePath, 'utf8')));
}

export function updatePaused(track: 'stable' | 'development', paused: boolean): UpdateState {
	const current = loadUpdateState();
	const next = { ...current, [`${track}Paused`]: paused, changedAt: new Date().toISOString() } as UpdateState;
	atomicJson(statePath, next);
	return next;
}

export function trackPaused(track: 'stable' | 'development') {
	return loadUpdateState()[`${track}Paused`];
}
