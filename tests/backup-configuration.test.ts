import { deploymentDigest } from '@treeseed/sdk/deployment';
import { expect, it } from 'vitest';
import { selectBackupConfiguration } from '../src/supervisor/backup-configuration.js';
import { host } from './fixtures.js';

it('captures the accepted configuration rather than the proposed replacement', () => {
	const accepted = host(), proposed = {...accepted,generation:accepted.generation+1};
	const receipt = {configurationDigest:deploymentDigest(accepted)};
	expect(selectBackupConfiguration(proposed, receipt, accepted)).toEqual(accepted);
	expect(selectBackupConfiguration(accepted, receipt)).toEqual(accepted);
	expect(() => selectBackupConfiguration(proposed, receipt)).toThrow(/does not match/);
	expect(() => selectBackupConfiguration(proposed, receipt, proposed)).toThrow(/does not match/);
});
