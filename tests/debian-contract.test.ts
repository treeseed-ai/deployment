import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Debian and systemd contracts', () => {
	it('revises the repackaged CLI for every immutable composition', () => {
		const packaging = readFileSync('scripts/package-deb.ts', 'utf8');
		expect(packaging).toContain("`${debianVersion(cliPayload.version).replace(/-1$/u, '-2')}+deployment${deploymentVersion.replace(/-1$/u, '')}`");
		expect(packaging).toContain('treeseed-host-runtime`, description: \'TreeSeed trsd host client payload\'');
		expect(packaging).not.toContain('treeseed-host-runtime (= ${deploymentVersion})`, description: \'TreeSeed trsd host client payload\'');
	});

	it('keeps the Kata package small while verifying the exact runtime before atomic activation', () => {
		const packaging = readFileSync('scripts/package-deb.ts', 'utf8');
		const postinstall = readFileSync('debian/kata-runtime/postinst', 'utf8');
		expect(packaging).toContain("writeFileSync(resolve(stage, 'usr/share/treeseed/kata-runtime.env')");
		expect(packaging).not.toContain("execFileSync('/usr/bin/tar', ['--extract', '--zstd'");
		expect(postinstall).toContain('sha256sum --check --status');
		expect(postinstall).toContain('mv -Tf /opt/kata.new /opt/kata');
		expect(postinstall).toContain('Pinned Kata archive has an unexpected layout.');
	});

	it('accepts either distribution containerd or Docker containerd.io', () => {
		const packaging = readFileSync('scripts/package-deb.ts', 'utf8');
		expect(packaging.match(/containerd \(>= 2\.0\) \| containerd\.io \(>= 2\.0\)/gu)).toHaveLength(2);
	});

	it('keeps SDK-owned runtime dependencies out of the Debian CLI payload', () => {
		const packaging = readFileSync('scripts/package-deb.ts', 'utf8');
		const verification = readFileSync('scripts/verify-deb.ts', 'utf8');
		expect(packaging).toContain("const sdkOwnedCliRuntimePaths = ['@treeseed/sdk', '@treeseed/treedx', 'yaml', 'zod']");
		expect(packaging).toContain('for (const path of sdkOwnedCliRuntimePaths) rmSync');
		expect(verification).toContain('both own ${path}');
	});

	it('ships and imports the manager SDK runtime closure', () => {
		const packaging = readFileSync('scripts/package-deb.ts', 'utf8');
		const verification = readFileSync('scripts/verify-deb.ts', 'utf8');
		expect(packaging).toContain("['@treeseed/sdk', '@treeseed/treedx', 'typescript', 'yaml', 'zod']");
		expect(verification).toContain("'operator-contracts/operation-builder.js', 'standards/typescript/extract.js'");
	});

	it('ships provider credential initializers as replaceable data registrations', () => {
		const packaging = readFileSync('scripts/package-deb.ts', 'utf8');
		const brokerUnit = readFileSync('systemd/treeseed-sandbox-broker.service', 'utf8');
		expect(brokerUnit).toContain('/var/lib/cni');
		expect(packaging).toContain("resolve(stage, 'usr/share/treeseed/credential-initializers')");
		expect(JSON.parse(readFileSync('credential-initializers/treeseed.codex.json', 'utf8'))).toMatchObject({ schemaVersion: 'treeseed.host-credential-initializer/v1', id: 'treeseed.codex' });
		expect(brokerUnit).not.toContain('model-provider-auth');
		expect(brokerUnit).toContain('RuntimeDirectoryPreserve=restart');
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
		expect(supervisor).toContain('-/etc/systemd/system/treeseed-sandbox-broker.service.d');
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
		expect(managerPostinstall).not.toMatch(/restart treeseed-manager-(?:supervisor|api|stable\.service|development\.service)/u);
		expect(managerPostinstall).toContain('for unit in treeseed-manager-supervisor treeseed-manager-api treeseed-sandbox-broker treeseed-manager-reconcile treeseed-manager-stable treeseed-manager-development');
		expect(managerPostinstall).toContain('"/etc/systemd/system/$unit.service.d"');
		expect(managerPostinstall).not.toContain('model-provider-auth');
		expect(managerPostinstall).not.toContain('20-execution-provider-credential.conf');
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
		expect(publication).toContain("require('./package.json').version");
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
		expect(readFileSync('systemd/treeseed-manager-supervisor.service', 'utf8')).toContain('/var/lib/systemd');
		expect(readFileSync('systemd/treeseed-manager-supervisor.service', 'utf8')).toContain('/etc/cni/net.d');
		expect(readFileSync('debian/manager/postinst', 'utf8')).toContain('/etc/cni/net.d');
		expect(readFileSync('debian/manager/postinst', 'utf8')).toContain('/opt/cni/bin/$plugin');
	});

	it('publishes a generic credential-free bootstrap foundation', () => {
		const packaging = readFileSync('scripts/package-deb.ts', 'utf8');
		const bootstrap = readFileSync('scripts/bootstrap/bootstrap.sh', 'utf8');
		expect(packaging).toContain('Generic credential-free TreeSeed host bootstrap foundation');
		expect(packaging).not.toContain('TREESEED_CONFIGURATION_FILE');
		expect(packaging).not.toContain('TREESEED_CREDENTIALS_FILE');
		expect(packaging).not.toContain("packages['treeseed-ai']");
		expect(bootstrap).not.toContain('/etc/treeseed/platform.json');
		expect(bootstrap).not.toContain('credentials.json');
		expect(bootstrap).not.toContain('treeseed-component-');
		expect(bootstrap).not.toContain('treeseed-edge');
		expect(bootstrap).not.toContain('systemctl start treeseed-manager-reconcile.service');
		expect(bootstrap).toContain('"foundationReady":true,"initializationRequired":true');
		expect(bootstrap).toContain('"installerCredentialsRetained":false');
		expect(readFileSync('debian/bootstrap/postinst', 'utf8')).toContain('systemctl --no-block start treeseed-bootstrap.service');
		expect(readFileSync('debian/bootstrap/postinst', 'utf8')).not.toContain('enable --now');
		expect(readFileSync('debian/bootstrap/postinst', 'utf8')).toContain('adduser "$operator" treeseed-operators');
		expect(readFileSync('systemd/treeseed-bootstrap.service', 'utf8')).toContain('ConditionPathExists=!/var/lib/treeseed/bootstrap/foundation.complete');
		expect(readFileSync('systemd/treeseed-bootstrap.service', 'utf8')).toContain('ConditionPathExists=!/etc/treeseed/platform.json');
		expect(bootstrap).toContain('treeseed-deployment-stable.sources');
		expect(bootstrap).toContain('treeseed-deployment-development.sources');
		expect(bootstrap).not.toContain('rm -f /etc/apt/sources.list.d/treeseed-deployment-');
		expect(bootstrap).toContain('--target-release "$suite"');
		expect(bootstrap).toContain('$package/$suite');
		expect(bootstrap).toContain('--allow-downgrades');
		expect(bootstrap).toContain('systemctl disable --now treeseed-manager-development.timer treeseed-manager-stable.timer');
		expect(bootstrap).toContain('/usr/lib/treeseed/manager/dist/src/bin/wait-supervisor.js');
		expect(readFileSync('src/manager/operations.ts', 'utf8')).not.toContain('/var/lib/treeseed/bootstrap/');
		const managerPostinstall = readFileSync('debian/manager/postinst', 'utf8');
		expect(managerPostinstall).toContain('addgroup --system treeseed-component-secrets');
		expect(managerPostinstall).toContain('-g treeseed-component-secrets -m 0710 /var/lib/treeseed/component-secrets');
		expect(managerPostinstall).toContain('if [ -f /etc/treeseed/platform.json ]');
		expect(managerPostinstall).toContain('systemctl disable --now treeseed-manager-stable.timer treeseed-manager-development.timer');
		for (const suite of ['stable', 'development']) expect(readFileSync(`deploy/bootstrap/${suite}.sources`, 'utf8')).toContain(`Signed-By: /etc/apt/keyrings/treeseed-deployment-${suite}.gpg`);
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
		expect(workflow.indexOf('Require protected publication credentials before building')).toBeLessThan(workflow.indexOf('npm run verify:direct'));
		expect(workflow.indexOf('Require the protected workflow ref for the selected suite')).toBeLessThan(workflow.indexOf('npm run verify:direct'));
		expect(workflow).toContain("refs/heads/main' || 'refs/heads/staging");
		expect(workflow).toContain('Published release asset differs: $name');
		expect(workflow).toContain('cmp --silent "$asset" "$existing_dir/$name"');
		expect(workflow).not.toContain('gh release upload "${{ inputs.tag }}" release/out/*');
		expect(workflow).toContain('Restore exact release assets for APT-only resume');
		expect(workflow).toContain("gh release download \"${{ inputs.tag }}\" --pattern '*.deb' --pattern exact-head.json");
		expect(workflow).toContain('.repository == $repository and .commit == $commit and .tag == $tag and .suite == $suite');
		expect(workflow).toContain('if: ${{ !inputs.resume_apt_only }}');
		expect(workflow).toContain('checked_out_head="$(git rev-parse HEAD)"');
		expect(workflow).toContain('test "$checked_out_head" = "$(git rev-list -n 1');
		expect(workflow).not.toContain('"$GITHUB_REPOSITORY" "$GITHUB_SHA" "${{ inputs.tag }}"');
		const stable = readFileSync('release/apt/stable.fingerprint', 'utf8').trim();
		const development = readFileSync('release/apt/development.fingerprint', 'utf8').trim();
		expect(stable).toMatch(/^[A-F0-9]{40}$/u);
		expect(development).toMatch(/^[A-F0-9]{40}$/u);
		expect(stable).not.toBe(development);
		expect(workflow).toContain('find .treeseed/artifacts/components/lab');
		expect(workflow).not.toMatch(/components\/lab\/0\.1\.0~rc\d+-1\/component-release/u);
		expect(workflow).toContain('TREESEED_APT_SUITE: ${{ inputs.suite }}');
		expect(readFileSync('.github/workflows/publish-lab.yml', 'utf8')).toContain('environment: staging');
		expect(readFileSync('scripts/package-deb.ts', 'utf8')).toContain("aptSuite !== 'stable' || name !== 'treeseed-release-catalog-development'");
	});

	it('versions stable catalog packages by immutable generation and digest', () => {
		const packager = readFileSync('scripts/package-deb.ts', 'utf8');
		expect(packager).toContain('stableCatalogDebianVersion(stableCatalog)');
		expect(readFileSync('scripts/catalog-package-version.ts', 'utf8')).toContain("+catalog.${catalog.catalogDigest.slice(7, 19)}");
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
		expect(helper).toContain("'Acquire::http::No-Cache=true'");
		expect(helper).toContain("'Acquire::https::No-Cache=true'");
		expect(readFileSync('src/supervisor/component.ts', 'utf8')).toContain("if (componentId === 'agent') { chownSync(target, 0, 65_532); chmodSync(target, 0o640); }");
		expect(helper).toContain("'--no-remove'");
		expect(helper).toContain("'--target-release'");
		expect(helper).toContain("command('/usr/bin/apt-get', ['clean'])");
		expect(helper).toContain('exactPackagesForRefresh(operation.track, before)');
		expect(reconciliation).toContain("operation: 'apt.refresh'");
		expect(reconciliation).toContain("operation: 'backup.create'");
		expect(reconciliation).toContain("operation: 'recovery.restore'");
		expect(reconciliation.indexOf('componentActivationInputs(host')).toBeLessThan(reconciliation.indexOf("operation: 'backup.create'"));
		expect(backup).not.toContain("'usr/share/treeseed/components'");
		expect(reconciliation).toContain('reconcile.rollback-complete');
		expect(supervisor).not.toContain('/usr/lib/treeseed/manager/bin/restore-generation');
		expect(backup).toContain("'var/lib/treeseed/components'");
		expect(backup).not.toContain("'usr/share/treeseed/components'");
		expect(publisher).not.toContain('rmSync(pool');
	});

	it('does not let development component packages force a core manager upgrade', () => {
		const packager = readFileSync('scripts/package-deb.ts', 'utf8');
		expect(packager).toContain("depends: 'treeseed-manager'");
		expect(packager).not.toContain('treeseed-manager (>= ${deploymentVersion})');
		expect(packager).not.toContain('treeseed-manager (= ${deploymentVersion})');
	});
});
