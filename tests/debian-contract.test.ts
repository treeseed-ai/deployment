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
		expect(compose).not.toContain('/var/run/docker.sock');
		expect(compose).not.toMatch(/^\s+ports:/mu);
		expect(compose).toContain('internal: true');
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
		expect(postinstall).toContain('securely delete the downloaded configured .deb');
	});
});
