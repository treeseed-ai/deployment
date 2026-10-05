import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function run(executable: string, args: string[], ignoreFailure = false) {
	try { execFileSync(executable, args, { stdio: 'ignore', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } }); }
	catch (error) { if (!ignoreFailure) throw error; }
}

export function ensureSandboxNetwork() {
	if (process.getuid?.() !== 0) throw new Error('TreeSeed sandbox network setup requires root.');
	try { execFileSync('/usr/sbin/ip', ['link', 'show', 'treeseed-sbx0'], { stdio: 'ignore' }); }
	catch { run('/usr/sbin/ip', ['link', 'add', 'name', 'treeseed-sbx0', 'type', 'bridge']); }
	run('/usr/sbin/ip', ['address', 'replace', '10.89.0.1/24', 'dev', 'treeseed-sbx0']); run('/usr/sbin/ip', ['link', 'set', 'treeseed-sbx0', 'up']);
	if (!existsSync('/etc/treeseed/sandbox/network.nft')) throw new Error('TreeSeed sandbox nftables policy is unavailable.');
	run('/usr/sbin/nft', ['delete', 'table', 'inet', 'treeseed_sandbox'], true); run('/usr/sbin/nft', ['--file', '/etc/treeseed/sandbox/network.nft']);
	return { bridge: 'treeseed-sbx0', gateway: '10.89.0.1', defaultDeny: true };
}

if (process.argv[1]?.endsWith('/sandbox-network.js')) ensureSandboxNetwork();
