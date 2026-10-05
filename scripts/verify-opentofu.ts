import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostedInfrastructureToolchain } from '../src/infrastructure/opentofu/toolchain.js';

const root = process.cwd(), tools = resolve(root, '.treeseed/tools'), moduleRoot = resolve(root, 'infrastructure/opentofu/hosted-topology');
const archive = resolve(tools, `tofu-${hostedInfrastructureToolchain.opentofu.version}-linux-amd64.tar.gz`), binary = resolve(tools, `tofu-${hostedInfrastructureToolchain.opentofu.version}`);
mkdirSync(tools, { recursive: true });
if (!existsSync(archive)) execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', `https://github.com/opentofu/opentofu/releases/download/v${hostedInfrastructureToolchain.opentofu.version}/tofu_${hostedInfrastructureToolchain.opentofu.version}_linux_amd64.tar.gz`, '--output', archive], { stdio: 'inherit' });
const actual = createHash('sha256').update(readFileSync(archive)).digest('hex');
if (actual !== hostedInfrastructureToolchain.opentofu.linuxAmd64ArchiveSha256) throw new Error('Pinned OpenTofu archive checksum mismatch.');
if (!existsSync(binary)) {
	execFileSync('tar', ['-xzf', archive, '-C', tools, 'tofu']);
	execFileSync('mv', [resolve(tools, 'tofu'), binary]);
}

try {
	execFileSync(binary, ['init', '-backend=false', '-input=false', '-lockfile=readonly'], { cwd: moduleRoot, stdio: 'inherit' });
	const validation = JSON.parse(execFileSync(binary, ['validate', '-json'], { cwd: moduleRoot, encoding: 'utf8' })) as { valid?: boolean; diagnostics?: unknown[] };
	if (!validation.valid) throw new Error(`OpenTofu module validation failed: ${JSON.stringify(validation.diagnostics)}`);
	const schemas = JSON.parse(execFileSync(binary, ['providers', 'schema', '-json'], { cwd: moduleRoot, encoding: 'utf8', maxBuffer: 64 * 1_024 * 1_024 })) as any;
	const railway = schemas.provider_schemas?.['registry.opentofu.org/jamesprnich/railway']?.resource_schemas;
	const cloudflare = schemas.provider_schemas?.['registry.opentofu.org/cloudflare/cloudflare']?.resource_schemas;
	for (const resource of ['railway_service', 'railway_service_instance', 'railway_variable', 'railway_volume', 'railway_custom_domain', 'railway_private_network']) if (!railway?.[resource]) throw new Error(`Pinned Railway provider is missing ${resource}.`);
	for (const attribute of ['source_image', 'draining_seconds', 'overlap_seconds', 'healthcheck_path']) if (!railway.railway_service_instance.block?.attributes?.[attribute]) throw new Error(`Pinned Railway service-instance contract is missing ${attribute}.`);
	for (const resource of ['cloudflare_workers_script', 'cloudflare_dns_record', 'cloudflare_zone_setting']) if (!cloudflare?.[resource]) throw new Error(`Pinned Cloudflare provider is missing ${resource}.`);
	console.log(JSON.stringify({ ok: true, opentofu: hostedInfrastructureToolchain.opentofu.version, providers: hostedInfrastructureToolchain.providers }));
} finally {
	rmSync(resolve(moduleRoot, '.terraform'), { recursive: true, force: true });
}
