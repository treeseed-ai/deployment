import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { appendFile, chmod, chown, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { sandboxAssignmentSchema, sandboxEventSchema, sandboxResultSchema, type SandboxAssignment, type SandboxEvent, type SandboxResult } from '@treeseed/sdk/capacity-provider';
import type { SandboxBrokerConfiguration } from './protocol.js';
import type { SandboxLeaseRenewal } from '@treeseed/sdk/capacity-provider';
import { containerdImageReference } from './image-reference.js';

interface Prepared {
	sandboxId: string; assignment: SandboxAssignment; directory: string; inputDirectory: string; outputDirectory: string;
	tokenHash: Buffer; uploaded: Set<string>; events: SandboxEvent[]; child?: ChildProcess; result?: SandboxResult;
}
const safeId = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/gu, '-').slice(0, 80);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest();

export class KataSandboxRuntime {
	private readonly sandboxes = new Map<string, Prepared>();
	constructor(private readonly configuration: SandboxBrokerConfiguration) {}
	reconcile() {
		const listed = spawnSync('/usr/bin/ctr', ['--address', this.configuration.containerdAddress, '--namespace', this.configuration.namespace, 'containers', 'list', '--quiet'], { encoding: 'utf8', timeout: 15_000 });
		if (listed.status !== 0) return { reconciled: false, reason: 'containerd_unavailable', quarantined: [] as string[] };
		const quarantined = listed.stdout.split('\n').map((value) => value.trim()).filter(Boolean);
		for (const sandboxId of quarantined) {
			spawnSync('/usr/bin/ctr', ['--address', this.configuration.containerdAddress, '--namespace', this.configuration.namespace, 'tasks', 'kill', '--signal', 'SIGKILL', sandboxId], { timeout: 10_000 });
			spawnSync('/usr/bin/ctr', ['--address', this.configuration.containerdAddress, '--namespace', this.configuration.namespace, 'tasks', 'delete', '--force', sandboxId], { timeout: 10_000 });
			spawnSync('/usr/bin/ctr', ['--address', this.configuration.containerdAddress, '--namespace', this.configuration.namespace, 'containers', 'delete', sandboxId], { timeout: 10_000 });
		}
		if (quarantined.length) { const audit = resolve(this.configuration.stateRoot, 'audit'); mkdirSync(audit, { recursive: true, mode: 0o700 }); writeFileSync(resolve(audit, `broker-reconcile-${Date.now()}.json`), `${JSON.stringify({ occurredAt: new Date().toISOString(), quarantined, action: 'destroyed-untrusted-restart-state' })}\n`, { mode: 0o600 }); }
		return { reconciled: true, quarantined };
	}
	private async emit(sandbox: Prepared, type: SandboxEvent['type'], payload: Record<string, unknown> = {}) {
		const event = sandboxEventSchema.parse({ schemaVersion: 'treeseed.sandbox-event/v1', sandboxId: sandbox.sandboxId, assignmentId: sandbox.assignment.assignmentId,
			sequence: sandbox.events.length, occurredAt: new Date().toISOString(), type, payload });
		sandbox.events.push(event); const audit = resolve(this.configuration.stateRoot, 'audit'); await mkdir(audit, { recursive: true, mode: 0o700 });
		await appendFile(resolve(audit, `${sandbox.sandboxId}.jsonl`), `${JSON.stringify(event)}\n`, { mode: 0o600 }); return event;
	}

