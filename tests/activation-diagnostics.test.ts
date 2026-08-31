import { describe, expect, it } from 'vitest';
import { executeSupervisorOperation } from '../src/supervisor/execute.js';

describe('bounded component activation diagnostics', () => {
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
			if (arguments_[0] === 'inspect' && input === '') return 'runner\trunning\tunhealthy\t0\n';
			return undefined;
		};
		expect(() => executeSupervisorOperation(activation, command, () => undefined))
			.toThrow(/component health:.*"service":"runner".*"manifestVersion":5.*connect EACCES token=<redacted>/u);
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
});
