import { describe, expect, it } from 'vitest';
import { workspaceNbdServiceArguments } from '../src/sandbox/workspace-nbd-service.js';
const id = 'workspace-lease-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const input = { id, directory: `/var/lib/treeseed/agent/workspaces/${id}`, device: '/dev/nbd0', image: 'analysis.qcow2', readOnly: false };
describe('updater-independent workspace disk service', () => {
	it('gives analysis a writable private overlay without tying NBD to the supervisor cgroup', () => {
		const result = workspaceNbdServiceArguments(input);
		expect(result.unit).toBe(`treeseed-${id}.service`);
		expect(result.args).toContain('--property=Type=forking');
		expect(result.args).toContain('--property=ProtectSystem=strict');
		expect(result.args).toContain(`--property=DeviceAllow=${input.device} rw`);
		expect(result.args).not.toContain('--read-only');
		expect(result.args.find(arg => arg.startsWith('--socket='))!.slice('--socket='.length).length).toBeLessThan(108);
		expect(result.args.join(' ')).not.toMatch(/PartOf|BindsTo|supervisor|--scope/u);
	});
	it('rejects caller paths, unrelated devices, image formats and IDs', () => {
		for (const value of [{...input,id:'unowned'}, {...input,device:'/dev/sda'}, {...input,image:'../other'},
			{...input,directory:'/tmp/workspace'}, {...input,directory:`/var/lib/treeseed/../${id}`}]) {
			expect(() => workspaceNbdServiceArguments(value)).toThrow('custody');
		}
	});
	it('binds each work disk to one independently owned collected service socket and kill group without changing its input', () => {
		for (const readOnly of [false, true]) {
			const original = { ...input, directory: `/var/lib/treeseed/agent/workspaces/leases/${id}`, image: 'work.qcow2', readOnly };
			const before = structuredClone(original);
			const result = workspaceNbdServiceArguments(original);
			expect(result).toEqual({ unit: `treeseed-${id}.service`, args: [
				'--quiet', '--collect', `--unit=treeseed-${id}.service`, '--property=Type=forking',
				`--property=PIDFile=${original.directory}/nbd.pid`, '--property=Restart=no', '--property=KillMode=control-group',
				'--property=NoNewPrivileges=yes', '--property=ProtectHome=yes', '--property=ProtectSystem=strict',
				'--property=PrivateTmp=yes', '--property=PrivateNetwork=yes', '--property=UMask=0077',
				'--property=RuntimeDirectory=treeseed-workspace/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '--property=RuntimeDirectoryMode=0700',
				`--property=ReadWritePaths=${original.directory}`, '--property=DevicePolicy=closed', '--property=DeviceAllow=/dev/nbd0 rw',
				'/usr/bin/qemu-nbd', '--format=qcow2', '--fork', `--pid-file=${original.directory}/nbd.pid`,
				...(readOnly ? ['--read-only'] : []), '--socket=/run/treeseed-workspace/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/nbd.sock',
				'--connect=/dev/nbd0', `${original.directory}/work.qcow2`,
			] });
			expect(original).toEqual(before);
		}
	});
});
