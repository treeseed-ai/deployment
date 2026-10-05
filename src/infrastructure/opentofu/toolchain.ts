import { createHash } from 'node:crypto';

export const hostedInfrastructureToolchain = Object.freeze({
	schemaVersion: 'treeseed.hosted-infrastructure-toolchain/v1',
	opentofu: {
		version: '1.12.6',
		linuxAmd64ArchiveSha256: '50a6106fa4de523d09c87af85f3db1dd47535fc005727fdca6852146476b88ec',
		linuxArm64ArchiveSha256: '9bd0228a81bcd0c88f7045c74378f45a815779f19897191dff7d9efba9976b9e',
	},
	providers: {
		cloudflare: { source: 'registry.opentofu.org/cloudflare/cloudflare', version: '5.24.0' },
		railway: {
			source: 'registry.opentofu.org/jamesprnich/railway',
			version: '0.11.5',
			linuxAmd64ArchiveSha256: '5582ebfc34c1e99ed5b5ca30ffaef5a131c89328cfdf3fbda17f472e5290a4d5',
			linuxArm64ArchiveSha256: 'de1e58e47f93d95e2f7a88f56a6ee499f280d657c78e8b2029e4e88236682cf5',
		},
	},
} as const);

export function infrastructureDigest(value: unknown) {
	return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
