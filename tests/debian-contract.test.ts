import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Debian and systemd contracts', () => {
	it('revises the repackaged CLI for every immutable composition', () => {
		const packaging = readFileSync('scripts/package-deb.ts', 'utf8');
		expect(packaging).toContain("`${debianVersion(cliPayload.version).replace(/-1$/u, '-2')}+deployment${deploymentVersion.replace(/-1$/u, '')}`");
		expect(packaging).toContain('treeseed-host-runtime`, description: \'TreeSeed trsd host client payload\'');
		expect(packaging).not.toContain('treeseed-host-runtime (= ${deploymentVersion})`, description: \'TreeSeed trsd host client payload\'');
	});

	it('bootstraps component configuration before an upgraded manager activates it', () => {
		const packaging = readFileSync('scripts/package-deb.ts', 'utf8');
		expect(packaging).toContain("resolve(stage, 'DEBIAN/postinst')");
		expect(packaging).toContain('if [ ! -e ${configurationRoot}/environment ]');
		expect(packaging).toContain('-o root -g treeseed-manager -m 0640');
	});

	it('ships independent stable and development schedulers', () => {
		const stable = readFileSync('systemd/treeseed-manager-stable.timer', 'utf8');
		const development = readFileSync('systemd/treeseed-manager-development.timer', 'utf8');
		expect(stable).toContain('OnUnitInactiveSec=5m');
		expect(stable).not.toContain('OnCalendar=');
		expect(stable).toContain('RandomizedDelaySec=15s');
		expect(development).toContain('OnUnitInactiveSec=60s');
	});

	it('sandboxes the manager and exposes only the fixed supervisor as root', () => {
		const units = readdirSync('systemd').filter((name) => name.endsWith('.service'));
		const supervisor = readFileSync('systemd/treeseed-manager-supervisor.service', 'utf8');
		expect(supervisor).toContain('ProtectSystem=strict');
		expect(supervisor).toContain('ProtectHome=no');
		expect(supervisor).toContain('workspace-visible .treeseed/data root');
		for (const unit of units.filter((name) => name.startsWith('treeseed-manager-') && !['treeseed-manager-supervisor.service', 'treeseed-manager-apt-helper.service', 'treeseed-manager-restart.service'].includes(name))) {
			const value = readFileSync(`systemd/${unit}`, 'utf8');
			expect(value).toContain('User=treeseed-manager');
			expect(value).toContain('NoNewPrivileges=yes');
		}
		const aptHelper = readFileSync('systemd/treeseed-manager-apt-helper.service', 'utf8');
		expect(aptHelper).toContain('Type=oneshot');
		expect(aptHelper).toContain('ProtectSystem=false');
		const api = readFileSync('systemd/treeseed-manager-api.service', 'utf8');
		expect(api).toContain('Group=treeseed-operators');
		expect(api).toContain('SupplementaryGroups=treeseed-manager');
		expect(supervisor).toContain('-g treeseed-operators -m 0770 /run/treeseed/manager');
		const managerPostinstall = readFileSync('debian/manager/postinst', 'utf8');
		expect(managerPostinstall).not.toContain('try-restart');
		expect(managerPostinstall).not.toContain('restart treeseed-manager');
		expect(readFileSync('scripts/bootstrap/bootstrap.sh', 'utf8')).toContain('systemctl restart treeseed-manager-supervisor.service treeseed-manager-api.service');
	});

	it('keeps lab isolated from the Docker socket and host ports', () => {
		const compose = readFileSync('deploy/lab/compose.yml', 'utf8');
		const diagnostics = readFileSync('lab/diagnostics.mjs', 'utf8');
		const publication = readFileSync('.github/workflows/publish.yml', 'utf8');
		expect(compose).not.toContain('/var/run/docker.sock');
		expect(compose).not.toMatch(/^\s+ports:/mu);
		expect(compose).toContain('internal: true');
		expect(diagnostics).toContain('maximumBytes = 256 * 1024');
		expect(diagnostics).toContain('sensitive');
		expect(publication).toContain('platforms: linux/amd64,linux/arm64');
		expect(publication).toContain('Bind and read back exact lab images');
		expect(publication).toContain('TREESEED_REQUIRE_PUBLISHED_IMAGES=1');
		expect(publication).toContain('gh release create');
		expect(readFileSync('scripts/prepare-artifacts.ts', 'utf8')).toContain('Integration selection');
	});

	it('runs the only host edge inside the shared Docker network', () => {
		const compose = readFileSync('deploy/edge/compose.yml', 'utf8');
		const unit = readFileSync('systemd/treeseed-edge.service', 'utf8');
		const supervisor = readFileSync('src/supervisor/execute.ts', 'utf8');
		expect(compose).toContain('caddy:2.10.2-alpine@sha256:');
		expect(compose).toContain('name: treeseed-edge');
		expect(compose).toContain('/run/treeseed/manager:/run/treeseed/manager:ro');
		expect(compose).toContain('caddy", "validate"');
		expect(unit).toContain('docker compose --file /usr/share/treeseed/edge/compose.yml');
		expect(unit).not.toContain('/usr/bin/caddy');
		expect(supervisor).toContain("'/usr/share/treeseed/edge/compose.yml'");
		expect(supervisor).toContain("'validate'");
		expect(readFileSync('scripts/package-deb.ts', 'utf8')).toContain("':443 {\\n\\tabort\\n}\\n'");
		expect(readFileSync('systemd/treeseed-manager-supervisor.service', 'utf8')).toContain('RuntimeDirectory=treeseed/manager');
		expect(readFileSync('systemd/treeseed-manager-supervisor.service', 'utf8')).toContain('Group=treeseed-operators');
		expect(readFileSync('systemd/treeseed-manager-supervisor.service', 'utf8')).toContain('SupplementaryGroups=treeseed-manager');
	});

	it('documents configured-package credential consumption and deletion', () => {
		const generator = readFileSync('scripts/configure-bootstrap.ts', 'utf8');
		const postinstall = readFileSync('scripts/bootstrap/bootstrap.sh', 'utf8');
		expect(generator).toContain('--consume-credentials');
		expect(generator).toContain('unlinkSync(resolve(credentialsPath))');
		expect(generator).not.toContain('console.log(credentials');
		expect(generator).toContain('containsPlaintextBootstrapCredentials: credentials !== undefined');
		expect(postinstall).toContain('rm -f "$state/seed/credentials.json"');
		expect(postinstall).toContain("'.secrets[$id] | select(.provider == \"file\") | .reference'");
		expect(postinstall).toContain('/etc/treeseed/credentials/[a-z0-9]*');
		expect(postinstall).toContain('chown root:root "$temporary"');
		expect(postinstall).toContain('chmod 0600 "$temporary"');
		expect(postinstall).not.toContain('chown root:treeseed-manager "$temporary"');
		expect(postinstall).toContain('securely delete the downloaded configured .deb');
		expect(postinstall).toContain('rm -f "$seed"');
		expect(readFileSync('debian/bootstrap/postinst', 'utf8')).toContain('systemctl --no-block start treeseed-bootstrap.service');
		expect(readFileSync('debian/bootstrap/postinst', 'utf8')).not.toContain('enable --now');
		expect(readFileSync('debian/bootstrap/postinst', 'utf8')).toContain('adduser "$operator" treeseed-operators');
		expect(readFileSync('systemd/treeseed-bootstrap.service', 'utf8')).toContain('ConditionPathExists=/var/lib/treeseed/bootstrap/seed/platform.json');
		expect(postinstall).toContain('treeseed-deployment-stable.sources');
		expect(postinstall).toContain('treeseed-deployment-development.sources');
		expect(postinstall).not.toContain('rm -f /etc/apt/sources.list.d/treeseed-deployment-');
		expect(postinstall).toContain('--target-release "$suite"');
		expect(postinstall).toContain('$package/$suite');
		expect(postinstall).toContain('--allow-downgrades');
		expect(postinstall).toContain('bootstrap-status.json');
		expect(postinstall).toContain('-o root -g treeseed-manager -m 0640');
		expect(postinstall).toContain('"complete":true,"installerCredentialsRetained":false');
		expect(readFileSync('src/manager/operations.ts', 'utf8')).not.toContain('/var/lib/treeseed/bootstrap/');
		const managerPostinstall = readFileSync('debian/manager/postinst', 'utf8');
		expect(managerPostinstall).toContain('addgroup --system treeseed-component-secrets');
		expect(managerPostinstall).toContain('-g treeseed-component-secrets -m 0710 /var/lib/treeseed/component-secrets');
		const workstation = readFileSync('scripts/build-workstation-bootstrap.ts', 'utf8');
		expect(JSON.parse(readFileSync('package.json', 'utf8')).scripts['build:workstation']).toContain('artifacts:prepare');
		expect(workstation).toContain('(authStat.mode & 0o077) !== 0');
		expect(workstation).toContain("'--consume-credentials'");
		expect(workstation).toContain("generateKeyPairSync('rsa', { modulusLength: 2048 })");
		expect(workstation).toContain("'api-treedx-delegation-private-key'");
		expect(workstation).toContain("'treedx-credential-broker-assertion'");
		expect(workstation).not.toContain('console.log');
		const aiBootstrap = readFileSync('scripts/build-ai-bootstrap.ts', 'utf8');
		expect(JSON.parse(readFileSync('package.json', 'utf8')).scripts['build:ai-bootstrap']).toContain('scripts/build-ai-bootstrap.ts');
		expect(aiBootstrap).toContain('scripts/fetch-artifacts.ts');
		expect(aiBootstrap).toContain('scripts/prepare-artifacts.ts');
		expect(aiBootstrap).toContain("profile.id !== 'ai-factory'");
		expect(aiBootstrap).toContain("'--package-name', 'treeseed-ai'");
		expect(aiBootstrap).toContain("'--manager-generated-secrets', 'ai-mode-ca,ai-mode-client-cert,ai-mode-client-key'");
		expect(aiBootstrap).toContain("backend: 'filesystem'");
		expect(aiBootstrap).not.toContain('/etc/treeseed-ai');
		expect(generator).toContain("['treeseed', 'treeseed-ai'].includes(packageName)");
		expect(generator).toContain('managerGeneratedSecrets.has(id)');
		expect(readFileSync('scripts/package-deb.ts', 'utf8')).toContain("packages['treeseed-ai']");
		for (const suite of ['stable', 'development']) expect(readFileSync(`deploy/bootstrap/${suite}.sources`, 'utf8')).toContain(`Signed-By: /etc/apt/keyrings/treeseed-deployment-${suite}.gpg`);
		const readme = readFileSync('README.md', 'utf8');
		expect(readme).toContain('install -o _apt -g root -m 0600');
		expect(readme).not.toContain('chmod 644');
	});

	it('locks every external component and host payload through exact Platform integration releases', () => {
		const fetcher = readFileSync('scripts/fetch-artifacts.ts', 'utf8');
		expect(fetcher).toContain('integrationReleaseSchema.parse');
		expect(fetcher).toContain('raw\\.githubusercontent\\.com');
		expect(fetcher).toContain('digest(value) !== sha256');
		expect(readFileSync('scripts/package-deb.ts', 'utf8')).not.toMatch(/component\('(api|agent|treedx)',\s*'\d/u);
	});

	it('binds each protected APT suite to its independent signing identity', () => {
		const publisher = readFileSync('scripts/publish-apt.ts', 'utf8');
		const workflow = readFileSync('.github/workflows/publish.yml', 'utf8');
		expect(publisher).toContain('release/apt/${suite}.fingerprint');
		expect(publisher).toContain('does not match its published keyring');
		const stable = readFileSync('release/apt/stable.fingerprint', 'utf8').trim();
		const development = readFileSync('release/apt/development.fingerprint', 'utf8').trim();
		expect(stable).toMatch(/^[A-F0-9]{40}$/u);
		expect(development).toMatch(/^[A-F0-9]{40}$/u);
		expect(stable).not.toBe(development);
		expect(workflow).toContain('find .treeseed/artifacts/components/lab');
		expect(workflow).not.toMatch(/components\/lab\/0\.1\.0~rc\d+-1\/component-release/u);
		expect(workflow).toContain('TREESEED_APT_SUITE: ${{ inputs.suite }}');
		expect(readFileSync('.github/workflows/publish-lab.yml', 'utf8')).toContain('environment: development');
		expect(readFileSync('scripts/package-deb.ts', 'utf8')).toContain("aptSuite !== 'stable' || name !== 'treeseed-release-catalog-development'");
	});

	it('versions stable catalog packages by immutable catalog generation', () => {
		const packager = readFileSync('scripts/package-deb.ts', 'utf8');
		expect(packager).toContain('stableCatalog.generation');
		expect(packager).toContain('`${stableCatalogRelease}-${stableCatalog.generation}`');
		expect(packager).not.toContain('const stableCatalogVersion = `${stableCatalogRelease}-1`');
	});

	it('lets the manager choose exact component versions and supports governed rollback', () => {
		const bootstrap = readFileSync('scripts/bootstrap/bootstrap.sh', 'utf8');
		const helper = readFileSync('src/supervisor/apt-helper.ts', 'utf8');
		const reconciliation = readFileSync('src/manager/reconcile.ts', 'utf8');
		const supervisor = readFileSync('src/supervisor/execute.ts', 'utf8');
		const backup = readFileSync('src/supervisor/backup.ts', 'utf8');
		const publisher = readFileSync('scripts/publish-apt.ts', 'utf8');
		expect(bootstrap).not.toContain('treeseed-component-$component');
		expect(helper).toContain("'--allow-downgrades'");
		expect(helper).toContain("'DPkg::Lock::Timeout=600'");
		expect(helper).toContain("'--no-remove'");
		expect(helper).toContain("'--target-release'");
		expect(helper).toContain("command('/usr/bin/apt-get', ['clean'])");
		expect(helper).toContain('corePackagesForTrack(operation.track, before)');
		expect(reconciliation).toContain("operation: 'apt.refresh'");
		expect(reconciliation).toContain("operation: 'backup.create'");
		expect(reconciliation).toContain("operation: 'recovery.restore'");
		expect(reconciliation).toContain('reconcile.rollback-complete');
		expect(supervisor).not.toContain('/usr/lib/treeseed/manager/bin/restore-generation');
		expect(backup).toContain("'var/lib/treeseed/components'");
		expect(backup).toContain("'usr/share/treeseed/components'");
		expect(publisher).not.toContain('rmSync(pool');
	});

	it('does not let development component packages force a core manager upgrade', () => {
		const packager = readFileSync('scripts/package-deb.ts', 'utf8');
		expect(packager).toContain("depends: 'treeseed-manager'");
		expect(packager).not.toContain('treeseed-manager (>= ${deploymentVersion})');
		expect(packager).not.toContain('treeseed-manager (= ${deploymentVersion})');
	});
});
