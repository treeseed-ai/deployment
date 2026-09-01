import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readlinkSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type UninstallKind = 'package' | 'unit' | 'path' | 'container' | 'image' | 'network' | 'volume' | 'mount' | 'mapper' | 'user' | 'group' | 'containerd-namespace' | 'nft-table';
export interface UninstallItem { kind: UninstallKind; id: string; security: boolean }
export interface UninstallPlan { schemaVersion: 'treeseed.host-uninstall-plan/v1'; mutation: false; items: UninstallItem[]; preserves: string[] }
export type UninstallCommand = (executable: string, arguments_: readonly string[]) => string;

const run: UninstallCommand = (executable, arguments_) => String(execFileSync(executable, [...arguments_], {
	encoding: 'utf8', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DEBIAN_FRONTEND: 'noninteractive' },
}));
const lines = (value: string) => value.split('\n').map((entry) => entry.trim()).filter(Boolean);
const query = (command: UninstallCommand, executable: string, arguments_: readonly string[]) => { try { return lines(command(executable, arguments_)); } catch { return []; } };
const attempt = (command: UninstallCommand, executable: string, arguments_: readonly string[]) => { try { command(executable, arguments_); } catch { /* Idempotent cleanup tolerates already-absent resources. */ } };
const rooted = (root: string, path: string) => root === '/' ? path : resolve(root, path.slice(1));

const managedPaths = [
	'/etc/treeseed', '/var/lib/treeseed', '/var/cache/treeseed', '/run/treeseed', '/usr/lib/treeseed', '/usr/share/treeseed',
	'/etc/apt/sources.list.d/treeseed-deployment-stable.sources', '/etc/apt/sources.list.d/treeseed-deployment-development.sources',
	'/etc/apt/preferences.d/treeseed-deployment', '/etc/apt/keyrings/treeseed-deployment-stable.gpg', '/etc/apt/keyrings/treeseed-deployment-development.gpg',
	'/etc/cni/net.d/20-treeseed-sandboxes.conflist', '/opt/treeseed', '/etc/treeai', '/var/lib/treeai',
] as const;
const securityRoots = new Set(['/etc/treeseed', '/var/lib/treeseed', '/etc/treeai', '/var/lib/treeai']);
const ownedLinks = [
	{ path: '/opt/kata', target: '/opt/treeseed/kata/' },
	{ path: '/usr/local/bin/containerd-shim-kata-v2', target: '/opt/kata/' },
	{ path: '/etc/kata-containers/configuration.toml', target: '/opt/kata/' },
] as const;
const unitRoots = ['/etc/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system'] as const;
const itemKey = (item: UninstallItem) => `${item.kind}:${item.id}`;
const ownedSymbolicLink = (path: string, target: string) => { try { return lstatSync(path).isSymbolicLink() && readlinkSync(path).startsWith(target); } catch { return false; } };

