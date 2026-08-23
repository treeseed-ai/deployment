import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const suite = process.argv[2];
if (suite !== 'stable' && suite !== 'development') throw new Error('APT suite must be stable or development.');
const key = process.env.APT_SIGNING_KEY;
if (!key) throw new Error('Protected APT signing key is unavailable.');
const root = process.cwd(), pages = resolve(process.env.TREESEED_PAGES_ROOT ?? '.treeseed/pages'), apt = resolve(pages, 'apt');
const pool = resolve(apt, 'pool', suite), binary = resolve(apt, 'dists', suite, 'main', 'binary-amd64');
rmSync(pool, { recursive: true, force: true }); mkdirSync(pool, { recursive: true }); mkdirSync(binary, { recursive: true });
for (const name of readdirSync(resolve(root, 'release/out')).filter((name) => name.endsWith('.deb'))) cpSync(resolve(root, 'release/out', name), resolve(pool, name));
const packages = execFileSync('dpkg-scanpackages', ['--multiversion', pool, '/dev/null'], { encoding: 'utf8' });
writeFileSync(resolve(binary, 'Packages'), packages); writeFileSync(resolve(binary, 'Packages.gz'), gzipSync(packages, { level: 9 }));
const distribution = resolve(apt, 'dists', suite), releasePath = resolve(distribution, 'Release');
const relative = ['main/binary-amd64/Packages', 'main/binary-amd64/Packages.gz'];
const checksums = relative.map((file) => { const value = readFileSync(resolve(distribution, file)); return ` ${createHash('sha256').update(value).digest('hex')} ${value.length} ${file}`; }).join('\n');
writeFileSync(releasePath, [`Origin: TreeSeed Deployment`, `Label: TreeSeed Deployment`, `Suite: ${suite}`, `Codename: ${suite}`, `Date: ${new Date().toUTCString()}`, 'Architectures: amd64 all', 'Components: main', 'Description: Signed TreeSeed Deployment packages', 'SHA256:', checksums, ''].join('\n'));
const home = mkdtempSync(resolve(tmpdir(), 'treeseed-gpg-'));
try {
	const imported = spawnSync('gpg', ['--batch', '--homedir', home, '--import'], { input: key, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
	if (imported.status !== 0) throw new Error('Protected APT signing key import failed.');
	const listing = execFileSync('gpg', ['--batch', '--homedir', home, '--with-colons', '--list-secret-keys'], { encoding: 'utf8' });
	const fingerprint = listing.split('\n').find((line) => line.startsWith('fpr:'))?.split(':')[9];
	if (!fingerprint) throw new Error('APT signing key has no fingerprint.');
	execFileSync('gpg', ['--batch', '--yes', '--homedir', home, '--local-user', fingerprint, '--clearsign', '--output', resolve(distribution, 'InRelease'), releasePath]);
	execFileSync('gpg', ['--batch', '--yes', '--homedir', home, '--local-user', fingerprint, '--armor', '--detach-sign', '--output', resolve(distribution, 'Release.gpg'), releasePath]);
	console.log(JSON.stringify({ ok: true, suite, fingerprint, packages: readdirSync(pool).length }));
} finally { rmSync(home, { recursive: true, force: true }); }
