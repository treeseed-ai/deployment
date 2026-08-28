import { generateKeyPairSync, randomBytes, scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { resolve } from 'node:path';
import { hostConfigurationSchema } from '@treeseed/sdk/deployment';

function value(name: string) {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

function apiKey(id: string, scopes: string[]) {
	const secret = randomBytes(32).toString('base64url'), salt = randomBytes(16).toString('hex');
	return {
		plain: `ak_${id}_${secret}`,
		record: { id, hash: `scrypt:${salt}:${scryptSync(secret, salt, 32).toString('hex')}`, scopes, revoked: false },
	};
}

function dashboardHash(password: string) {
	const salt = randomBytes(16);
	return `scrypt$16384$8$1$${salt.toString('base64')}$${scryptSync(password, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64')}`;
}

const profilePath = value('--profile'), suite = value('--suite') ?? 'development';
const stableLock = value('--stable-lock'), developmentLock = value('--development-lock');
const operatorUser = value('--operator-user') ?? userInfo().username;
if (!profilePath || !stableLock || suite === 'development' && !developmentLock || !['stable', 'development'].includes(suite)) throw new Error('Usage: build-ai-bootstrap --profile AI_FACTORY.json --stable-lock LOCK [--development-lock LOCK --suite stable|development --operator-user USER]');
if (!/^[a-zA-Z0-9._-]+$/u.test(operatorUser) || operatorUser === 'root') throw new Error('A non-root local operator username is required.');
execFileSync(process.execPath, ['--import', 'tsx', 'scripts/fetch-artifacts.ts', stableLock, ...(developmentLock ? [developmentLock] : [])], { stdio: 'inherit' });
execFileSync(process.execPath, ['--import', 'tsx', 'scripts/prepare-artifacts.ts'], { stdio: 'inherit' });
execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
const profile = JSON.parse(readFileSync(resolve(profilePath), 'utf8')) as Record<string, any>;
if (profile.schemaVersion !== 'treeseed.platform-profile/v1' || profile.id !== 'ai-factory' || profile.default !== false) throw new Error('The standalone builder requires the exact opt-in ai-factory Platform profile.');
if (JSON.stringify(Object.keys(profile.components ?? {}).sort()) !== JSON.stringify(['ai-inference', 'ai-lab', 'ai-training'])) throw new Error('The AI factory profile must select exactly inference, training, and lab.');
if (!Object.values(profile.components).every((component: any) => component?.enabled === true)) throw new Error('Every AI factory component must be enabled.');

const inference = apiKey('lab-inference', ['*']), training = apiKey('lab-training', ['*']);
const ingest = apiKey('training-ingest', ['libraries:read', 'libraries:write', 'libraries:train']);
const labAction = apiKey('lab-library-action', ['*']);
const inferencePassword = randomBytes(32).toString('base64url'), trainingPassword = randomBytes(32).toString('base64url');
const signing = generateKeyPairSync('ed25519');
const privateSigningKey = signing.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const publicSigningKey = signing.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const sourceRegistry = {
	sourceId: 'training-local',
	store: { backend: 'filesystem', storeId: 'training', root: '/training-artifacts', legacyBuckets: ['ai-training'] },
	trustedPublicKey: publicSigningKey,
};
const destinationRegistry = { backend: 'filesystem', storeId: 'inference', root: '/artifacts', legacyBuckets: ['ai-inference'] };
const hostId = hostname().toLowerCase().replace(/[^a-z0-9.-]/gu, '-').replace(/^-+|-+$/gu, '') || 'treeai-host';
const configuration = hostConfigurationSchema.parse({
	schemaVersion: 'treeseed.host/v1', configurationId: `treeai-${hostId}`, generation: 1,
	host: { id: hostId, role: 'integrated', architecture: 'amd64' },
	runtime: { management: 'managed', environment: suite === 'development' ? 'development' : 'production', dataRoot: '/var/lib/treeseed/platform/.treeseed/data' },
	updates: {
		defaultTrack: suite,
		stable: { metadataPollSeconds: 86_400, maintenanceWindow: { weekday: 'sunday', localTime: '03:00', jitterMinutes: 20 } },
		development: { pollSeconds: 60 },
	},
	components: profile.components,
	network: { manager: { binding: '127.0.0.1:4790', aliases: ['manager.treeseed.localhost'], sans: ['manager.treeseed.localhost', '127.0.0.1'], trustedLanCidrs: [] } },
	fleet: { rolloutGroup: 'standalone-treeai', receiptReporting: { enabled: false, intervalSeconds: 300 } },
	secrets: profile.secrets,
});
const credentials = {
	'ai-inference-database-url': `postgresql://inference:${encodeURIComponent(inferencePassword)}@inference-postgres:5432/inference`,
	'ai-inference-postgres-password': inferencePassword,
	'ai-inference-api-keys': JSON.stringify([inference.record]),
	'artifact-source-registry': JSON.stringify(sourceRegistry),
	'artifact-destination-registry': JSON.stringify(destinationRegistry),
	'ai-training-database-url': `postgresql://training:${encodeURIComponent(trainingPassword)}@training-postgres:5432/training`,
	'ai-training-postgres-password': trainingPassword,
	'ai-training-api-keys': JSON.stringify([training.record, ingest.record]),
	'artifact-signing-key': privateSigningKey,
	'ai-lab-api-keys': JSON.stringify([labAction.record]),
	'training-source': JSON.stringify(sourceRegistry),
	'factory-inference-key': inference.plain,
	'factory-training-key': training.plain,
	'hermes-api-key': randomBytes(32).toString('base64url'),
	'hermes-password-hash': dashboardHash(randomBytes(32).toString('base64url')),
	'hermes-session-secret': randomBytes(48).toString('base64url'),
	'training-ingest-key': ingest.plain,
	'lab-library-action-key': labAction.plain,
};

const temporary = mkdtempSync(resolve(tmpdir(), 'treeseed-ai-bootstrap-input-'));
try {
	const configurationPath = resolve(temporary, 'platform.json'), credentialsPath = resolve(temporary, 'credentials.json');
	writeFileSync(configurationPath, JSON.stringify(configuration), { mode: 0o600 });
	writeFileSync(credentialsPath, JSON.stringify(credentials), { mode: 0o600 });
	execFileSync(process.execPath, ['--import', 'tsx', 'scripts/configure-bootstrap.ts', '--configuration', configurationPath, '--credentials', credentialsPath, '--consume-credentials', '--suite', suite, '--operator-user', operatorUser, '--package-name', 'treeseed-ai', '--manager-generated-secrets', 'ai-mode-ca,ai-mode-client-cert,ai-mode-client-key'], { stdio: 'inherit' });
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
