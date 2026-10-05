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
});
