import { readFileSync } from 'node:fs';
import { integrationReleaseSchema } from '@treeseed/sdk/deployment';
import { describe, expect, it } from 'vitest';

const expected = {
	'ai-inference': ['6537a314a3d90147988d7393675bfc254bf5b5639f7e7ab57092ae88455da2e0', '101257f93e89f8cc6a1d9c65e11269990a06adc4733f4515c90a2527f929756c'],
	'ai-training': ['9d293d087a7a38f2d80efc1f8fdd13e38849e78dcfa2fe986658b39c40161bfe', '440ac53d4f3b91dc443e4e5e7bdaa958c504c758661de7d73a0b63e8fd4294e8'],
	'ai-lab': ['042dce565a244be9d7efac7f55e4acf7e3722ec7285e32495c40504cef9ef88c', '8211ec5612a84ae55eae066442fdbbe903fd822f9b6e6f6b60905b0fd02e49b5'],
} as const;

describe('TreeAI component custody', () => {
	it('accepts the three exact independently published component selections', () => {
		const lock = integrationReleaseSchema.parse(JSON.parse(readFileSync('tests/integration-locks/development.json', 'utf8')));
		const selected = new Map(lock.components.map((component) => [component.componentId, component]));
		for (const [componentId, [manifestSha256, composeSha256]] of Object.entries(expected)) {
			const component = selected.get(componentId);
			expect(component?.release).toBe('0.11.0~rc24-1');
			expect(component?.manifest.sha256).toBe(manifestSha256);
			expect(component?.files).toHaveLength(1);
			expect(component?.files[0]?.artifact.sha256).toBe(composeSha256);
			expect(component?.manifest.url).toMatch(/^https:\/\/github\.com\/treeseed-ai\/ai\/releases\/download\/0\.11\.0-rc24\//u);
		}
	});

	it('keeps ingestion and Debian compilation component-generic', () => {
		for (const path of ['scripts/fetch-artifacts.ts', 'scripts/prepare-artifacts.ts', 'scripts/package-deb.ts', 'src/manager/reconcile.ts']) {
			const source = readFileSync(path, 'utf8');
			expect(source).not.toMatch(/ai-inference|ai-training|ai-lab|treeseed-ai\/ai/u);
		}
		const packager = readFileSync('scripts/package-deb.ts', 'utf8');
		expect(packager).toContain('componentDefinitions(packageIntegration)');
		expect(packager).toContain('cpSync(source, resolve(stage, `usr/share/treeseed/components/${id}/${release}`)');
	});

	it('does not build or publish TreeAI images from Deployment', () => {
		const workflow = readFileSync('.github/workflows/publish.yml', 'utf8');
		expect(workflow).not.toMatch(/treeseed\/(?:inference|training|lab-|hermes|axolotl|marker|artifact)[^/\s]*[:@]/u);
		expect(workflow).not.toContain('treeseed-ai/ai');
	});
});
