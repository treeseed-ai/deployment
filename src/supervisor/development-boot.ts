import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { DevelopmentSessionStore, type ManagedDevelopmentSession } from '../manager/development-sessions.js';

type Command = (command: string, args: string[], input?: string) => unknown;
const worker = '/usr/lib/treeseed/cli/dist/cli/development/boot-resume.js';

export function captureBootCommand(command: Command, executable: string, args: string[]) {
	const value = command(executable, args, '');
	if (typeof value !== 'string') throw new Error('Development boot command returned no captured output.');
	return value.trim();
}

export function developmentBootCommand(record: ManagedDevelopmentSession, owner: { uid: number; gid: number; home: string }) {
	const sessionId = record.session.sessionId;
	if (!/^dev-[a-z0-9-]{1,64}$/.test(sessionId) || owner.uid <= 0 || !Number.isSafeInteger(owner.uid)
		|| !Number.isSafeInteger(owner.gid) || owner.gid < 0 || !owner.home.startsWith('/') || /[\r\n\0]/.test(owner.home)) throw new Error('Invalid development boot custody.');
	return ['--unit', `treeseed-development-resume-${sessionId}`, '--no-block',
		'--property=Type=oneshot', '--property=RemainAfterExit=yes', '--property=TimeoutStartSec=900',
		`--uid=${owner.uid}`, `--gid=${owner.gid}`, `--working-directory=${owner.home}`,
		`--setenv=HOME=${owner.home}`, '--setenv=PATH=/usr/lib/treeseed/runtime/bin:/usr/local/bin:/usr/bin:/bin',
		'/usr/lib/treeseed/runtime/bin/node', worker, sessionId];
}

/** Root only schedules a fixed installed worker; project commands execute as their owner. */
export function resumeDevelopmentAtBoot(sessionId: string, command: Command) {
	const record = new DevelopmentSessionStore().load(sessionId);
	if (record.session.status === 'stopped' || !record.session.targets.some(target => target.mode !== 'released')) return { ready: true };
	if (!existsSync(worker)) throw new Error('Installed CLI lacks development boot recovery; update its managed payload.');
	const owners = record.session.repositories.map(repository => {
		if (realpathSync(repository.worktree) !== repository.worktree) throw new Error('Development boot refuses symlinked worktrees.');
		return lstatSync(repository.worktree).uid;
	});
	if (!owners.length || owners[0] === 0 || owners.some(uid => uid !== owners[0])) throw new Error('Development session requires one non-root worktree owner.');
	const account = captureBootCommand(command, '/usr/bin/getent', ['passwd', String(owners[0])]).split(':');
	const owner = { uid: Number(account[2]), gid: Number(account[3]), home: account[5] ?? '' };
	if (owner.uid !== owners[0]) throw new Error('Development owner account does not match source custody.');
	const snapshot = resolve(owner.home, '.local/state/treeseed/development', sessionId, 'session.json');
	if (realpathSync(snapshot) !== snapshot || !lstatSync(snapshot).isFile() || lstatSync(snapshot).uid !== owner.uid) throw new Error('Saved development selection has no verified user custody.');
	const unit = `treeseed-development-resume-${sessionId}.service`;
	const load = captureBootCommand(command, '/usr/bin/systemctl', ['show', unit, '--property=LoadState', '--value']);
	if (load === 'loaded') {
		const state = captureBootCommand(command, '/usr/bin/systemctl', ['show', unit, '--property=ActiveState', '--value']);
		if (state === 'active') return { ready: true };
		if (state !== 'activating') command('/usr/bin/systemctl', ['start', '--no-block', unit]);
	} else command('/usr/bin/systemd-run', developmentBootCommand(record, owner));
	return { ready: false };
}
