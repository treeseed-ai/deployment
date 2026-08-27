import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'treeseed-development-update-state-'));
vi.mock('../src/core/paths.js', () => ({ paths: { managerState: root } }));
const { loadUpdateState, noteDevelopmentPauseOwner, recoverDevelopmentPauseOwners, trackPaused, updatePaused } = await import('../src/manager/update-state.js');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('development update pause ownership', () => {
	it('keeps explicit user pauses independent from session component holds', () => {
		noteDevelopmentPauseOwner('session-1', true);
		expect(loadUpdateState().developmentPauseOwners).toEqual(['session-1']);
		expect(trackPaused('development')).toBe(false);
		updatePaused('development', true);
		noteDevelopmentPauseOwner('session-1', false);
		expect(trackPaused('development')).toBe(true);
		expect(loadUpdateState().developmentPauseOwners).toEqual([]);
		updatePaused('development', false);
		expect(trackPaused('development')).toBe(false);
	});

	it('recovers ownership left by sessions that are no longer active', () => {
		noteDevelopmentPauseOwner('active-session', true);
		noteDevelopmentPauseOwner('orphan-session', true);
		recoverDevelopmentPauseOwners(['active-session']);
		expect(loadUpdateState().developmentPauseOwners).toEqual(['active-session']);
	});
});
