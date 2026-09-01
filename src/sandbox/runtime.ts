import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { appendFile, chmod, chown, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { sandboxAssignmentSchema, sandboxEventSchema, sandboxResultSchema, type SandboxAssignment, type SandboxEvent, type SandboxResult } from '@treeseed/sdk/capacity-provider/sandbox';
import type { SandboxBrokerConfiguration } from './protocol.js';
import type { SandboxLeaseRenewal } from '@treeseed/sdk/capacity-provider/sandbox';
import { containerdImageReference } from './image-reference.js';

interface Prepared {
	sandboxId: string; assignment: SandboxAssignment; directory: string; inputDirectory: string; outputDirectory: string;
	tokenHash: Buffer; guestTokenHash: Buffer; uploaded: Set<string>; events: SandboxEvent[]; child?: ChildProcess; result?: SandboxResult;
	toolRequests: Array<{ id:string; tool:string; arguments:Record<string,unknown>; createdAt:string }>;
	toolWaiters: Map<string,{ resolve:(value:unknown)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout> }>;
}
export const safeContainerId = (value: string) => value.replace(/[^a-zA-Z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80) || 'assignment';
export const authorizedGuestImage = (configured: SandboxBrokerConfiguration['guestImages'], assignment: Pick<SandboxAssignment, 'guestImage' | 'guestImageDigest' | 'profile'>) => {
	const requested = containerdImageReference(assignment.guestImage, assignment.guestImageDigest);
	return configured.some((entry) => containerdImageReference(entry.image, entry.digest) === requested && entry.profiles.includes(assignment.profile));
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest();

async function materializeGuestResolver(directory: string) {
	const candidates = ['/run/systemd/resolve/resolv.conf', '/etc/resolv.conf'];
	for (const candidate of candidates) {
		const content = await readFile(candidate, 'utf8').catch(() => '');
		const nameservers = content.split('\n').map((line) => /^nameserver\s+(\S+)/u.exec(line.trim())?.[1] ?? '')
			.filter((address) => isIP(address) !== 0 && address !== '127.0.0.1' && address !== '127.0.0.53' && address !== '::1');
		if (!nameservers.length) continue;
		const target = resolve(directory, 'resolv.conf');
		await writeFile(target, `${[...new Set(nameservers)].map((address) => `nameserver ${address}`).join('\n')}\noptions edns0\n`, { mode: 0o444, flag: 'wx' });
		return target;
	}
	throw new Error('No non-loopback DNS resolver is available for the assignment sandbox.');
}

export class KataSandboxRuntime {
	private readonly sandboxes = new Map<string, Prepared>();
	constructor(private readonly configuration: SandboxBrokerConfiguration) {}
	private ctr(arguments_: string[], timeout = 10_000) {
		return spawnSync('/usr/bin/ctr', ['--address', this.configuration.containerdAddress, '--namespace', this.configuration.namespace, ...arguments_], { encoding: 'utf8', timeout });
	}
	private listed(kind: 'tasks' | 'containers') {
		const result = this.ctr([kind, 'list', '--quiet'], 15_000);
		return result.status === 0 ? new Set(result.stdout.split('\n').map((value) => value.trim()).filter(Boolean)) : null;
	}
	private removeContainer(sandboxId: string) {
		this.ctr(['tasks', 'kill', '--signal', 'SIGKILL', sandboxId]);
		this.ctr(['tasks', 'delete', '--force', sandboxId]);
		this.ctr(['containers', 'delete', sandboxId]);
		const tasks = this.listed('tasks'), containers = this.listed('containers');
		return tasks !== null && containers !== null && !tasks.has(sandboxId) && !containers.has(sandboxId);
	}
	reconcile() {
		const containers = this.listed('containers');
		if (!containers) return { reconciled: false, reason: 'containerd_unavailable', quarantined: [] as string[], remaining: [] as string[] };
		const quarantined = [...containers], remaining = quarantined.filter((sandboxId) => !this.removeContainer(sandboxId));
		if (quarantined.length) { const audit = resolve(this.configuration.stateRoot, 'audit'); mkdirSync(audit, { recursive: true, mode: 0o700 }); writeFileSync(resolve(audit, `broker-reconcile-${Date.now()}.json`), `${JSON.stringify({ occurredAt: new Date().toISOString(), quarantined, remaining, action: remaining.length ? 'quarantined-untrusted-restart-state' : 'destroyed-untrusted-restart-state' })}\n`, { mode: 0o600 }); }
		return { reconciled: remaining.length === 0, quarantined, remaining };
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
		if (!authorizedGuestImage(this.configuration.guestImages, assignment)) throw new Error('Sandbox guest image is not authorized by the installed release catalog.');
		const sandboxId = `sandbox-${safeContainerId(assignment.assignmentId)}-${assignment.attempt}-${randomUUID().slice(0, 8)}`;
		const directory = resolve(this.configuration.stateRoot, sandboxId), inputDirectory = resolve(directory, 'input'), outputDirectory = resolve(directory, 'output');
		if (!directory.startsWith(`${this.configuration.stateRoot}/`)) throw new Error('Resolved sandbox state path escaped its root.');
		await mkdir(inputDirectory, { recursive: true, mode: 0o700 }); await mkdir(outputDirectory, { mode: 0o700 }); await chown(inputDirectory, 65_532, 65_532); await chown(outputDirectory, 65_532, 65_532);
		await writeFile(resolve(inputDirectory, 'assignment.json'), `${JSON.stringify(assignment)}\n`, { mode: 0o400, flag: 'wx' });
		const token = randomBytes(32).toString('base64url'), guestToken = randomBytes(32).toString('base64url');
		await writeFile(resolve(inputDirectory, 'operation-token'), guestToken, { mode: 0o400, flag: 'wx' });
		await writeFile(resolve(inputDirectory, 'sandbox-id'), `${sandboxId}\n`, { mode: 0o400, flag: 'wx' });
		const brokerFiles = ['assignment.json', 'operation-token', 'sandbox-id'];
		if (modelGateway?.authenticationMode === 'codex-subscription') {
			const authentication = await readFile(modelGateway.credentialFile);
			if (authentication.byteLength > 1_048_576) throw new Error('Codex subscription authentication exceeds the broker limit.');
			await writeFile(resolve(inputDirectory, 'codex-auth.json'), authentication, { mode: 0o400, flag: 'wx' }); brokerFiles.push('codex-auth.json');
		}
		for (const name of brokerFiles) await chown(resolve(inputDirectory, name), 65_532, 65_532);
		const sandbox: Prepared = { sandboxId, assignment, directory, inputDirectory, outputDirectory, tokenHash: hash(token), guestTokenHash: hash(guestToken), uploaded: new Set(), events: [], toolRequests: [], toolWaiters: new Map() };
		this.sandboxes.set(sandboxId, sandbox); await this.emit(sandbox, 'sandbox.created', { profile: assignment.profile, guestImageDigest: assignment.guestImageDigest });
		await this.emit(sandbox, 'sandbox.ready', { requiredInputCount: assignment.inputs.length, modelAuthentication: modelGateway?.authenticationMode ?? null });
		return { sandboxId, operationToken: token, requiredInputs: assignment.inputs.map(({ id, bytes, digest }) => ({ id, bytes, digest })) };
	}

	private authorized(sandboxId: string, token: string) {
		const sandbox = this.sandboxes.get(sandboxId); if (!sandbox) throw new Error('Sandbox does not exist.');
		const actual = hash(token); if (!token || actual.length !== sandbox.tokenHash.length || !timingSafeEqual(actual, sandbox.tokenHash)) throw new Error('Sandbox operation token is invalid.');
		return sandbox;
	}
	private authorizedGuest(sandboxId:string,token:string) {
		const sandbox=this.sandboxes.get(sandboxId); if(!sandbox) throw new Error('Sandbox does not exist.');
		const actual=hash(token); if(!token||actual.length!==sandbox.guestTokenHash.length||!timingSafeEqual(actual,sandbox.guestTokenHash)) throw new Error('Sandbox guest relay token is invalid.');
		return sandbox;
	}

	async requestTreeDxTool(sandboxId:string,token:string,value:unknown) {
		const sandbox=this.authorizedGuest(sandboxId,token), request=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
		if(!sandbox.assignment.network.allowedServices.includes('treedx-relay')||sandbox.assignment.treeDxHandleIds.length===0) throw new Error('Assignment does not authorize TreeDX tools.');
		if(Date.parse(sandbox.assignment.leaseExpiresAt)<=Date.now()) throw new Error('Assignment TreeDX authority expired.');
		const tool=String(request.tool??''), arguments_=request.arguments&&typeof request.arguments==='object'&&!Array.isArray(request.arguments)?request.arguments as Record<string,unknown>:{};
		if(!['treedx_build_context','treedx_read_files','treedx_search_files','treedx_list_paths'].includes(tool)) throw new Error('TreeDX tool is not supported.');
		const id=randomUUID(), createdAt=new Date().toISOString(); sandbox.toolRequests.push({id,tool,arguments:arguments_,createdAt}); await this.emit(sandbox,'tool.requested',{requestId:id,tool});
		return new Promise<unknown>((resolve,reject)=>{const remaining=Math.max(1,Math.min(60_000,Date.parse(sandbox.assignment.leaseExpiresAt)-Date.now()));const timer=setTimeout(()=>{sandbox.toolWaiters.delete(id);reject(new Error('TreeDX tool relay timed out.'));},remaining);sandbox.toolWaiters.set(id,{resolve,reject,timer});});
	}
	nextToolRequest(sandboxId:string,token:string) { const sandbox=this.authorized(sandboxId,token); return {request:sandbox.toolRequests.shift()??null}; }
	async completeToolRequest(sandboxId:string,token:string,requestId:string,value:unknown) {
		const sandbox=this.authorized(sandboxId,token), waiter=sandbox.toolWaiters.get(requestId); if(!waiter) throw new Error('TreeDX tool request is not pending.');
		const result=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}; clearTimeout(waiter.timer); sandbox.toolWaiters.delete(requestId);
		if(result.error) waiter.reject(new Error(String(result.error))); else waiter.resolve(result.result); await this.emit(sandbox,'tool.completed',{requestId,ok:!result.error}); return {completed:true};
	}

	async upload(sandboxId: string, inputId: string, token: string, request: IncomingMessage) {
		const sandbox = this.authorized(sandboxId, token), descriptor = sandbox.assignment.inputs.find((entry) => entry.id === inputId);
		if (!descriptor || sandbox.uploaded.has(inputId)) throw new Error('Sandbox input is unknown or already uploaded.');
		const target = resolve(sandbox.inputDirectory, `input-${safeContainerId(inputId)}`), stream = createWriteStream(target, { mode: 0o400, flags: 'wx' });
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
		const resolverFile = await materializeGuestResolver(sandbox.directory);
		const image = containerdImageReference(sandbox.assignment.guestImage, sandbox.assignment.guestImageDigest);
		const args = ['--address', this.configuration.containerdAddress, '--namespace', this.configuration.namespace, 'run', '--rm', '--null-io', '--runtime', this.configuration.runtime, '--cni', '--cap-drop', 'CAP_NET_RAW', '--cap-drop', 'CAP_NET_ADMIN',
			'--cpus', String(sandbox.assignment.resources.cpuCores), '--memory-limit', String(sandbox.assignment.resources.memoryBytes),
			'--env', `TREESEED_SANDBOX_PROCESS_LIMIT=${sandbox.assignment.resources.processLimit}`, '--env', `TREESEED_SANDBOX_DISK_LIMIT=${sandbox.assignment.resources.diskBytes}`,
			'--env', `TREESEED_SANDBOX_OUTPUT_LIMIT=${sandbox.assignment.resources.outputBytes}`,
			'--mount', `type=tmpfs,src=tmpfs,dst=/workspace,options=size=${sandbox.assignment.resources.diskBytes}:mode=0770:uid=65532:gid=65532`,
			'--mount', `type=bind,src=${resolverFile},dst=/etc/resolv.conf,options=rbind:ro`,
			'--mount', `type=bind,src=${sandbox.inputDirectory},dst=/run/treeseed-assignment,options=rbind:ro`,
			'--mount', `type=bind,src=${sandbox.outputDirectory},dst=/run/treeseed-output,options=rbind:rw`, image, sandboxId];
		const child = spawn('/usr/bin/ctr', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } }); sandbox.child = child;
		let stderr = ''; child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 16_384) stderr += chunk.toString('utf8'); });
		let lastProgress = '';
		const progressTimer = setInterval(() => { void readFile(resolve(sandbox.outputDirectory, 'progress.json'), 'utf8').then((value) => {
			if (value === lastProgress) return; lastProgress = value;
			try { const event = JSON.parse(value) as Record<string, unknown>; process.stderr.write(`${JSON.stringify({ source: 'sandbox-guest', sandboxId, assignmentId: sandbox.assignment.assignmentId, stage: event.stage, occurredAt: event.occurredAt })}\n`); } catch { /* Ignore partial progress writes. */ }
		}).catch(() => undefined); }, 500);
		const executionDeadline = Date.now() + sandbox.assignment.resources.durationSeconds * 1_000; let timeout: ReturnType<typeof setTimeout>;
		const enforceDeadline = () => {
			const remaining = Math.min(executionDeadline, Date.parse(sandbox.assignment.leaseExpiresAt)) - Date.now();
			if (remaining <= 1) { child.kill('SIGKILL'); return; }
			// Re-read the mutable lease when this timer fires. A renewal received while
			// the guest is running must extend the lease boundary without extending the
			// assignment's immutable execution-duration limit.
			timeout = setTimeout(enforceDeadline, remaining);
		}; enforceDeadline();
		const exitCode = await new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('exit', accept); }); clearTimeout(timeout!); clearInterval(progressTimer); delete sandbox.child;
		if (exitCode !== 0) {
			const failureContent = await readFile(resolve(sandbox.outputDirectory, 'failure.json'), 'utf8').catch(() => '');
			const failureDigest = `sha256:${createHash('sha256').update(failureContent).digest('hex')}`;
			const failure = (() => { try { const value = JSON.parse(failureContent) as Record<string, unknown>; return typeof value.error === 'string' ? value.error : ''; } catch { return ''; } })()
				.replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]').replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{16,}\b/gu, '[REDACTED]');
			await this.emit(sandbox, 'execution.failed', { exitCode, failureDigest, stderrDigest: `sha256:${createHash('sha256').update(stderr).digest('hex')}` });
			throw new Error(`Kata guest exited ${exitCode}: ${(failure || stderr).slice(0, 1_024)}`);
		}
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
	modelPolicy(sandboxId: string, token: string) { const sandbox = this.authorizedGuest(sandboxId, token); if (Date.parse(sandbox.assignment.leaseExpiresAt) <= Date.now()) throw new Error('Assignment model authority expired.'); return sandbox.assignment.modelPolicy; }
	authorizeSubscriptionProxy(sandboxId: string, token: string) {
		const sandbox = this.authorizedGuest(sandboxId, token);
		if (Date.parse(sandbox.assignment.leaseExpiresAt) <= Date.now()) throw new Error('Assignment subscription proxy authority expired.');
		if (this.configuration.modelGateway?.authenticationMode !== 'codex-subscription' || !sandbox.assignment.network.allowedServices.includes('codex-subscription')) throw new Error('Assignment does not authorize subscription proxy access.');
		return true;
	}
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
	async cancel(sandboxId: string, token: string) { const sandbox = this.authorized(sandboxId, token); sandbox.child?.kill('SIGTERM'); this.ctr(['tasks', 'kill', '--signal', 'SIGTERM', sandboxId]); await this.emit(sandbox, 'execution.failed', { reason: 'cancelled' }); return { sandboxId, cancellationRequested: true }; }
	async destroy(sandboxId: string, token: string) {
		const sandbox = this.authorized(sandboxId, token); sandbox.child?.kill('SIGKILL'); const verified = this.removeContainer(sandboxId);
		for(const waiter of sandbox.toolWaiters.values()){clearTimeout(waiter.timer);waiter.reject(new Error('Sandbox was destroyed.'));} sandbox.toolWaiters.clear();
		await this.emit(sandbox, 'sandbox.destroyed', { verified });
		if (verified) { await rm(sandbox.directory, { recursive: true, force: true }); this.sandboxes.delete(sandboxId); }
		return { sandboxId, destroyed: verified, teardown: { verified, completedAt: new Date().toISOString() }, events: sandbox.events };
	}
}