	async prepare(assignmentValue: unknown) {
		const assignment = sandboxAssignmentSchema.parse(assignmentValue);
		const modelGateway = this.configuration.modelGateway;
		if (Date.parse(assignment.leaseExpiresAt) <= Date.now()) throw new Error('Expired assignment authority cannot create a sandbox.');
		if (assignment.network.relayUrl !== this.configuration.relay.publicUrl) throw new Error('Sandbox assignment relay URL is not authorized by this host.');
		const requiresModelCredential = assignment.network.allowedServices.some((service) => service === 'model-gateway' || service === 'codex-subscription');
		if (requiresModelCredential && !modelGateway) throw new Error('The selected execution adapter has no configured credential on this capacity provider.');
		if (modelGateway?.authenticationMode === 'codex-subscription' && !assignment.network.allowedServices.includes('codex-subscription')) throw new Error('Assignment does not authorize subscription authentication.');
		if (!this.configuration.guestImages.some((entry) => entry.image === assignment.guestImage && entry.digest === assignment.guestImageDigest && entry.profiles.includes(assignment.profile))) throw new Error('Sandbox guest image is not authorized by the installed release catalog.');
		const sandboxId = `sandbox-${safeId(assignment.assignmentId)}-${assignment.attempt}-${randomUUID().slice(0, 8)}`;
		const directory = resolve(this.configuration.stateRoot, sandboxId), inputDirectory = resolve(directory, 'input'), outputDirectory = resolve(directory, 'output');
		if (!directory.startsWith(`${this.configuration.stateRoot}/`)) throw new Error('Resolved sandbox state path escaped its root.');
		await mkdir(inputDirectory, { recursive: true, mode: 0o700 }); await mkdir(outputDirectory, { mode: 0o700 }); await chown(inputDirectory, 65_532, 65_532); await chown(outputDirectory, 65_532, 65_532);
		await writeFile(resolve(inputDirectory, 'assignment.json'), `${JSON.stringify(assignment)}\n`, { mode: 0o400, flag: 'wx' });
		const token = randomBytes(32).toString('base64url');
		await writeFile(resolve(inputDirectory, 'operation-token'), token, { mode: 0o400, flag: 'wx' });
		await writeFile(resolve(inputDirectory, 'sandbox-id'), `${sandboxId}\n`, { mode: 0o400, flag: 'wx' });
		const brokerFiles = ['assignment.json', 'operation-token', 'sandbox-id'];
		if (modelGateway?.authenticationMode === 'codex-subscription') {
			const authentication = await readFile(modelGateway.credentialFile);
			if (authentication.byteLength > 1_048_576) throw new Error('Codex subscription authentication exceeds the broker limit.');
			await writeFile(resolve(inputDirectory, 'codex-auth.json'), authentication, { mode: 0o400, flag: 'wx' }); brokerFiles.push('codex-auth.json');
		}
		for (const name of brokerFiles) await chown(resolve(inputDirectory, name), 65_532, 65_532);
		const sandbox: Prepared = { sandboxId, assignment, directory, inputDirectory, outputDirectory, tokenHash: hash(token), uploaded: new Set(), events: [] };
		this.sandboxes.set(sandboxId, sandbox); await this.emit(sandbox, 'sandbox.created', { profile: assignment.profile, guestImageDigest: assignment.guestImageDigest });
		await this.emit(sandbox, 'sandbox.ready', { requiredInputCount: assignment.inputs.length, modelAuthentication: modelGateway?.authenticationMode ?? null });
		return { sandboxId, operationToken: token, requiredInputs: assignment.inputs.map(({ id, bytes, digest }) => ({ id, bytes, digest })) };
	}

	private authorized(sandboxId: string, token: string) {
		const sandbox = this.sandboxes.get(sandboxId); if (!sandbox) throw new Error('Sandbox does not exist.');
		const actual = hash(token); if (!token || actual.length !== sandbox.tokenHash.length || !timingSafeEqual(actual, sandbox.tokenHash)) throw new Error('Sandbox operation token is invalid.');
		return sandbox;
	}

	async upload(sandboxId: string, inputId: string, token: string, request: IncomingMessage) {
		const sandbox = this.authorized(sandboxId, token), descriptor = sandbox.assignment.inputs.find((entry) => entry.id === inputId);
		if (!descriptor || sandbox.uploaded.has(inputId)) throw new Error('Sandbox input is unknown or already uploaded.');
		const target = resolve(sandbox.inputDirectory, `input-${safeId(inputId)}`), stream = createWriteStream(target, { mode: 0o400, flags: 'wx' });
		const digest = createHash('sha256'); let bytes = 0;
		try {
			for await (const chunk of request) { const value = Buffer.from(chunk as Buffer); bytes += value.byteLength; if (bytes > descriptor.bytes) throw new Error('Sandbox input exceeds its declared size.'); digest.update(value); if (!stream.write(value)) await new Promise<void>((accept) => stream.once('drain', () => accept())); }
			await new Promise<void>((accept, reject) => { stream.end(accept); stream.once('error', reject); });
			if (bytes !== descriptor.bytes || `sha256:${digest.digest('hex')}` !== descriptor.digest) throw new Error('Sandbox input digest verification failed.');
			await chmod(target, 0o400); await chown(target, 65_532, 65_532); sandbox.uploaded.add(inputId); await this.emit(sandbox, 'execution.progress', { stage: 'input.verified', inputId, bytes }); return { sandboxId, inputId, bytes, verified: true };
		} catch (error) { stream.destroy(); await rm(target, { force: true }); throw error; }
	}

