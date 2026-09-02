import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import type { HostedInfrastructureWorkspace } from './workspace.js';
import { hostedInfrastructureToolchain } from './toolchain.js';
import { hostedInfrastructureAuthorityBindingDigest, hostedInfrastructureAuthorityEnvironment, type HostedInfrastructureVaultAuthority } from './authority.js';

export interface OpenTofuCommandResult { code: number; stdout: string; stderr: string }
export type OpenTofuCommand = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<OpenTofuCommandResult>;
export interface HostedInfrastructureExecutionPlan {
	changed: boolean;
	executionPlanDigest: string;
	authorityBindingDigest: string;
	bundleDigest: string;
	planDigest: string;
}

export function runOpenTofuCommand(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<OpenTofuCommandResult> {
	return new Promise((done, reject) => {
		const child = spawn('tofu', args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
		let stdout = '', stderr = '';
		child.stdout.setEncoding('utf8').on('data', (value) => { stdout += value; });
		child.stderr.setEncoding('utf8').on('data', (value) => { stderr += value; });
		child.once('error', reject); child.once('close', (code) => done({ code: code ?? 1, stdout, stderr }));
	});
}

function safeTarget(root: string, relative: string) {
	const absoluteRoot = resolve(root), target = resolve(absoluteRoot, relative);
	if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${sep}`)) throw new Error(`Hosted infrastructure workspace path escapes its root: ${relative}.`);
	return target;
}

async function verifiedArtifacts(workspace: HostedInfrastructureWorkspace, root: string, fetchImpl: typeof fetch) {
	for (const artifact of workspace.artifacts) {
		const response = await fetchImpl(artifact.source); if (!response.ok) throw new Error(`Hosted infrastructure artifact ${artifact.id} download failed (HTTP ${response.status}).`);
		const data = Buffer.from(await response.arrayBuffer()), digest = `sha256:${createHash('sha256').update(data).digest('hex')}`;
		if (digest !== artifact.digest) throw new Error(`Hosted infrastructure artifact ${artifact.id} failed digest verification.`);
		const target = safeTarget(root, artifact.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, data, { mode: 0o600 });
	}
}

function sanitizedFailure(result: OpenTofuCommandResult, operation: string, env: NodeJS.ProcessEnv = {}) {
	let output = `${result.stderr}\n${result.stdout}`.replace(/[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]*\s*[=:]\s*\S+/giu, '[redacted]');
	for (const [key, value] of Object.entries(env)) if (value && /(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)/iu.test(key)) output = output.replaceAll(value, '[redacted]');
	const detail = output.trim().slice(0, 2_000);
	return new Error(`OpenTofu ${operation} failed with exit ${result.code}${detail ? `: ${detail}` : '.'}`);
}

export class HostedInfrastructureExecutor {
	constructor(private readonly command: OpenTofuCommand = runOpenTofuCommand, private readonly fetchImpl: typeof fetch = fetch) {}

	async prepare(workspace: HostedInfrastructureWorkspace, root: string) {
		await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
		for (const [relative, content] of Object.entries(workspace.files)) {
			const target = safeTarget(root, relative); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content, { mode: 0o600 });
		}
		await verifiedArtifacts(workspace, root, this.fetchImpl);
		const manifest = { schemaVersion: workspace.schemaVersion, planDigest: workspace.planDigest, bundleDigest: workspace.bundleDigest, environment: workspace.environment, toolchain: workspace.toolchain, imports: workspace.imports, authorities: workspace.authorities };
		await writeFile(safeTarget(root, 'treeseed-workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
	}

	async verifyVersion(root: string, env: NodeJS.ProcessEnv) {
		const result = await this.command(['version', '-json'], { cwd: root, env }); if (result.code !== 0) throw sanitizedFailure(result, 'version inspection', env);
		const parsed = JSON.parse(result.stdout) as { terraform_version?: string };
		if (parsed.terraform_version !== hostedInfrastructureToolchain.opentofu.version) throw new Error(`OpenTofu ${hostedInfrastructureToolchain.opentofu.version} is required; received ${String(parsed.terraform_version)}.`);
	}

	async plan(workspace: HostedInfrastructureWorkspace, root: string, authority: HostedInfrastructureVaultAuthority) {
		const authorityEnvironment = hostedInfrastructureAuthorityEnvironment(workspace, authority, root);
		if (workspace.imports.length && !workspace.executable) throw new Error('Hosted infrastructure imports require an SDK-authorized executable plan.');
		await mkdir(resolve(root, '.home'), { recursive: true }); await this.prepare(workspace, root); await this.verifyVersion(root, authorityEnvironment);
		for (const [args, operation] of [
			[['init', '-input=false', '-lockfile=readonly'], 'initialization'],
			[['validate', '-json'], 'validation'],
		] as const) { const result = await this.command([...args], { cwd: root, env: authorityEnvironment }); if (result.code !== 0) throw sanitizedFailure(result, operation, authorityEnvironment); }
		for (const item of workspace.imports) {
			const result = await this.command(['import', '-input=false', item.address, item.id], { cwd: root, env: authorityEnvironment });
			if (result.code !== 0 && !/already managed/iu.test(`${result.stdout}\n${result.stderr}`)) throw sanitizedFailure(result, `import of ${item.address}`, authorityEnvironment);
		}
		const result = await this.command(['plan', '-input=false', '-detailed-exitcode', '-out=treeseed.plan'], { cwd: root, env: authorityEnvironment });
		if (result.code !== 0 && result.code !== 2) throw sanitizedFailure(result, 'plan', authorityEnvironment);
		const data = await readFile(safeTarget(root, 'treeseed.plan'));
		return { changed: result.code === 2, executionPlanDigest: `sha256:${createHash('sha256').update(data).digest('hex')}`, authorityBindingDigest: hostedInfrastructureAuthorityBindingDigest(authority), bundleDigest: workspace.bundleDigest, planDigest: workspace.planDigest };
	}

	async apply(workspace: HostedInfrastructureWorkspace, root: string, authority: HostedInfrastructureVaultAuthority, execution: HostedInfrastructureExecutionPlan) {
		if (!workspace.executable) throw new Error('Hosted infrastructure apply requires an SDK-authorized executable plan.');
		const authorityEnvironment = hostedInfrastructureAuthorityEnvironment(workspace, authority, root);
		if (execution.bundleDigest !== workspace.bundleDigest || execution.planDigest !== workspace.planDigest) throw new Error('Hosted infrastructure execution plan does not match its workspace closure.');
		if (hostedInfrastructureAuthorityBindingDigest(authority) !== execution.authorityBindingDigest) throw new Error('Hosted infrastructure vault authority changed after planning.');
		const data = await readFile(safeTarget(root, 'treeseed.plan')), actual = `sha256:${createHash('sha256').update(data).digest('hex')}`;
		if (actual !== execution.executionPlanDigest) throw new Error('OpenTofu execution plan no longer matches its approved digest.');
		try {
			const result = await this.command(['apply', '-input=false', '-auto-approve', 'treeseed.plan'], { cwd: root, env: authorityEnvironment });
			if (result.code !== 0) throw sanitizedFailure(result, 'apply', authorityEnvironment);
			return { applied: true, executionPlanDigest: execution.executionPlanDigest, authorityBindingDigest: execution.authorityBindingDigest, bundleDigest: workspace.bundleDigest, planDigest: workspace.planDigest };
		} finally { await rm(safeTarget(root, 'treeseed.plan'), { force: true }); }
	}

	async discard(root: string) { await rm(safeTarget(root, 'treeseed.plan'), { force: true }); }
}
