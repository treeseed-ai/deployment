import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from './paths.js';

const eventPath = `${paths.managerState}/events.jsonl`;

export interface ManagerEvent { at: string; type: string; details: Record<string, unknown> }

export function recordEvent(type: string, details: Record<string, unknown> = {}) {
	mkdirSync(dirname(eventPath), { recursive: true, mode: 0o750 });
	appendFileSync(eventPath, `${JSON.stringify({ at: new Date().toISOString(), type, details } satisfies ManagerEvent)}\n`, { encoding: 'utf8', mode: 0o640 });
}

export function recentEvents(limit = 100): ManagerEvent[] {
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Event limit must be between 1 and 500.');
	try {
		return readFileSync(eventPath, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map((line) => JSON.parse(line) as ManagerEvent);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
}
