import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installGuestStartupMonitor } from '../../src/sandbox/guest-startup-monitor.js';

const root = process.argv[2]!, mode = process.argv[3];
installGuestStartupMonitor(root);
if (mode === 'application-failure') {
	writeFileSync(resolve(root, 'failure.json'), JSON.stringify({ error: 'application-owned failure' }));
	process.exitCode = 1;
} else if (mode === 'missing-import') {
	const specifier = './missing-guest-dependency.js';
	await import(specifier);
} else if (mode === 'secret-error') {
	throw new Error('do-not-export-test-credential');
} else if (mode === 'early-exit') process.exitCode = 1;
