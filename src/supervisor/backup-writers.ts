import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

type Capture = (args: string[]) => string;
const capture: Capture = args => execFileSync('/usr/bin/docker', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

/** Fresh daemon inventory per boundary, with one inspection process, never a cached authorization. */
export function inspectBackupWriters(run: Capture, format: string): [string, unknown][] {
	const ids = run(['ps', '--quiet']).trim().split(/\s+/u).filter(Boolean);
	if (new Set(ids).size !== ids.length || ids.some(id => !/^[a-f0-9]{12,64}$/u.test(id)))
		throw new Error('Unable to establish backup writer inventory.');
	if (!ids.length) return [];
	const lines = run(['inspect', '--format', format, ...ids]).trim().split('\n');
	if (lines.length !== ids.length) throw new Error('Incomplete backup writer inspection.');
	return ids.map((id, index) => [id, JSON.parse(lines[index]!) as unknown]);
}

/** Also catches development and unrelated containers sharing writable state. */
export function assertNoBackupWriters(members: string[], run: Capture = capture) {
	const roots = members.map(member => resolve('/', member));
	for (const [, mounts] of inspectBackupWriters(run, '{{json .Mounts}}')) {
		if (!Array.isArray(mounts)) throw new Error('Unable to establish backup writer mounts.');
		for (const mount of mounts) {
			if (!mount || typeof mount !== 'object') throw new Error('Unable to establish backup writer mount.');
			if (mount.RW !== true) continue;
			if (typeof mount.Source !== 'string' || !mount.Source.startsWith('/')) throw new Error('Unknown writable container mount.');
			const source = resolve(mount.Source);
			if (roots.some(root => root === source || root.startsWith(`${source}/`) || source.startsWith(`${root}/`) || source === '/')) throw new Error('Backup blocked: a running container still has writable access to required state. Stop its managed development or service target before retrying.');
		}
	}
}
