import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { resolve } from 'node:path';
import { hostConfigurationSchema } from '@treeseed/sdk/deployment';

function value(name: string) {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

const configurationPath = value('--configuration'), authPath = value('--codex-auth-file');
const resetUnacceptedComponents = value('--reset-unaccepted-components');
const suite = value('--suite') ?? 'development';
const operatorUser = value('--operator-user') ?? userInfo().username;
if (!configurationPath || !authPath || (suite !== 'stable' && suite !== 'development')) throw new Error('Usage: build-workstation-bootstrap --configuration HOST.json --codex-auth-file AUTH.json [--suite development|stable]');
if (!/^[a-zA-Z0-9._-]+$/u.test(operatorUser) || operatorUser === 'root') throw new Error('A non-root local operator username is required.');
const authStat = lstatSync(resolve(authPath));
if (!authStat.isFile() || authStat.isSymbolicLink() || (authStat.mode & 0o077) !== 0 || authStat.size < 2 || authStat.size > 65_536) throw new Error('Codex authentication must be a private regular file no larger than 64 KiB.');
const auth = readFileSync(resolve(authPath), 'utf8');
const parsedAuth = JSON.parse(auth) as unknown;
if (!parsedAuth || typeof parsedAuth !== 'object' || Array.isArray(parsedAuth)) throw new Error('Codex authentication cache is malformed.');
const configuration = hostConfigurationSchema.parse(JSON.parse(readFileSync(resolve(configurationPath), 'utf8')));
const required = ['agent-codex-auth', 'api-postgres-password', 'api-database-url', 'api-session-secret', 'api-treedx-delegation-private-key'];
const fileSecrets = Object.entries(configuration.secrets).filter(([, secret]) => secret.provider === 'file').map(([id]) => id).sort();
if (JSON.stringify(fileSecrets) !== JSON.stringify([...required].sort())) throw new Error('Workstation bootstrap configuration has an unexpected file-secret contract.');
const password = randomBytes(32).toString('base64url');
const delegationPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const credentials = {
	'agent-codex-auth': auth,
	'api-postgres-password': password,
	'api-database-url': `postgresql://treeseed:${encodeURIComponent(password)}@database:5432/treeseed_api`,
	'api-session-secret': randomBytes(48).toString('base64url'),
	'api-treedx-delegation-private-key': delegationPrivateKey,
};
const temporary = mkdtempSync(resolve(tmpdir(), 'treeseed-bootstrap-input-'));
try {
	const credentialPath = resolve(temporary, 'credentials.json');
	writeFileSync(credentialPath, JSON.stringify(credentials), { mode: 0o600 });
	execFileSync(process.execPath, ['--import', 'tsx', 'scripts/configure-bootstrap.ts', '--configuration', resolve(configurationPath), '--credentials', credentialPath, '--consume-credentials', '--suite', suite, '--operator-user', operatorUser, ...(resetUnacceptedComponents ? ['--reset-unaccepted-components', resetUnacceptedComponents] : [])], { stdio: 'inherit' });
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
