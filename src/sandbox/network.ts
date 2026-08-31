import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CommandRunner } from '../supervisor/execute.js';

export function sandboxCniConfiguration() {
	return { cniVersion: '1.0.0', name: 'treeseed-sandboxes', plugins: [
		{ type: 'bridge', bridge: 'treeseed-sbx0', isGateway: true, ipMasq: false, hairpinMode: false, ipam: { type: 'host-local', ranges: [[{ subnet: '10.89.0.0/24', gateway: '10.89.0.1' }]], routes: [{ dst: '0.0.0.0/0', gw: '10.89.0.1' }] } },
		{ type: 'firewall', ingressPolicy: 'same-bridge' },
	] };
}

export const sandboxNetworkRules = 'table inet treeseed_sandbox {\n chain input { type filter hook input priority -10; policy accept; iifname "treeseed-sbx0" ip daddr 10.89.0.1 tcp dport { 7443, 7444 } accept; iifname "treeseed-sbx0" drop; }\n chain forward { type filter hook forward priority -10; policy accept; iifname "treeseed-sbx0" drop; oifname "treeseed-sbx0" ct state established,related accept; oifname "treeseed-sbx0" drop; }\n}\n';

export function ensureSandboxNetwork(command: CommandRunner, roots: { cni?: string; nft?: string } = {}) {
	const cni = roots.cni ?? '/etc/cni/net.d/20-treeseed-sandboxes.conflist', nft = roots.nft ?? '/etc/treeseed/sandbox/network.nft';
	for (const [path, content, mode] of [[cni, `${JSON.stringify(sandboxCniConfiguration(), null, 2)}\n`, 0o644], [nft, sandboxNetworkRules, 0o640]] as const) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o755 }); const temporary = `${path}.new`; writeFileSync(temporary, content, { mode }); renameSync(temporary, path);
	}
	try { command('/usr/sbin/nft', ['delete', 'table', 'inet', 'treeseed_sandbox']); } catch { /* first activation has no prior table */ }
	command('/usr/sbin/nft', ['--file', nft]);
}
