import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { x as extractTar } from 'tar';
import type { HostedInfrastructureWorkspace } from './workspace.js';

export interface PagesCommandResult { code: number; stdout: string; stderr: string }
export type PagesCommand = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<PagesCommandResult>;

const require = createRequire(import.meta.url);
const cloudflareApi = 'https://api.cloudflare.com/client/v4';

export function createPagesCommand(): PagesCommand {
	const executable = resolve(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
	return (args, options) => new Promise((done, reject) => {
		const child = spawn(process.execPath, [executable, ...args], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
		let stdout = '', stderr = '';
		child.stdout.setEncoding('utf8').on('data', (value) => { stdout += value; });
		child.stderr.setEncoding('utf8').on('data', (value) => { stderr += value; });
		child.once('error', reject); child.once('close', (code) => done({ code: code ?? 1, stdout, stderr }));
	});
}

function safeArchivePath(path: string) {
	const normalized = path.replaceAll('\\', '/');
	return normalized.length > 0 && !normalized.startsWith('/') && !normalized.split('/').includes('..');
}

export async function extractPagesArchive(archive: string, destination: string) {
	await mkdir(destination, { recursive: true, mode: 0o700 });
	let rejected: string | null = null;
	await extractTar({ file: archive, cwd: destination, strict: true, preservePaths: false,
		filter: (path, entry) => {
			const accepted = safeArchivePath(path) && 'type' in entry && ['File', 'Directory'].includes(entry.type);
			if (!accepted) rejected ??= path;
			return accepted;
		},
	});
	if (rejected) throw new Error(`Cloudflare Pages artifact contains an unsafe archive entry: ${rejected}.`);
}

function safeOutput(root: string, relative: string) {
	const target = resolve(root, relative), absoluteRoot = resolve(root);
	if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${sep}`)) throw new Error('Cloudflare Pages output directory escapes its verified artifact.');
	return target;
}

function sanitizedPagesFailure(result: PagesCommandResult, token: string) {
	const detail = `${result.stderr}\n${result.stdout}`.replaceAll(token, '[redacted]').trim().slice(0, 2_000);
	return new Error(`Cloudflare Pages deployment failed with exit ${result.code}${detail ? `: ${detail}` : '.'}`);
}

function productionDeployment(payload: any, deployment: HostedInfrastructureWorkspace['pagesDeployments'][number]) {
	return payload?.success !== false && Array.isArray(payload?.result) && payload.result.some((item: any) =>
		item.environment === 'production'
		&& item.deployment_trigger?.metadata?.branch === deployment.branch
		&& item.deployment_trigger?.metadata?.commit_hash === deployment.commit
		&& item.deployment_trigger?.metadata?.commit_message === deployment.marker
		&& item.latest_stage?.status === 'success');
}

export async function deployPagesArtifacts(input: { workspace: HostedInfrastructureWorkspace; root: string; env: NodeJS.ProcessEnv; deploy?: boolean; command?: PagesCommand; fetchImpl?: typeof fetch }) {
	const token = input.env.TF_VAR_cloudflare_runtime_token;
	if (input.workspace.pagesDeployments.length && !token) throw new Error('Cloudflare Pages service-vault authority is unavailable.');
	const fetchImpl = input.fetchImpl ?? fetch;
	for (const deployment of input.workspace.pagesDeployments) {
		if (input.deploy !== false && deployment.changed) {
			const extracted = resolve(input.root, 'pages', deployment.resourceId);
			await extractPagesArchive(resolve(input.root, deployment.artifactPath), extracted);
			const output = safeOutput(extracted, deployment.destinationDirectory);
			const env = { ...input.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: deployment.accountId };
			const result = await (input.command ?? createPagesCommand())(['pages', 'deploy', output, '--project-name', deployment.projectName, '--branch', deployment.branch,
				'--commit-hash', deployment.commit, '--commit-message', deployment.marker, '--commit-dirty', 'false'], { cwd: extracted, env });
			if (result.code !== 0) throw sanitizedPagesFailure(result, token!);
		}
		const response = await fetchImpl(`${cloudflareApi}/accounts/${encodeURIComponent(deployment.accountId)}/pages/projects/${encodeURIComponent(deployment.projectName)}/deployments`,
			{ headers: { authorization: `Bearer ${token}` } });
		if (!response.ok || !productionDeployment(await response.json(), deployment)) throw new Error(`Cloudflare Pages production deployment read-back failed for ${deployment.resourceId}.`);
	}
}
