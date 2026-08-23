import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { hostConfigurationSchema, canonicalDeploymentJson } from '@treeseed/sdk/deployment';

function value(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
const configurationPath = value('--configuration'), credentialsPath = value('--credentials'), suite = value('--suite') ?? 'development';
if (!configurationPath || (suite !== 'stable' && suite !== 'development')) throw new Error('Usage: configure-bootstrap --configuration HOST.json [--credentials EPHEMERAL.json --consume-credentials] --suite stable|development');
if (credentialsPath && !process.argv.includes('--consume-credentials')) throw new Error('Plaintext credential input must be explicitly ephemeral and consumed after packaging.');
const configuration = hostConfigurationSchema.parse(JSON.parse(readFileSync(resolve(configurationPath), 'utf8')));
const credentials = credentialsPath ? JSON.parse(readFileSync(resolve(credentialsPath), 'utf8')) as unknown : undefined;
if (credentials !== undefined && (!credentials || typeof credentials !== 'object' || Array.isArray(credentials))) throw new Error('Bootstrap credentials must be a JSON object.');
if (credentials !== undefined) {
	const values = credentials as Record<string, unknown>;
	for (const [id, secret] of Object.entries(configuration.secrets)) {
		if (secret.provider !== 'file') continue;
		if (secret.reference !== `/etc/treeseed/credentials/${id}`) throw new Error(`Bootstrap file secret ${id} must use the manager-owned credential path.`);
		if (typeof values[id] !== 'string' || values[id].length === 0 || values[id].length > 65_536) throw new Error(`Bootstrap credential ${id} is missing or invalid.`);
	}
	for (const [id, secret] of Object.entries(values)) if (!configuration.secrets[id] || typeof secret !== 'string') throw new Error(`Bootstrap credential ${id} is undeclared or invalid.`);
}
if (credentialsPath) unlinkSync(resolve(credentialsPath));
const digest = createHash('sha256').update(canonicalDeploymentJson({ configuration, credentials: credentials ?? null })).digest('hex');
const temporary = mkdtempSync(resolve(tmpdir(), 'treeseed-configured-'));
try {
	const normalizedConfiguration = resolve(temporary, 'platform.json');
	writeFileSync(normalizedConfiguration, canonicalDeploymentJson(configuration), { mode: 0o600 });
	let normalizedCredentials: string | undefined;
	if (credentials !== undefined) { normalizedCredentials = resolve(temporary, 'credentials.json'); writeFileSync(normalizedCredentials, canonicalDeploymentJson(credentials), { mode: 0o600 }); }
	const debianVersion = `0.1.0~rc5-1+cfg.${digest.slice(0, 12)}`;
	execFileSync(process.execPath, ['--import', 'tsx', 'scripts/package-deb.ts', 'treeseed'], { stdio: 'inherit', env: { ...process.env, TREESEED_CONFIGURATION_FILE: normalizedConfiguration, ...(normalizedCredentials ? { TREESEED_CREDENTIALS_FILE: normalizedCredentials } : {}), TREESEED_BOOTSTRAP_SUITE: suite, TREESEED_DEBIAN_VERSION: debianVersion } });
	const packagePath = resolve('release/out', `treeseed_${debianVersion}_amd64.deb`);
	const checksum = createHash('sha256').update(readFileSync(packagePath)).digest('hex');
	chmodSync(packagePath, 0o600);
	console.log(JSON.stringify({ ok: true, package: packagePath, sha256: checksum, configurationId: configuration.configurationId, generation: configuration.generation, suite, containsPlaintextBootstrapCredentials: credentials !== undefined, requiredAction: 'Install as root, then securely delete the downloaded .deb after handoff completes.' }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
