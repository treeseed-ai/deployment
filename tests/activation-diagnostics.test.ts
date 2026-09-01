import { describe, expect, it } from 'vitest';
import { executeSupervisorOperation } from '../src/supervisor/execute.js';

describe('bounded component activation diagnostics', () => {
	it('continues a bounded wait when every expected service is only starting', () => {
		const activation = { operation: 'compose.activate' as const, componentId: 'treedx', files: ['treedx/release/compose.yml'], projectName: 'treeseed-treedx', waitTimeoutSeconds: 60 };
		let inspections = 0, currentTime = 0;
		const command = (_executable: string, arguments_: readonly string[], input?: string) => {
			if (arguments_[0] === 'network') return undefined;
			if (arguments_[0] === 'compose' && arguments_.includes('up')) throw new Error('premature wait failure');
			if (arguments_[0] === 'compose' && arguments_.includes('config')) return 'treedx\n';
			if (arguments_[0] === 'ps') return 'container-treedx\n';
			if (arguments_[0] === 'inspect' && input === '') return `treedx\trunning\t${inspections++ === 0 ? 'starting' : 'healthy'}\t0\n`;
			return undefined;
		};
		expect(executeSupervisorOperation(activation, command, () => undefined, command, (milliseconds) => { currentTime += milliseconds; }, () => currentTime)).toBeUndefined();
		expect(inspections).toBe(2);
	});

	it.each([
		['missing', '', ''],
		['unhealthy', 'container-treedx\n', 'treedx\trunning\tunhealthy\t0\n'],
	])('fails closed for an %s expected service', (_case, containers, inspection) => {
		const activation = { operation: 'compose.activate' as const, componentId: 'treedx', files: ['treedx/release/compose.yml'], projectName: 'treeseed-treedx', waitTimeoutSeconds: 60 };
		const command = (_executable: string, arguments_: readonly string[], input?: string) => {
			if (arguments_[0] === 'network') return undefined;
			if (arguments_[0] === 'compose' && arguments_.includes('up')) throw new Error('activation failed');
			if (arguments_[0] === 'compose' && arguments_.includes('config')) return 'treedx\n';
			if (arguments_[0] === 'ps') return containers;
			if (arguments_[0] === 'inspect' && input === '') return inspection;
			return undefined;
		};
		expect(() => executeSupervisorOperation(activation, command, () => undefined, command, () => undefined, () => 0)).toThrow('activation failed');
	});

	it('fails closed with the latest diagnostics when starting exceeds the deadline', () => {
		const activation = { operation: 'compose.activate' as const, componentId: 'treedx', files: ['treedx/release/compose.yml'], projectName: 'treeseed-treedx', waitTimeoutSeconds: 2 };
		let currentTime = 0;
		const command = (_executable: string, arguments_: readonly string[], input?: string) => {
			if (arguments_[0] === 'network') return undefined;
			if (arguments_[0] === 'compose' && arguments_.includes('up')) throw new Error('premature wait failure');
			if (arguments_[0] === 'compose' && arguments_.includes('config')) return 'treedx\n';
			if (arguments_[0] === 'ps') return 'container-treedx\n';
			if (arguments_[0] === 'inspect' && input === '') return 'treedx\trunning\tstarting\t0\n';
			return undefined;
		};
		expect(() => executeSupervisorOperation(activation, command, () => undefined, command, (milliseconds) => { currentTime += milliseconds; }, () => currentTime))
			.toThrow(/premature wait failure; component health:.*"health":"starting"/u);
		expect(currentTime).toBe(2_000);
	});

	it('surfaces only structured Agent health fields and redacts reasons', () => {
		const activation = { operation: 'compose.activate' as const, componentId: 'agent', files: ['agent/release/compose.yml'], projectName: 'treeseed-agent', waitTimeoutSeconds: 60 };
		const command = (_executable: string, arguments_: readonly string[], input?: string) => {
			if (arguments_[0] === 'network') return undefined;
			if (arguments_[0] === 'compose') throw new Error('activation failed');
			if (arguments_[0] === 'ps') return 'container-agent\n';
			if (arguments_.includes('{{json .State.Health.Log}}')) return JSON.stringify([{ Output: JSON.stringify({
				status: 'degraded', dataDirWritable: true, manifestVersion: 5,
				broker: { required: true, ready: false, reason: 'connect EACCES token=do-not-emit' },
				disk: { ok: true, reason: null }, ignored: { credential: 'do-not-emit' },
			}) }]);
			if (arguments_[0] === 'inspect' && input === '') {
				expect(arguments_[2]).toContain('index .Config.Labels "com.docker.compose.service"');
				return 'runner\trunning\tstarting\t0\n';
			}
			return undefined;
		};
		expect(() => executeSupervisorOperation(activation, command, () => undefined))
			.toThrow(/component health:.*"service":"runner".*"health":"starting".*"manifestVersion":5.*connect EACCES token=<redacted>/u);
	});

	it('never includes undeclared payload fields or secret-like values', () => {
		const activation = { operation: 'compose.activate' as const, componentId: 'agent', files: ['agent/release/compose.yml'], projectName: 'treeseed-agent', waitTimeoutSeconds: 60 };
		try {
			executeSupervisorOperation(activation, (_executable, arguments_, input) => {
				if (arguments_[0] === 'network') return undefined;
				if (arguments_[0] === 'compose') throw new Error('activation failed');
				if (arguments_[0] === 'ps') return 'container-agent\n';
				if (arguments_.includes('{{json .State.Health.Log}}')) return JSON.stringify([{ Output: JSON.stringify({ status: 'degraded', broker: { required: true, ready: false, reason: 'password=private-value' }, ignored: 'private-value' }) }]);
				if (arguments_[0] === 'inspect' && input === '') return 'runner\trunning\tunhealthy\t0\n';
				return undefined;
			}, () => undefined);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).not.toContain('private-value');
			expect(message).not.toContain('ignored');
		}
	});

	it('probes the structured Agent doctor when Docker has not recorded a health log yet', () => {
		const activation = { operation: 'compose.activate' as const, componentId: 'agent', files: ['agent/release/compose.yml'], projectName: 'treeseed-agent', waitTimeoutSeconds: 60 };
		const command = (_executable: string, arguments_: readonly string[], input?: string) => {
			if (arguments_[0] === 'network') return undefined;
			if (arguments_[0] === 'compose') throw new Error('activation failed');
			if (arguments_[0] === 'ps') return 'container-agent\n';
			if (arguments_.includes('{{json .State.Health.Log}}')) return '[]';
			if (arguments_[0] === 'inspect' && input === '') return 'manager\trunning\tstarting\t0\n';
			if (arguments_[0] === 'exec') {
				expect(arguments_.slice(2)).toEqual(['/app/docker-entrypoint.sh', 'doctor', '--json']);
				return JSON.stringify({ status: 'degraded', dataDirWritable: true, manifestVersion: 5,
					broker: { required: true, ready: false, reason: 'connect EACCES secret=hidden' }, disk: { ok: true, reason: null } });
			}
			return undefined;
		};
		expect(() => executeSupervisorOperation(activation, command, () => undefined))
			.toThrow(/component health:.*"service":"manager".*"manifestVersion":5.*connect EACCES secret=<redacted>/u);
	});

	it('captures only a structured redacted Agent crash record from a restart loop', () => {
		const activation = { operation: 'compose.activate' as const, componentId: 'agent', files: ['agent/release/compose.yml'], projectName: 'treeseed-agent', waitTimeoutSeconds: 60 };
		const command = (_executable: string, arguments_: readonly string[], input?: string) => {
			if (arguments_[0] === 'network') return undefined;
			if (arguments_[0] === 'compose') throw new Error('activation failed');
			if (arguments_[0] === 'ps') return 'container-agent\n';
			if (arguments_.includes('{{json .State.Health.Log}}')) return '[]';
			if (arguments_[0] === 'inspect' && input === '') return 'runner\trestarting\tunhealthy\t1\n';
			if (arguments_[0] === 'exec') throw new Error('container is restarting');
			return undefined;
		};
		const captureCommand = (_executable: string, arguments_: readonly string[]) => {
			expect(arguments_.slice(0, 3)).toEqual(['logs', '--tail', '8']);
			return 'unstructured private-value\n{\n  "ok": false,\n  "error": "manifest password=private-value is invalid",\n  "ignored": "private-value"\n}\n';
		};
		try { executeSupervisorOperation(activation, command, () => undefined, captureCommand); }
		catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain('"code":"agent_startup_failed"');
			expect(message).toContain('manifest password=<redacted> is invalid');
			expect(message).not.toContain('unstructured');
			expect(message).not.toContain('private-value');
			expect(message).not.toContain('ignored');
		}
	});

	it('never emits malformed Agent container output', () => {
		const activation = { operation: 'compose.activate' as const, componentId: 'agent', files: ['agent/release/compose.yml'], projectName: 'treeseed-agent', waitTimeoutSeconds: 60 };
		const command = (_executable: string, arguments_: readonly string[], input?: string) => {
			if (arguments_[0] === 'network') return undefined;
			if (arguments_[0] === 'compose') throw new Error('activation failed');
			if (arguments_[0] === 'ps') return 'container-agent\n';
			if (arguments_.includes('{{json .State.Health.Log}}')) return '[]';
			if (arguments_[0] === 'inspect' && input === '') return 'runner\trestarting\tunhealthy\t1\n';
			if (arguments_[0] === 'exec') throw new Error('container is restarting');
			return undefined;
		};
		try { executeSupervisorOperation(activation, command, () => undefined, () => 'token=private-value malformed output'); }
		catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain('"service":"runner"');
			expect(message).not.toContain('private-value');
		}
	});
});
