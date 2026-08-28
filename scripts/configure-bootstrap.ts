import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { hostConfigurationSchema, canonicalDeploymentJson } from '@treeseed/sdk/deployment';

function value(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
const configurationPath = value('--configuration'), credentialsPath = value('--credentials'), suite = value('--suite') ?? 'development', operatorUser = value('--operator-user');
const packageName = value('--package-name') ?? 'treeseed';
const managerGeneratedSecrets = new Set((value('--manager-generated-secrets') ?? '').split(',').filter(Boolean));
const allowedManagerGeneratedSecrets = new Set(['ai-mode-ca', 'ai-mode-client-cert', 'ai-mode-client-key']);
const resetUnacceptedComponents = (value('--reset-unaccepted-components') ?? '').split(',').filter(Boolean);
if (!configurationPath || (suite !== 'stable' && suite !== 'development')) throw new Error('Usage: configure-bootstrap --configuration HOST.json [--credentials EPHEMERAL.json --consume-credentials] --suite stable|development');
if (!['treeseed', 'treeseed-ai'].includes(packageName)) throw new Error('Configured bootstrap package name is not supported.');
for (const id of managerGeneratedSecrets) if (!allowedManagerGeneratedSecrets.has(id)) throw new Error(`Manager-generated bootstrap secret ${id} is not supported.`);
if (operatorUser !== undefined && (!/^[a-zA-Z0-9._-]+$/u.test(operatorUser) || operatorUser === 'root')) throw new Error('Configured operator username is invalid.');
if (credentialsPath && !process.argv.includes('--consume-credentials')) throw new Error('Plaintext credential input must be explicitly ephemeral and consumed after packaging.');
if (resetUnacceptedComponents.some((componentId) => !/^[a-z][a-z0-9.-]+$/u.test(componentId)) || new Set(resetUnacceptedComponents).size !== resetUnacceptedComponents.length) throw new Error('Unaccepted component reset list is invalid.');
const configuration = hostConfigurationSchema.parse(JSON.parse(readFileSync(resolve(configurationPath), 'utf8')));
const credentials = credentialsPath ? JSON.parse(readFileSync(resolve(credentialsPath), 'utf8')) as unknown : undefined;
if (credentials !== undefined && (!credentials || typeof credentials !== 'object' || Array.isArray(credentials))) throw new Error('Bootstrap credentials must be a JSON object.');
if (credentials !== undefined) {
	const values = credentials as Record<string, unknown>;
	for (const [id, secret] of Object.entries(configuration.secrets)) {
		if (secret.provider !== 'file') continue;
		if (!/^\/etc\/treeseed\/credentials\/[a-z0-9][a-z0-9._-]{0,127}$/u.test(secret.reference)) throw new Error(`Bootstrap file secret ${id} must use a fixed manager-owned credential path.`);
		if (managerGeneratedSecrets.has(id)) {
			if (values[id] !== undefined) throw new Error(`Manager-generated bootstrap credential ${id} must not be embedded.`);
			continue;
		}
		if (typeof values[id] !== 'string' || values[id].length === 0 || values[id].length > 65_536) throw new Error(`Bootstrap credential ${id} is missing or invalid.`);
	}
	for (const [id, secret] of Object.entries(values)) if (!configuration.secrets[id] || typeof secret !== 'string') throw new Error(`Bootstrap credential ${id} is undeclared or invalid.`);
}
if (credentialsPath) unlinkSync(resolve(credentialsPath));
const digest = createHash('sha256').update(canonicalDeploymentJson({ configuration, credentials: credentials ?? null, operatorUser: operatorUser ?? null, resetUnacceptedComponents })).digest('hex');
const temporary = mkdtempSync(resolve(tmpdir(), 'treeseed-configured-'));
try {
	const normalizedConfiguration = resolve(temporary, 'platform.json');
	writeFileSync(normalizedConfiguration, canonicalDeploymentJson(configuration), { mode: 0o600 });
	let normalizedCredentials: string | undefined;
	if (credentials !== undefined) { normalizedCredentials = resolve(temporary, 'credentials.json'); writeFileSync(normalizedCredentials, canonicalDeploymentJson(credentials), { mode: 0o600 }); }
	const release = (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }).version;
	const debianVersion = `${release.replace(/-rc\.(\d+)$/u, '~rc$1')}-1+cfg.${digest.slice(0, 12)}`;
	execFileSync(process.execPath, ['--import', 'tsx', 'scripts/package-deb.ts', packageName], { stdio: 'inherit', env: { ...process.env, TREESEED_CONFIGURATION_FILE: normalizedConfiguration, ...(normalizedCredentials ? { TREESEED_CREDENTIALS_FILE: normalizedCredentials } : {}), ...(operatorUser ? { TREESEED_OPERATOR_USER: operatorUser } : {}), ...(resetUnacceptedComponents.length ? { TREESEED_RESET_UNACCEPTED_COMPONENTS: resetUnacceptedComponents.join(',') } : {}), TREESEED_BOOTSTRAP_SUITE: suite, TREESEED_DEBIAN_VERSION: debianVersion } });
	const packagePath = resolve('release/out', `${packageName}_${debianVersion}_amd64.deb`);
	const checksum = createHash('sha256').update(readFileSync(packagePath)).digest('hex');
	chmodSync(packagePath, 0o600);
	console.log(JSON.stringify({ ok: true, package: packagePath, packageName, sha256: checksum, configurationId: configuration.configurationId, generation: configuration.generation, suite, containsPlaintextBootstrapCredentials: credentials !== undefined, managerGeneratedSecrets: [...managerGeneratedSecrets].sort(), requiredAction: 'Install as root, then securely delete the downloaded .deb after handoff completes.' }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
