import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export function workspaceNbdServiceArguments(input: { id: string; directory: string; device: string; image: string; readOnly: boolean }) {
	if (!/^(?:workspace-probe|workspace-lease)-[a-f0-9-]{36}$/u.test(input.id)
		|| !/^\/dev\/nbd[0-9]+$/u.test(input.device)
		|| !input.directory.startsWith('/var/lib/treeseed/') || resolve(input.directory) !== input.directory
		|| !input.directory.endsWith(`/${input.id}`)
		|| !['analysis.qcow2', 'work.qcow2'].includes(input.image)) throw new Error('Invalid workspace NBD service custody.');
	const unit = `treeseed-${input.id}.service`;
	const runtimeDirectory = `treeseed-workspace/${input.id.slice(-36)}`;
	return { unit, args: ['--quiet', '--collect', `--unit=${unit}`, '--property=Type=forking',
		`--property=PIDFile=${input.directory}/nbd.pid`, '--property=Restart=no', '--property=KillMode=control-group',
		'--property=NoNewPrivileges=yes', '--property=ProtectHome=yes', '--property=ProtectSystem=strict',
		'--property=PrivateTmp=yes', '--property=PrivateNetwork=yes', '--property=UMask=0077',
		`--property=RuntimeDirectory=${runtimeDirectory}`, '--property=RuntimeDirectoryMode=0700',
		`--property=ReadWritePaths=${input.directory}`, '--property=DevicePolicy=closed',
		`--property=DeviceAllow=${input.device} rw`, '/usr/bin/qemu-nbd', '--format=qcow2', '--fork',
		`--pid-file=${input.directory}/nbd.pid`, ...(input.readOnly ? ['--read-only'] : []),
		`--socket=/run/${runtimeDirectory}/nbd.sock`, `--connect=${input.device}`, `${input.directory}/${input.image}`] };
}

/** Its own systemd cgroup survives manager/supervisor updates; never attach it to the caller's unit. */
export async function startWorkspaceNbdService(input: Parameters<typeof workspaceNbdServiceArguments>[0]) {
	const { unit, args } = workspaceNbdServiceArguments(input);
	await exec('/usr/bin/systemd-run', args, { timeout: 30_000, maxBuffer: 65_536, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } });
	return unit;
}
