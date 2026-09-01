import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeHostUninstall, planHostUninstall, scheduleHostUninstall, supervisorOperationSchema, type UninstallCommand } from '../src/index.js';

const roots: string[] = [];
const root = () => { const value = mkdtempSync(resolve(tmpdir(), 'treeseed-uninstall-')); roots.push(value); return value; };
afterEach(() => roots.splice(0).forEach((value) => rmSync(value, { recursive: true, force: true })));
const materialize = (base: string, path: string) => { const target = resolve(base, path.slice(1)); mkdirSync(target, { recursive: true }); return target; };

describe('host uninstall', () => {
	it('inventories only TreeSeed-owned paths, packages, units, and labelled resources', () => {
		const base = root();
		materialize(base, '/etc/treeseed'); materialize(base, '/var/lib/treeseed'); materialize(base, '/srv/unrelated');
		const units = materialize(base, '/etc/systemd/system');
		writeFileSync(resolve(units, 'treeseed-manager.service'), 'managed'); writeFileSync(resolve(units, 'docker.service'), 'unrelated');
		const command: UninstallCommand = (executable, arguments_) => {
			if (executable.endsWith('dpkg-query')) return 'treeseed-manager\ntreeseed-cli\n';
			if (executable.endsWith('docker') && arguments_[0] === 'ps') return 'managed-container\n';
			return '';
		};
		const plan = planHostUninstall({ root: base, command });
		expect(plan.items).toEqual(expect.arrayContaining([
			{ kind: 'package', id: 'treeseed-manager', security: false },
			{ kind: 'unit', id: 'treeseed-manager.service', security: false },
			{ kind: 'container', id: 'managed-container', security: false },
		]));
		expect(plan.items.some((item) => item.id.includes('unrelated') || item.id === 'docker.service')).toBe(false);
	});

	it('preserves security state without purge and removes it only when explicitly selected', () => {
		const base = root(), security = materialize(base, '/var/lib/treeseed'), runtime = materialize(base, '/run/treeseed');
		writeFileSync(resolve(security, 'secret'), 'redacted'); writeFileSync(resolve(runtime, 'socket'), 'runtime');
		const calls: string[] = [], command: UninstallCommand = (executable, arguments_) => { calls.push(`${executable} ${arguments_.join(' ')}`); return ''; };
		const retained = executeHostUninstall(false, { root: base, command });
		expect(existsSync(security)).toBe(true); expect(existsSync(runtime)).toBe(false); expect(retained.purgedSecurity).toBe(false);
		executeHostUninstall(true, { root: base, command });
		expect(existsSync(security)).toBe(false);
	});

	it('inventories only exact TreeSeed Compose project containers before managed networks', () => {
		const base = root(), calls: string[] = [];
		const managed = 'a'.repeat(64), unrelated = 'b'.repeat(64), network = 'c'.repeat(12);
		const command: UninstallCommand = (executable, arguments_) => {
			calls.push(`${executable} ${arguments_.join(' ')}`);
			if (executable.endsWith('docker') && arguments_.join(' ') === 'ps --all --quiet --filter label=com.docker.compose.project') return `${managed}\n${unrelated}\n`;
			if (executable.endsWith('docker') && arguments_[0] === 'inspect') return arguments_.at(-1) === managed ? 'treeseed-api\n' : 'customer-api\n';
			if (executable.endsWith('docker') && arguments_.join(' ') === 'network ls --quiet --filter label=org.treeseed.manager=true') return `${network}\n`;
			return '';
		};
		const plan = planHostUninstall({ root: base, command });
		expect(plan.items).toContainEqual({ kind: 'container', id: managed, security: false });
		expect(plan.items).not.toContainEqual({ kind: 'container', id: unrelated, security: false });
		executeHostUninstall(true, { root: base, command });
		const containerRemoval = calls.indexOf(`/usr/bin/docker rm --force ${managed}`);
		const networkRemoval = calls.indexOf(`/usr/bin/docker network rm ${network}`);
		expect(containerRemoval).toBeGreaterThan(-1);
		expect(networkRemoval).toBeGreaterThan(containerRemoval);
	});

	it('requires an explicit confirmed protocol operation for security purge', () => {
		expect(() => supervisorOperationSchema.parse({ operation: 'platform.uninstall.execute', purgeSecurity: true })).toThrow();
		expect(supervisorOperationSchema.parse({ operation: 'platform.uninstall.execute', purgeSecurity: true, confirm: true })).toMatchObject({ purgeSecurity: true });
	});

	it('removes only exact TreeSeed Kata links and the isolated containerd namespace', () => {
		const base = root(), bin = materialize(base, '/usr/local/bin'), opt = materialize(base, '/opt');
		symlinkSync('/opt/kata/runtime-rs/bin/containerd-shim-kata-v2', resolve(bin, 'containerd-shim-kata-v2'));
		symlinkSync('/srv/unrelated-kata', resolve(opt, 'unrelated-kata'));
		const command: UninstallCommand = (executable, arguments_) => executable.endsWith('ctr') && arguments_.join(' ') === 'namespaces list --quiet' ? 'treeseed-sandboxes\nother\n' : '';
		const plan = planHostUninstall({ root: base, command });
		expect(plan.items).toContainEqual({ kind: 'path', id: '/usr/local/bin/containerd-shim-kata-v2', security: false });
		expect(plan.items).toContainEqual({ kind: 'containerd-namespace', id: 'treeseed-sandboxes', security: false });
		expect(plan.items.some((item) => item.id.includes('unrelated-kata'))).toBe(false);
	});

	it('empties the TreeSeed containerd namespace without the invalid namespace-cgroup option', () => {
		const base = root(), calls: string[] = [];
		const command: UninstallCommand = (executable, arguments_) => {
			const invocation = `${executable} ${arguments_.join(' ')}`; calls.push(invocation);
			if (invocation.endsWith('ctr namespaces list --quiet')) return 'treeseed-sandboxes\nother\n';
			if (invocation.endsWith('ctr --namespace treeseed-sandboxes tasks list --quiet')) return 'task-1\n';
			if (invocation.endsWith('ctr --namespace treeseed-sandboxes containers list --quiet')) return 'container-1\n';
			if (invocation.endsWith('ctr --namespace treeseed-sandboxes images list --quiet')) return 'image-1\n';
			return '';
		};
		executeHostUninstall(true, { root: base, command });
		const namespaceRemoval = calls.indexOf('/usr/bin/ctr namespaces remove treeseed-sandboxes');
		expect(namespaceRemoval).toBeGreaterThan(calls.indexOf('/usr/bin/ctr --namespace treeseed-sandboxes tasks delete --force task-1'));
		expect(namespaceRemoval).toBeGreaterThan(calls.indexOf('/usr/bin/ctr --namespace treeseed-sandboxes containers delete container-1'));
		expect(namespaceRemoval).toBeGreaterThan(calls.indexOf('/usr/bin/ctr --namespace treeseed-sandboxes images remove image-1'));
		expect(calls).not.toContain('/usr/bin/ctr namespaces remove --cgroup treeseed-sandboxes');
		expect(calls.at(namespaceRemoval + 1)).toBe('/usr/bin/rmdir /sys/fs/cgroup/treeseed-sandboxes');
	});

	it('inventories unit drop-ins as paths rather than systemd units', () => {
		const base = root(), units = materialize(base, '/etc/systemd/system');
		materialize(base, '/etc/systemd/system/treeseed-manager-api.service.d');
		writeFileSync(resolve(units, 'treeseed-manager-api.service'), 'managed');
		const plan = planHostUninstall({ root: base, command: () => '' });
		expect(plan.items).toContainEqual({ kind: 'unit', id: 'treeseed-manager-api.service', security: false });
		expect(plan.items).toContainEqual({ kind: 'path', id: '/etc/systemd/system/treeseed-manager-api.service.d', security: false });
		expect(plan.items).not.toContainEqual(expect.objectContaining({ kind: 'unit', id: 'treeseed-manager-api.service.d' }));
	});

	it('completes when user deletion already removed a planned private group', () => {
		const base = root(), calls: string[] = [];
		const command: UninstallCommand = (executable, arguments_) => {
			const invocation = `${executable} ${arguments_.join(' ')}`; calls.push(invocation);
			if (invocation === '/usr/bin/getent passwd') return 'treeseed-private:x:900:900::/nonexistent:/usr/sbin/nologin\n';
			if (invocation === '/usr/bin/getent group') return 'treeseed-private:x:900:\n';
			if (invocation === '/usr/sbin/groupdel treeseed-private') throw new Error('group does not exist');
			return '';
		};
		const receipt = executeHostUninstall(true, { root: base, command });
		expect(receipt.state).toBe('completed');
		expect(calls).toContain('/usr/sbin/userdel treeseed-private');
		expect(calls).toContain('/usr/sbin/groupdel treeseed-private');
	});

	it('schedules finalization in a separate transient service and returns only redacted custody', () => {
		const calls: Array<{ executable: string; arguments_: readonly string[] }> = [];
		const accepted = scheduleHostUninstall(true, (executable, arguments_) => { calls.push({ executable, arguments_ }); return ''; });
		expect(accepted).toMatchObject({ schemaVersion: 'treeseed.host-uninstall-accepted/v1', state: 'accepted' });
		expect(accepted.receiptPath).toBe(`/var/tmp/${accepted.operationId}.json`);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.executable).toBe('/usr/bin/systemd-run');
		expect(calls[0]!.arguments_).toContain('--purge-security=true');
		expect(JSON.stringify(accepted)).not.toMatch(/credential|passphrase|token/iu);
	});
});