	async execute(sandboxId: string, token: string, execution: Record<string, unknown>): Promise<SandboxResult> {
		const sandbox = this.authorized(sandboxId, token);
		if (Date.parse(sandbox.assignment.leaseExpiresAt) <= Date.now()) throw new Error('Assignment lease expired before sandbox execution.');
		if (sandbox.assignment.inputs.some((entry) => !sandbox.uploaded.has(entry.id))) throw new Error('Sandbox execution cannot start before every signed input is verified.');
		await this.emit(sandbox, 'execution.started', { profile: sandbox.assignment.profile, model: sandbox.assignment.modelPolicy.model });
		await writeFile(resolve(sandbox.inputDirectory, 'execution.json'), `${JSON.stringify(execution)}\n`, { mode: 0o400, flag: 'wx' }); await chown(resolve(sandbox.inputDirectory, 'execution.json'), 65_532, 65_532);
		const image = containerdImageReference(sandbox.assignment.guestImage, sandbox.assignment.guestImageDigest);
		const args = ['--address', this.configuration.containerdAddress, '--namespace', this.configuration.namespace, 'run', '--rm', '--runtime', this.configuration.runtime, '--cni', '--cap-drop', 'CAP_NET_RAW', '--cap-drop', 'CAP_NET_ADMIN',
			'--cpus', String(sandbox.assignment.resources.cpuCores), '--memory-limit', String(sandbox.assignment.resources.memoryBytes),
			'--env', `TREESEED_SANDBOX_PROCESS_LIMIT=${sandbox.assignment.resources.processLimit}`, '--env', `TREESEED_SANDBOX_DISK_LIMIT=${sandbox.assignment.resources.diskBytes}`,
			'--env', `TREESEED_SANDBOX_OUTPUT_LIMIT=${sandbox.assignment.resources.outputBytes}`,
			'--mount', `type=tmpfs,dst=/workspace,options=size=${sandbox.assignment.resources.diskBytes}:mode=0770:uid=65532:gid=65532`,
			'--mount', `type=bind,src=${sandbox.inputDirectory},dst=/run/treeseed-assignment,options=rbind:ro`,
			'--mount', `type=bind,src=${sandbox.outputDirectory},dst=/run/treeseed-output,options=rbind:rw`, image, sandboxId];
		const child = spawn('/usr/bin/ctr', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } }); sandbox.child = child;
		let stderr = '', outputBytes = 0; const account = (chunk: Buffer) => { outputBytes += chunk.byteLength; if (outputBytes > sandbox.assignment.resources.outputBytes) child.kill('SIGKILL'); };
		child.stderr?.on('data', (chunk: Buffer) => { account(chunk); if (stderr.length < 16_384) stderr += chunk.toString('utf8'); }); child.stdout?.on('data', account);
		const executionDeadline = Date.now() + sandbox.assignment.resources.durationSeconds * 1_000; let timeout: ReturnType<typeof setTimeout>;
		const enforceDeadline = () => { const remaining = Math.min(executionDeadline, Date.parse(sandbox.assignment.leaseExpiresAt)) - Date.now(); timeout = setTimeout(() => remaining <= 1 ? child.kill('SIGKILL') : enforceDeadline(), Math.max(1, remaining)); }; enforceDeadline();
		const exitCode = await new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('exit', accept); }); clearTimeout(timeout!); delete sandbox.child;
		if (exitCode !== 0) { await this.emit(sandbox, 'execution.failed', { exitCode, stderrDigest: `sha256:${createHash('sha256').update(stderr).digest('hex')}` }); throw new Error(`Kata guest exited ${exitCode}: ${stderr.slice(0, 1_024)}`); }
		const resultPath = resolve(sandbox.outputDirectory, 'result.json'), resultDescriptor = sandbox.assignment.outputs.find((output) => output.id === 'result');
		const resultBytes = (await stat(resultPath)).size; if (!resultDescriptor || resultDescriptor.path !== '/run/treeseed-output/result.json' || resultBytes > resultDescriptor.maxBytes) throw new Error('Sandbox result exceeded its authorized output contract.');
		const resultContent = await readFile(resultPath, 'utf8');
		if (this.configuration.modelGateway?.authenticationMode === 'codex-subscription') {
			const authentication = JSON.parse(await readFile(this.configuration.modelGateway.credentialFile, 'utf8')) as Record<string, unknown>;
			const tokens = authentication.tokens && typeof authentication.tokens === 'object' ? authentication.tokens as Record<string, unknown> : {};
			const fingerprints = Object.values(tokens).filter((value): value is string => typeof value === 'string' && value.length >= 16);
			if (fingerprints.some((fingerprint) => resultContent.includes(fingerprint))) throw new Error('Sandbox output contained a Codex credential fingerprint and was quarantined.');
		}
		const result = sandboxResultSchema.parse(JSON.parse(resultContent));
		if (result.sandboxId !== sandboxId || result.assignmentId !== sandbox.assignment.assignmentId) throw new Error('Sandbox result correlation mismatch.');
		const hostKernel = await readFile('/proc/version', 'utf8'); if (result.diagnostics.guestKernel === hostKernel.trim()) throw new Error('Sandbox guest did not attest a kernel boundary distinct from the host.');
		if (result.diagnostics.guestUid !== 65_532) throw new Error('Sandbox guest did not execute as its unprivileged assignment identity.');
		for (const artifact of result.artifacts) {
			const descriptor = sandbox.assignment.outputs.find((output) => output.id === artifact.id);
			if (!descriptor || descriptor.path !== artifact.path || descriptor.mediaType !== artifact.mediaType || artifact.bytes > descriptor.maxBytes) throw new Error(`Sandbox returned unauthorized artifact ${artifact.id}.`);
			const target = resolve(sandbox.outputDirectory, artifact.path.slice('/run/treeseed-output/'.length));
			if (!target.startsWith(`${sandbox.outputDirectory}/`)) throw new Error('Sandbox artifact escaped its output directory.');
			const value = await readFile(target); if (value.byteLength !== artifact.bytes || `sha256:${createHash('sha256').update(value).digest('hex')}` !== artifact.digest) throw new Error(`Sandbox artifact ${artifact.id} failed broker verification.`);
		}
		if (resultBytes + result.artifacts.reduce((total, artifact) => total + artifact.bytes, 0) > sandbox.assignment.resources.outputBytes) throw new Error('Sandbox output exceeded its aggregate assignment limit.');
		await this.emit(sandbox, 'execution.completed', { status: result.status, artifactCount: result.artifacts.length });
		const correlated = sandboxResultSchema.parse({ ...result, diagnostics: { ...result.diagnostics, brokerEvents: sandbox.events } }); sandbox.result = correlated; return correlated;
	}

	inspect(sandboxId: string, token: string) { const sandbox = this.authorized(sandboxId, token); return { sandboxId, assignmentId: sandbox.assignment.assignmentId, uploadedInputs: [...sandbox.uploaded], running: Boolean(sandbox.child), events: sandbox.events, result: sandbox.result ?? null }; }
	modelPolicy(sandboxId: string, token: string) { const sandbox = this.authorized(sandboxId, token); if (Date.parse(sandbox.assignment.leaseExpiresAt) <= Date.now()) throw new Error('Assignment model authority expired.'); return sandbox.assignment.modelPolicy; }
	renewLease(sandboxId: string, token: string, renewal: SandboxLeaseRenewal) {
		const sandbox = this.authorized(sandboxId, token), next = Date.parse(renewal.leaseExpiresAt), issued = Date.parse(renewal.issuedAt);
		if (renewal.sandboxId !== sandboxId || renewal.assignmentId !== sandbox.assignment.assignmentId || renewal.providerId !== sandbox.assignment.providerId || renewal.teamId !== sandbox.assignment.teamId) throw new Error('Sandbox lease renewal correlation mismatch.');
		if (Math.abs(Date.now() - issued) > 60_000 || next <= Date.now() || next > Date.now() + 3_600_000 || next <= Date.parse(sandbox.assignment.leaseExpiresAt)) throw new Error('Sandbox lease renewal time window is invalid.');
		sandbox.assignment.leaseExpiresAt = renewal.leaseExpiresAt; return { sandboxId, leaseExpiresAt: renewal.leaseExpiresAt };
	}
	collect(sandboxId: string, token: string) { const sandbox = this.authorized(sandboxId, token); if (!sandbox.result) throw new Error('Sandbox outputs are not ready.'); return sandbox.result; }
	collectArtifact(sandboxId: string, artifactId: string, token: string) {
		const sandbox = this.authorized(sandboxId, token), artifact = sandbox.result?.artifacts.find((entry) => entry.id === artifactId);
		if (!artifact) throw new Error('Sandbox artifact is unavailable.');
		const target = resolve(sandbox.outputDirectory, artifact.path.slice('/run/treeseed-output/'.length));
		return { artifact, stream: createReadStream(target) };
	}
	async cancel(sandboxId: string, token: string) { const sandbox = this.authorized(sandboxId, token); sandbox.child?.kill('SIGTERM'); spawnSync('/usr/bin/ctr', ['--address', this.configuration.containerdAddress, '--namespace', this.configuration.namespace, 'tasks', 'kill', '--signal', 'SIGTERM', sandboxId], { timeout: 10_000 }); await this.emit(sandbox, 'execution.failed', { reason: 'cancelled' }); return { sandboxId, cancellationRequested: true }; }
	async destroy(sandboxId: string, token: string) { const sandbox = this.authorized(sandboxId, token); sandbox.child?.kill('SIGKILL'); spawnSync('/usr/bin/ctr', ['--address', this.configuration.containerdAddress, '--namespace', this.configuration.namespace, 'containers', 'delete', sandboxId], { timeout: 10_000 }); await this.emit(sandbox, 'sandbox.destroyed', { verified: true }); await rm(sandbox.directory, { recursive: true, force: true }); this.sandboxes.delete(sandboxId); return { sandboxId, destroyed: true, teardown: { verified: true, completedAt: new Date().toISOString() }, events: sandbox.events }; }
}
