import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { atomicJson } from '../core/files.js';
import { paths } from '../core/paths.js';

const updateStateSchema = z.object({
	stablePaused: z.boolean(),
	developmentPaused: z.boolean(),
	developmentPauseOwners: z.array(z.string().min(1)).default([]),
	changedAt: z.string().datetime(),
	metadataCheckedAt: z.object({ stable: z.string().datetime().nullable(), development: z.string().datetime().nullable() }).strict().default({ stable: null, development: null }),
}).strict();

export type UpdateState = z.infer<typeof updateStateSchema>;
const statePath = `${paths.managerState}/update-state.json`;

export function loadUpdateState(): UpdateState {
	if (!existsSync(statePath)) return { stablePaused: false, developmentPaused: false, developmentPauseOwners: [], changedAt: new Date(0).toISOString(), metadataCheckedAt: { stable: null, development: null } };
	return updateStateSchema.parse(JSON.parse(readFileSync(statePath, 'utf8')));
}

export function metadataChecked(track: 'stable' | 'development', checkedAt = new Date()): UpdateState {
	const current = loadUpdateState();
	const next = { ...current, metadataCheckedAt: { ...current.metadataCheckedAt, [track]: checkedAt.toISOString() } };
	atomicJson(statePath, next);
	return next;
}

export function updatePaused(track: 'stable' | 'development', paused: boolean): UpdateState {
	const current = loadUpdateState();
	const next = { ...current, [`${track}Paused`]: paused, changedAt: new Date().toISOString() } as UpdateState;
	atomicJson(statePath, next);
	return next;
}

export function noteDevelopmentPauseOwner(sessionId: string, active: boolean): UpdateState {
	const current = loadUpdateState();
	const owners = new Set(current.developmentPauseOwners);
	if (active) owners.add(sessionId); else owners.delete(sessionId);
	const next = { ...current, developmentPauseOwners: [...owners].sort(), changedAt: new Date().toISOString() };
	atomicJson(statePath, next);
	return next;
}

export function recoverDevelopmentPauseOwners(activeSessionIds: readonly string[]): UpdateState {
	const active = new Set(activeSessionIds), current = loadUpdateState();
	const retained = current.developmentPauseOwners.filter((sessionId) => active.has(sessionId));
	if (retained.length === current.developmentPauseOwners.length) return current;
	const next = { ...current, developmentPauseOwners: retained, changedAt: new Date().toISOString() };
	atomicJson(statePath, next);
	return next;
}

export function trackPaused(track: 'stable' | 'development') {
	return loadUpdateState()[`${track}Paused`];
}
