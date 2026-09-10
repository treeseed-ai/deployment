import { readFileSync, writeFileSync } from 'node:fs';

// Fixed, credential-free fixture executed inside Kata, never on the host.
try {
const mode = process.argv[2];
if (mode !== 'read-only' && mode !== 'private-write') throw new Error('Invalid qualification mode.');
const source = readFileSync('/workspace/project/source.txt', 'utf8');
if (source !== 'treeseed-workspace-fixture-v1\n') throw new Error('Unexpected source image.');
let writeDenied = false;
try { writeFileSync('/workspace/project/private.txt', 'execution-private\n', { flag: 'wx' }); }
catch (error) {
	if ((error as NodeJS.ErrnoException).code !== 'EROFS') throw error;
	writeDenied = true;
}
if (writeDenied !== (mode === 'read-only')) throw new Error('Block write isolation failed.');
writeFileSync('/run/treeseed-output/qualification.json', JSON.stringify({ mode, sourceVerified: true, writeDenied }));
} catch (error) {
	writeFileSync('/run/treeseed-output/qualification.json', JSON.stringify({ failed: true,
		code: (error as NodeJS.ErrnoException).code ?? 'probe_failed', message: error instanceof Error ? error.message : 'Probe failed.' }));
	process.exitCode = 1;
}