export function planHostUninstall(options: { root?: string; command?: UninstallCommand } = {}): UninstallPlan {
	const root = resolve(options.root ?? '/'), command = options.command ?? run, items: UninstallItem[] = [];
	const add = (kind: UninstallKind, id: string, security = false) => { if (!items.some((item) => item.kind === kind && item.id === id)) items.push({ kind, id, security }); };
	for (const name of query(command, '/usr/bin/dpkg-query', ['-W', '-f=${binary:Package}\n', 'treeseed*'])) if (/^treeseed(?:-[a-z0-9-]+)?(?::[a-z0-9]+)?$/u.test(name)) add('package', name);
	for (const directory of unitRoots) {
		const target = rooted(root, directory);
		if (!existsSync(target)) continue;
		for (const name of readdirSync(target)) {
			if (/^treeseed-[a-z0-9@.-]+(?:\.service|\.socket|\.timer|\.target|\.mount|\.path)$/u.test(name)) add('unit', name);
			else if (/^treeseed-[a-z0-9@.-]+(?:\.service|\.socket|\.timer|\.target|\.mount|\.path)\.d$/u.test(name)) add('path', `${directory}/${name}`);
		}
	}
	for (const path of managedPaths) if (existsSync(rooted(root, path))) add('path', path, securityRoots.has(path));
	for (const link of ownedLinks) {
		const path = rooted(root, link.path);
		if (ownedSymbolicLink(path, link.target)) add('path', link.path);
	}
	const credentialStore = rooted(root, '/etc/credstore.encrypted');
	if (existsSync(credentialStore)) for (const name of readdirSync(credentialStore)) if (/^treeseed[-.][a-zA-Z0-9_.-]+$/u.test(name)) add('path', `/etc/credstore.encrypted/${name}`, true);
	for (const [kind, arguments_] of [
		['container', ['ps', '--all', '--quiet', '--filter', 'label=org.treeseed.manager=true']],
		['image', ['images', '--quiet', '--filter', 'label=org.treeseed.manager=true']],
		['network', ['network', 'ls', '--quiet', '--filter', 'label=org.treeseed.manager=true']],
		['volume', ['volume', 'ls', '--quiet', '--filter', 'label=org.treeseed.manager=true']],
	] as const) for (const id of query(command, '/usr/bin/docker', arguments_)) if (/^[a-zA-Z0-9_.:-]+$/u.test(id)) add(kind, id);
	for (const id of query(command, '/usr/bin/docker', ['ps', '--all', '--quiet', '--filter', 'label=com.docker.compose.project'])) {
		if (!/^[a-f0-9]{12,64}$/u.test(id)) continue;
		const project = query(command, '/usr/bin/docker', ['inspect', '--format={{ index .Config.Labels "com.docker.compose.project" }}', id])[0];
		if (project && /^treeseed-[a-z0-9_.-]+$/u.test(project)) add('container', id);
	}
	if (query(command, '/usr/bin/ctr', ['namespaces', 'list', '--quiet']).includes('treeseed-sandboxes')) add('containerd-namespace', 'treeseed-sandboxes');
	if (query(command, '/usr/sbin/nft', ['list', 'table', 'inet', 'treeseed_sandbox']).length) add('nft-table', 'inet:treeseed_sandbox');
	if (query(command, '/usr/bin/findmnt', ['--noheadings', '--output', 'TARGET', '/var/lib/treeseed/agent']).includes('/var/lib/treeseed/agent')) add('mount', '/var/lib/treeseed/agent', true);
	if (query(command, '/usr/sbin/cryptsetup', ['status', 'treeseed-agent']).length) add('mapper', 'treeseed-agent', true);
	for (const value of query(command, '/usr/bin/getent', ['passwd'])) { const user = value.split(':', 1)[0]!; if (/^treeseed(?:-[a-z0-9-]+)?$/u.test(user)) add('user', user, true); }
	for (const value of query(command, '/usr/bin/getent', ['group'])) { const group = value.split(':', 1)[0]!; if (/^treeseed(?:-[a-z0-9-]+)?$/u.test(group)) add('group', group, true); }
	return { schemaVersion: 'treeseed.host-uninstall-plan/v1', mutation: false, items: items.sort((a, b) => itemKey(a).localeCompare(itemKey(b))), preserves: ['source-repositories', 'external-recovery-bundles', 'unlabelled-container-infrastructure', 'unmanaged-user-data'] };
}

function removeContainerdNamespace(command: UninstallCommand) {
	const prefix = ['--namespace', 'treeseed-sandboxes'];
	for (const id of query(command, '/usr/bin/ctr', [...prefix, 'tasks', 'list', '--quiet'])) {
		attempt(command, '/usr/bin/ctr', [...prefix, 'tasks', 'kill', '--signal', 'SIGKILL', id]);
		attempt(command, '/usr/bin/ctr', [...prefix, 'tasks', 'delete', '--force', id]);
	}
	for (const id of query(command, '/usr/bin/ctr', [...prefix, 'containers', 'list', '--quiet'])) command('/usr/bin/ctr', [...prefix, 'containers', 'delete', id]);
	for (const id of query(command, '/usr/bin/ctr', [...prefix, 'images', 'list', '--quiet'])) command('/usr/bin/ctr', [...prefix, 'images', 'remove', id]);
	command('/usr/bin/ctr', ['namespaces', 'remove', 'treeseed-sandboxes']);
	attempt(command, '/usr/bin/rmdir', ['/sys/fs/cgroup/treeseed-sandboxes']);
}

