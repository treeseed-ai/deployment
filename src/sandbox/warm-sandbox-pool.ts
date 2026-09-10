import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { SandboxBrokerConfiguration } from './protocol.js';

export interface WarmShape { image: string; cpuCores: number; memoryBytes: number }
interface Idle { key: string; resource: Promise<string> }
export interface WarmOperations {
	create(shape: WarmShape): Promise<string>;
	destroy(id: string): Promise<void>;
	onFailure(error: unknown): void;
}

/** Only credential-free, never-assigned VMs enter this pool. There is intentionally no return/recycle operation. */
export class WarmSandboxPool {
	private idle: Idle[] = [];
	private stopped = false;
	constructor(private readonly operations: WarmOperations, private readonly limit = 1) {
		if (!Number.isSafeInteger(limit) || limit < 0 || limit > 4) throw new Error('Invalid warm sandbox pool limit.');
	}
	private key(shape: WarmShape) { return JSON.stringify([shape.image, shape.cpuCores, shape.memoryBytes]); }
	async acquire(shape: WarmShape) {
		if (this.stopped) throw new Error('Warm sandbox admission is stopped.');
		const index = this.idle.findIndex(entry => entry.key === this.key(shape));
		// Remove before awaiting: concurrent assignments can never share a warmed VM.
		const entry = index < 0 ? undefined : this.idle.splice(index, 1)[0];
		const id = await (entry?.resource ?? this.operations.create(shape));
		if (this.stopped) { await this.operations.destroy(id); throw new Error('Warm sandbox admission stopped during creation.'); }
		this.prewarm(shape);
		return { id, warmed: Boolean(entry) };
	}
	prewarm(shape: WarmShape) {
		if (this.stopped || this.idle.length >= this.limit) return;
		const entry: Idle = { key: this.key(shape), resource: this.operations.create(shape) };
		this.idle.push(entry);
		void entry.resource.catch(error => {
			const index = this.idle.indexOf(entry); if (index >= 0) this.idle.splice(index, 1);
			this.operations.onFailure(error);
		});
	}
	async drain() {
		this.stopped = true;
		const entries = this.idle.splice(0);
		await Promise.all(entries.map(async entry => {
			let id: string;
			try { id = await entry.resource; } catch { return; }
			await this.operations.destroy(id);
		}));
	}
}

const exec = promisify(execFile);
export function kataWarmOperations(configuration: SandboxBrokerConfiguration, onFailure: WarmOperations['onFailure']): WarmOperations {
	const ctr = async (args: string[]) => (await exec('/usr/bin/ctr', ['--address', configuration.containerdAddress,
		'--namespace', configuration.namespace, ...args], { encoding: 'utf8', timeout: 120_000, maxBuffer: 65_536,
			env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } })).stdout;
	const destroy = async (id: string) => {
		if (!/^sandbox-warm-[a-f0-9-]{36}(?:-ready)?$/u.test(id)) throw new Error('Invalid warm sandbox ownership.');
		await ctr(['tasks', 'kill', '--signal', 'SIGKILL', id]).catch(() => undefined);
		await ctr(['tasks', 'delete', '--force', id]).catch(() => undefined);
		await ctr(['containers', 'delete', id]).catch(() => undefined);
		if ((await ctr(['containers', 'list', '--quiet'])).split(/\s+/u).includes(id)) throw new Error('Warm sandbox teardown was not verified.');
	};
	return { destroy, onFailure, create: async shape => {
		const id = `sandbox-warm-${randomUUID()}`;
		try {
			await ctr(['run', '--detach', '--null-io', '--runtime', configuration.runtime, '--cni',
				'--label', 'io.kubernetes.cri.container-type=sandbox', '--cpus', String(shape.cpuCores),
				'--memory-limit', String(shape.memoryBytes), '--cap-drop', 'CAP_NET_RAW', '--cap-drop', 'CAP_NET_ADMIN',
				shape.image, id, '/bin/sleep', 'infinity']);
			// This readiness child receives no source, assignment, token, credential or host mount.
			await ctr(['run', '--rm', '--null-io', '--runtime', configuration.runtime,
				'--label', 'io.kubernetes.cri.container-type=container', '--label', `io.kubernetes.cri.sandbox-id=${id}`,
				'--user', '65532:65532', shape.image, `${id}-ready`, '/bin/true']);
			return id;
		} catch (error) {
			await destroy(`${id}-ready`); await destroy(id); throw error;
		}
	} };
}
