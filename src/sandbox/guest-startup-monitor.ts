import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isMainThread } from 'node:worker_threads';

/** Preload before application imports. Do not catch/suppress the exception or
 * export raw exception messages, stack traces, environment, or credentials.
 */
export function installGuestStartupMonitor(outputRoot: string) {
	const progress = resolve(outputRoot, 'progress.json');
	const failure = resolve(outputRoot, 'failure.json');
	writeFileSync(progress, JSON.stringify({ stage: 'bootstrap.started', occurredAt: new Date().toISOString() }), { mode: 0o600 });
	const report = (code: string) => {
		try {
			if (existsSync(failure)) return;
			let stage = 'bootstrap.started';
			if (statSync(progress).size <= 4096) {
				const recorded = JSON.parse(readFileSync(progress, 'utf8')).stage;
				if (typeof recorded === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/u.test(recorded)) stage = recorded;
			}
			writeFileSync(failure, JSON.stringify({ error: `Guest process failed (${code}; phase=${stage}).`,
				startup: { code, stage } }), { mode: 0o600, flag: 'wx' });
		} catch { /* Diagnostics must not change guest execution or teardown. */ }
	};
	process.on('uncaughtExceptionMonitor', (error) => {
		const code = 'code' in error && typeof error.code === 'string' && /^(ERR_[A-Z0-9_]{1,60}|E[A-Z0-9_]{1,30})$/u.test(error.code)
			? error.code : 'UNCLASSIFIED';
		report(code);
	});
	process.once('exit', code => { if (code !== 0) report(`EXIT_${code}`); });
}

// NODE_OPTIONS is inherited by child harnesses. Only instrument the primary
// guest entrypoint, never MCP subprocesses, harnesses, or worker threads.
if (isMainThread && process.argv[1]?.endsWith('/sandbox/guest.js') && !process.argv.includes('--treedx-mcp')) {
	installGuestStartupMonitor('/run/treeseed-output');
}
