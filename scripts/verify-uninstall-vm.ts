import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { executeHostUninstall, planHostUninstall } from '../src/supervisor/uninstall.js';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.TREESEED_UNINSTALL_DISPOSABLE_VM !== '1' || process.getuid?.() !== 0) {
	throw new Error('Uninstall VM acceptance is restricted to an explicitly marked root GitHub Actions runner.');
}

const temporary = mkdtempSync('/var/tmp/treeseed-uninstall-vm-');
const preserved = resolve(temporary, 'unmanaged-preserved.txt');
writeFileSync(preserved, 'preserve\n');
const run = (executable: string, arguments_: string[]) => execFileSync(executable, arguments_, { stdio: 'pipe', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DEBIAN_FRONTEND: 'noninteractive' } });
const ensureGroup = (name: string) => { try { run('/usr/sbin/groupadd', ['--system', name]); } catch { /* fixture already exists */ } };

function fixturePackage(name: string) {
	const stage = resolve(temporary, name), control = resolve(stage, 'DEBIAN');
	mkdirSync(control, { recursive: true }); mkdirSync(resolve(stage, 'usr/share', name), { recursive: true });
	writeFileSync(resolve(control, 'control'), `Package: ${name}\nVersion: 1.0.0\nArchitecture: all\nMaintainer: TreeSeed Tests <tests@treeseed.ai>\nDescription: Disposable uninstall acceptance fixture\n`);
	writeFileSync(resolve(stage, 'usr/share', name, 'marker'), 'fixture\n');
	const archive = resolve(temporary, `${name}.deb`); run('/usr/bin/dpkg-deb', ['--build', '--root-owner-group', stage, archive]); run('/usr/bin/dpkg', ['--install', archive]);
}

function materialize(generation: 'current' | 'legacy') {
	fixturePackage(`treeseed-${generation}-fixture`);
	ensureGroup('treeseed-manager'); ensureGroup('treeseed-operators'); ensureGroup('treeseed-component-secrets');
	try { run('/usr/sbin/useradd', ['--system', '--gid', 'treeseed-manager', '--home-dir', '/nonexistent', '--no-create-home', 'treeseed-manager']); } catch { /* fixture already exists */ }
	for (const path of generation === 'current'
		? ['/etc/treeseed/credentials', '/var/lib/treeseed/manager', '/var/cache/treeseed', '/run/treeseed', '/usr/lib/treeseed', '/usr/share/treeseed', '/opt/treeseed/kata/test', '/etc/cni/net.d', '/etc/credstore.encrypted']
		: ['/etc/treeai', '/var/lib/treeai', '/opt/treeseed']) mkdirSync(path, { recursive: true });
	if (generation === 'current') {
		writeFileSync('/etc/treeseed/credentials/fixture', 'redacted\n'); writeFileSync('/etc/credstore.encrypted/treeseed-fixture.cred', 'encrypted\n');
		writeFileSync('/etc/cni/net.d/20-treeseed-sandboxes.conflist', '{}\n');
		symlinkSync('/opt/treeseed/kata/test', '/opt/kata'); symlinkSync('/opt/kata/runtime-rs/bin/containerd-shim-kata-v2', '/usr/local/bin/containerd-shim-kata-v2');
	}
	const unit = `/etc/systemd/system/treeseed-${generation}-fixture.service`;
	writeFileSync(unit, '[Unit]\nDescription=TreeSeed uninstall fixture\n[Service]\nType=oneshot\nExecStart=/usr/bin/true\n');
	run('/usr/bin/systemctl', ['daemon-reload']);
}

try {
	for (const generation of ['current', 'legacy'] as const) {
		materialize(generation);
		const before = planHostUninstall();
		if (!before.items.length) throw new Error(`${generation} fixture was not inventoried.`);
		const receipt = executeHostUninstall(true);
		if (receipt.state !== 'completed' || planHostUninstall().items.length) throw new Error(`${generation} fixture left TreeSeed residue.`);
		if (!existsSync(preserved)) throw new Error(`${generation} uninstall removed unmanaged data.`);
	}
} finally {
	rmSync(temporary, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, generations: ['current', 'legacy'], residue: 0, unmanagedPreserved: true }));
