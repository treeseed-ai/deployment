import { chmodSync, mkdirSync, openSync, closeSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function atomicJson(path: string, value: unknown, mode = 0o640) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
	const temporary = `${path}.${process.pid}.new`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode, flag: 'wx' });
	const descriptor = openSync(temporary, 'r');
	try { chmodSync(temporary, mode); } finally { closeSync(descriptor); }
	renameSync(temporary, path);
}