export function uninstallReceiptPath(operationId: string) {
	if (!/^uninstall-[a-f0-9-]{36}$/u.test(operationId)) throw new Error('Invalid uninstall operation identifier.');
	return `/var/tmp/${operationId}.json`;
}

export function executeHostUninstall(purgeSecurity: boolean, options: { root?: string; command?: UninstallCommand; operationId?: string; receiptPath?: string } = {}) {
	const root = resolve(options.root ?? '/'), command = options.command ?? run, plan = planHostUninstall({ root, command });
	const selected = plan.items.filter((item) => purgeSecurity || !item.security), by = (kind: UninstallKind) => selected.filter((item) => item.kind === kind).map((item) => item.id);
	for (const unit of by('unit')) attempt(command, '/usr/bin/systemctl', ['disable', '--now', unit]);
	for (const id of by('container')) command('/usr/bin/docker', ['rm', '--force', id]);
	for (const id of by('image')) command('/usr/bin/docker', ['image', 'rm', '--force', id]);
	for (const id of by('network')) command('/usr/bin/docker', ['network', 'rm', id]);
	for (const id of by('volume')) command('/usr/bin/docker', ['volume', 'rm', id]);
	if (by('containerd-namespace').length) removeContainerdNamespace(command);
	if (by('nft-table').length) command('/usr/sbin/nft', ['delete', 'table', 'inet', 'treeseed_sandbox']);
	for (const target of by('mount')) command('/usr/bin/umount', [target]);
	for (const mapper of by('mapper')) command('/usr/sbin/cryptsetup', ['close', mapper]);
	const packages = by('package'); if (packages.length) command('/usr/bin/apt-get', ['-y', 'purge', ...packages]);
	for (const unit of by('unit')) for (const directory of unitRoots) rmSync(rooted(root, `${directory}/${unit}`), { recursive: true, force: true });
	for (const path of by('path').sort((a, b) => b.length - a.length)) rmSync(rooted(root, path), { recursive: true, force: true });
	for (const user of by('user')) command('/usr/sbin/userdel', [user]);
	for (const group of by('group')) attempt(command, '/usr/sbin/groupdel', [group]);
	attempt(command, '/usr/bin/systemctl', ['daemon-reload']);
	const receipt = { schemaVersion: 'treeseed.host-uninstall-receipt/v1', receiptId: options.operationId ?? `uninstall-${Date.now()}`, state: 'completed', purgedSecurity: purgeSecurity, removed: Object.fromEntries([...new Set(selected.map((item) => item.kind))].map((kind) => [kind, selected.filter((item) => item.kind === kind).length])), preserved: plan.preserves, completedAt: new Date().toISOString() };
	if (options.receiptPath) { writeFileSync(`${options.receiptPath}.new`, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }); renameSync(`${options.receiptPath}.new`, options.receiptPath); }
	return receipt;
}

export function scheduleHostUninstall(purgeSecurity: boolean, command: UninstallCommand = run) {
	const operationId = `uninstall-${randomUUID()}`, receiptPath = uninstallReceiptPath(operationId), unit = `treeseed-uninstall-${operationId.slice('uninstall-'.length)}`;
	command('/usr/bin/systemd-run', ['--unit', unit, '--collect', '--no-block', '--property=Type=exec', '/usr/lib/treeseed/runtime/bin/node', '/usr/lib/treeseed/manager/dist/src/bin/uninstall.js', `--operation-id=${operationId}`, `--purge-security=${purgeSecurity ? 'true' : 'false'}`]);
	return { schemaVersion: 'treeseed.host-uninstall-accepted/v1', operationId, state: 'accepted', receiptPath };
}
