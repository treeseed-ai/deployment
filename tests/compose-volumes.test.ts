import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ComponentRelease } from '@treeseed/sdk/deployment';
import { validateProductionCompose } from '../src/index.js';

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function releaseFor(source: string): { release: ComponentRelease; root: string } {
	const root = mkdtempSync(resolve(tmpdir(), 'treeseed-compose-volume-'));
	const imageDigest = digest('image');
	const compose = `services:\n  service:\n    image: treeseed/test@${imageDigest}\n    healthcheck: { test: ["CMD", "true"] }\n    volumes: ["${source}:/data:ro"]\n`;
	writeFileSync(resolve(root, 'compose.yml'), compose);
	return {
		root,
		release: {
			schemaVersion: 'treeseed.component-release/v1', componentId: 'test', version: '1.0.0',
			images: [{ id: 'service', repository: 'treeseed/test', digest: imageDigest }],
			runtime: { services: [{ id: 'service', composeService: 'service' }], compose: { files: [{ path: 'compose.yml', digest: digest(readFileSync(resolve(root, 'compose.yml'), 'utf8')) }] } }
		} as unknown as ComponentRelease
	};
}

describe('Compose volume validation', () => {
	it('accepts the fixed manager-owned data-root default expression', () => {
		const { release, root } = releaseFor('${TREESEED_COMPONENT_DATA_ROOT:-/var/lib/treeseed/components}/ai-lab/experience');
		expect(() => validateProductionCompose(release, root)).not.toThrow();
	});

	it('rejects other variable source mounts', () => {
		const { release, root } = releaseFor('${UNMANAGED_ROOT:-/tmp}/experience');
		expect(() => validateProductionCompose(release, root)).toThrow(/unrecognized variable source mount/u);
	});
});
