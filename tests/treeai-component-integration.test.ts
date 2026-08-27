import { readFileSync } from 'node:fs';
import { integrationReleaseSchema } from '@treeseed/sdk/deployment';
import { describe, expect, it } from 'vitest';

const expected = {
	'ai-inference': ['8021c7e408e0c9233758e912465f3c41a11bb6979bafdadd700a330bff142fab', '23b3098dce0704fc2290f876a2ea21d2fec37e6bdf73df4ee23a8aebfeb1c5bd'],
	'ai-training': ['d851f19d4d43126a76adb0e97e1c67e5d6d694fdfe047e317445dd0b13080c32', '33e300687adc7b3be1fec96b67a29094e2a96997c3a944d4cb4b02a7ba761455'],
	'ai-lab': ['089d2f8a23b3195918f7e5e5720f33d8dbe4a4b5b1fe0e50f5726651dacf8c6c', 'd0248e8c2b053fe7555cfee88cce96426c5b39d324e17160b54ecc81a1e465ee'],
} as const;

describe('TreeAI component custody', () => {
	it('accepts the three exact independently published component selections', () => {
		const lock = integrationReleaseSchema.parse(JSON.parse(readFileSync('tests/integration-locks/development.json', 'utf8')));
		const selected = new Map(lock.components.map((component) => [component.componentId, component]));
		for (const [componentId, [manifestSha256, composeSha256]] of Object.entries(expected)) {
			const component = selected.get(componentId);
			expect(component?.release).toBe('0.11.0~rc4-1');
			expect(component?.manifest.sha256).toBe(manifestSha256);
			expect(component?.files).toHaveLength(1);
			expect(component?.files[0]?.artifact.sha256).toBe(composeSha256);
			expect(component?.manifest.url).toMatch(/^https:\/\/github\.com\/treeseed-ai\/ai\/releases\/download\/0\.11\.0-rc4\//u);
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
