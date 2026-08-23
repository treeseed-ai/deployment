import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Debian and systemd contracts', () => {
	it('ships independent stable and development schedulers', () => {
		const stable = readFileSync('systemd/treeseed-manager-stable.timer', 'utf8');
		const development = readFileSync('systemd/treeseed-manager-development.timer', 'utf8');
		expect(stable).toContain('OnCalendar=*-*-* 03:00:00');
		expect(stable).toContain('RandomizedDelaySec=30m');
		expect(development).toContain('OnUnitInactiveSec=60s');
	});

	it('sandboxes the manager and exposes only the fixed supervisor as root', () => {
		const units = readdirSync('systemd').filter((name) => name.endsWith('.service'));
		const supervisor = readFileSync('systemd/treeseed-manager-supervisor.service', 'utf8');
		expect(supervisor).toContain('ProtectSystem=strict');
		for (const unit of units.filter((name) => name.startsWith('treeseed-manager-') && !['treeseed-manager-supervisor.service', 'treeseed-manager-apt-helper.service'].includes(name))) {
			const value = readFileSync(`systemd/${unit}`, 'utf8');
			expect(value).toContain('User=treeseed-manager');
			expect(value).toContain('NoNewPrivileges=yes');
		}
		const aptHelper = readFileSync('systemd/treeseed-manager-apt-helper.service', 'utf8');
		expect(aptHelper).toContain('Type=oneshot');
		expect(aptHelper).toContain('ProtectSystem=false');
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
	});

	it('runs the only host edge inside the shared Docker network', () => {
		const compose = readFileSync('deploy/edge/compose.yml', 'utf8');
		const unit = readFileSync('systemd/treeseed-edge.service', 'utf8');
		const supervisor = readFileSync('src/supervisor/execute.ts', 'utf8');
		expect(compose).toContain('caddy:2.10.2-alpine@sha256:');
		expect(compose).toContain('name: treeseed-edge');
		expect(compose).toContain('/run/treeseed/manager:/run/treeseed/manager:ro');
		expect(unit).toContain('docker compose --file /usr/share/treeseed/edge/compose.yml');
		expect(unit).not.toContain('/usr/bin/caddy');
		expect(supervisor).toContain("'/usr/share/treeseed/edge/compose.yml'");
		expect(supervisor).toContain("'validate'");
	});

	it('documents configured-package credential consumption and deletion', () => {
		const generator = readFileSync('scripts/configure-bootstrap.ts', 'utf8');
		const postinstall = readFileSync('scripts/bootstrap/bootstrap.sh', 'utf8');
		expect(generator).toContain('--consume-credentials');
		expect(generator).toContain('unlinkSync(resolve(credentialsPath))');
		expect(generator).not.toContain('console.log(credentials');
		expect(generator).toContain('containsPlaintextBootstrapCredentials: credentials !== undefined');
		expect(postinstall).toContain('rm -f "$state/seed/credentials.json"');
		expect(postinstall).toContain('/etc/treeseed/credentials/$secret_id');
		expect(postinstall).toContain('securely delete the downloaded configured .deb');
	});

	it('locks every external component and host payload by SHA-256', () => {
		const lock = JSON.parse(readFileSync('release/artifacts.lock.json', 'utf8')) as { schemaVersion: string; artifacts: Array<{ id: string; url: string; sha256: string; target: string }> };
		expect(lock.schemaVersion).toBe('treeseed.deployment-artifacts/v1');
		expect(new Set(lock.artifacts.map((artifact) => artifact.id)).size).toBe(lock.artifacts.length);
		for (const artifact of lock.artifacts) {
			expect(artifact.url).toMatch(/^https:\/\/(?:github\.com|registry\.npmjs\.org)\//u);
			expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
			expect(artifact.target).not.toContain('..');
		}
	});

	it('lets the manager choose exact component versions and supports governed rollback', () => {
		const bootstrap = readFileSync('scripts/bootstrap/bootstrap.sh', 'utf8');
		const helper = readFileSync('src/supervisor/apt-helper.ts', 'utf8');
		expect(bootstrap).not.toContain('treeseed-component-$component');
		expect(helper).toContain("'--allow-downgrades'");
		expect(helper).toContain("'DPkg::Lock::Timeout=600'");
		expect(helper).toContain("'--no-remove'");
	});
});
