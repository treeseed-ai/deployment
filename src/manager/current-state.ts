import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { basename } from 'node:path';
import { componentReleaseSchema, hostReceiptSchema, type ComponentRelease, type HostReceipt } from '@treeseed/sdk/deployment';
import { recordEvent } from '../core/events.js';
import { paths } from '../core/paths.js';

type EventRecorder = (type: string, details: Record<string, unknown>) => void;

function quarantineInvalidState(path: string, invalidRoot: string, kind: 'receipt' | 'components', event: EventRecorder) {
	mkdirSync(invalidRoot, { recursive: true, mode: 0o700 });
	const archive = `${invalidRoot}/${Date.now()}-${process.pid}-${basename(path)}.invalid`;
	renameSync(path, archive);
	event('manager-state.quarantined', { kind, archive });
	return archive;
}

export function loadCurrentReceipt(path: string = `${paths.managerState}/current-receipt.json`, invalidRoot: string = `${paths.managerState}/invalid-state`, event: EventRecorder = recordEvent): HostReceipt | undefined {
	if (!existsSync(path)) return undefined;
	try { return hostReceiptSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
	catch {
		quarantineInvalidState(path, invalidRoot, 'receipt', event);
		return undefined;
	}
}

export function loadActiveComponents(path: string = `${paths.managerState}/active-components.json`, invalidRoot: string = `${paths.managerState}/invalid-state`, event: EventRecorder = recordEvent): ComponentRelease[] {
	if (!existsSync(path)) return [];
	try {
		const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
		if (!Array.isArray(value)) throw new Error('Active component state is malformed.');
		return value.map((component) => componentReleaseSchema.parse(component));
	} catch {
		quarantineInvalidState(path, invalidRoot, 'components', event);
		return [];
	}
}
