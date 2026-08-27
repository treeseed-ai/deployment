import { readFileSync } from 'node:fs';
import { integrationReleaseSchema } from '@treeseed/sdk/deployment';
import { describe, expect, it } from 'vitest';

const expected = {
	'ai-inference': ['59f9bae69f7e99eb1dda9dfd2aa9cf95da0b28bb5e75241c0edbc8452028fe5a', '2e923383af24b0842519cc49daefe6825b959f8948ca1f5f962cbf3031515912'],
	'ai-training': ['21f34dcf8e055da96e09b8d492ea399899b084ef82e3a2af20dbee7e351426cf', 'b44bff124de06782163573d92c8195378070af9d240dad83e041d82411944a88'],
	'ai-lab': ['123583a503b64232edc91778e1f818f1495c60b485a7da592a1013ad16a983bd', '48b4e9b7430a0820a31dc8e75a855e7b1b05239b0341abc1ea4a15fab632cbed'],
} as const;

describe('TreeAI component custody', () => {
	it('accepts the three exact independently published component selections', () => {
		const lock = integrationReleaseSchema.parse(JSON.parse(readFileSync('tests/integration-locks/development.json', 'utf8')));
		const selected = new Map(lock.components.map((component) => [component.componentId, component]));
		for (const [componentId, [manifestSha256, composeSha256]] of Object.entries(expected)) {
			const component = selected.get(componentId);
			expect(component?.release).toBe('0.11.0~rc2-1');
			expect(component?.manifest.sha256).toBe(manifestSha256);
			expect(component?.files).toHaveLength(1);
			expect(component?.files[0]?.artifact.sha256).toBe(composeSha256);
			expect(component?.manifest.url).toMatch(/^https:\/\/github\.com\/treeseed-ai\/ai\/releases\/download\/0\.11\.0-rc2\//u);
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
