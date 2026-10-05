import { expect, it } from 'vitest';
import { missingRuntimeCredentialServices } from '../src/supervisor/runtime-credential-inputs.js';

const manager = { environment: { TREESEED_PROVIDER_CREDENTIAL_KEK_FILE: '/run/credentials/credentials' },
	volumes: [{ type: 'bind', source: '/run/treeseed/component-credentials/agent', target: '/run/credentials' }] };
it('detects a missing boot-time credential even when its directory and process exist', () => {
	const paths: string[] = [];
	expect(missingRuntimeCredentialServices({ manager }, path => { paths.push(path); return false; })).toEqual(['manager']);
	expect(paths).toEqual(['/run/treeseed/component-credentials/agent/credentials']);
	expect(missingRuntimeCredentialServices({ manager }, () => true)).toEqual([]);
});
it('does not inspect credential values, unrelated files or unmanaged mounts', () => {
	const service = { environment: { SECRET_VALUE: 'private', OPTIONAL_FILE: '/run/credentials/optional' }, volumes: manager.volumes };
	const unexpected = () => { throw new Error('unexpected file read'); };
	expect(missingRuntimeCredentialServices({ service }, unexpected)).toEqual([]);
	expect(missingRuntimeCredentialServices({ manager: { ...manager, volumes: [{ type: 'volume', source: 'external', target: '/run/credentials' }] } }, unexpected)).toEqual([]);
});
