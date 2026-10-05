import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exactPackagesForRefresh } from '../src/supervisor/apt-helper.js';

describe('exact APT generation selection', () => {
	it('pins the development overlay and its exact stable-base dependency', () => {
		const versions: Record<string, string> = {
			'treeseed-release-catalog-development/development': 'Package: treeseed-release-catalog-development\nVersion: 0.1.0~rc121-1\nDepends: treeseed-release-catalog (= 0.1.0-29)\n',
			'treeseed-host-runtime/development': 'Package: treeseed-host-runtime\nVersion: 0.1.0~rc121-1\n',
			'treeseed-kata-runtime/development': 'Package: treeseed-kata-runtime\nVersion: 0.1.0~rc121-1\n',
			'treeseed-manager/development': 'Package: treeseed-manager\nVersion: 0.1.0~rc121-1\n',
			'treeseed-sdk/development': 'Package: treeseed-sdk\nVersion: 0.13.0~rc52-1\n',
			'treeseed-cli/development': 'Package: treeseed-cli\nVersion: 0.13.0~rc30-2+deployment0.1.0~rc121\n',
			'treeseed-edge/development': 'Package: treeseed-edge\nVersion: 0.1.0~rc121-1\n',
		};
		expect(exactPackagesForRefresh('development', { 'treeseed-edge': '0.1.0~rc121-1' }, (selector) => versions[selector]!)).toEqual([
			'treeseed-release-catalog=0.1.0-29',
			'treeseed-release-catalog-development=0.1.0~rc121-1',
			'treeseed-host-runtime=0.1.0~rc121-1',
			'treeseed-kata-runtime=0.1.0~rc121-1',
			'treeseed-manager=0.1.0~rc121-1',
			'treeseed-sdk=0.13.0~rc52-1',
			'treeseed-cli=0.13.0~rc30-2+deployment0.1.0~rc121',
			'treeseed-edge=0.1.0~rc121-1',
		]);
	});

	it('upgrades the manager and its exact Kata runtime in one transaction', () => {
		const versions: Record<string, string> = {
			'treeseed-release-catalog-development/development': 'Package: treeseed-release-catalog-development\nVersion: 0.1.0~rc160-1\nDepends: treeseed-release-catalog (= 0.1.0-29)\n',
			'treeseed-host-runtime/development': 'Package: treeseed-host-runtime\nVersion: 0.1.0~rc160-1\n',
			'treeseed-kata-runtime/development': 'Package: treeseed-kata-runtime\nVersion: 0.1.0~rc160-1\n',
			'treeseed-manager/development': 'Package: treeseed-manager\nVersion: 0.1.0~rc160-1\nDepends: treeseed-host-runtime (= 0.1.0~rc160-1), treeseed-kata-runtime (= 0.1.0~rc160-1)\n',
			'treeseed-sdk/development': 'Package: treeseed-sdk\nVersion: 0.13.0~rc57-1\n',
			'treeseed-cli/development': 'Package: treeseed-cli\nVersion: 0.13.0~rc34-2+deployment0.1.0~rc160\n',
			'treeseed-edge/development': 'Package: treeseed-edge\nVersion: 0.1.0~rc160-1\n',
		};
		const selected = exactPackagesForRefresh('development', {
			'treeseed-host-runtime': '0.1.0~rc137-1',
			'treeseed-kata-runtime': '0.1.0~rc137-1',
			'treeseed-manager': '0.1.0~rc137-1',
			'treeseed-sdk': '0.13.0~rc55-1',
			'treeseed-cli': '0.13.0~rc30-2+deployment0.1.0~rc137',
			'treeseed-edge': '0.1.0~rc137-1',
		}, (selector) => versions[selector]!);
		expect(selected).toContain('treeseed-manager=0.1.0~rc160-1');
		expect(selected).toContain('treeseed-kata-runtime=0.1.0~rc160-1');
		expect(selected.indexOf('treeseed-kata-runtime=0.1.0~rc160-1')).toBeLessThan(selected.indexOf('treeseed-manager=0.1.0~rc160-1'));
	});

	it('installs the Kata runtime explicitly during clean bootstrap', () => {
		const bootstrap = readFileSync(resolve(process.cwd(), 'scripts/bootstrap/bootstrap.sh'), 'utf8');
		expect(bootstrap).toContain("packages='treeseed-host-runtime treeseed-kata-runtime");
	});

	it('rejects a development overlay without an exact stable-base dependency', () => {
		expect(() => exactPackagesForRefresh('development', {}, () => 'Package: treeseed-release-catalog-development\nVersion: 1\nDepends: treeseed-release-catalog (>= 1)\n')).toThrow(/exact stable catalog/u);
	});
});
