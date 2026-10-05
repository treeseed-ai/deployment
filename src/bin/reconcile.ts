import { reconcile } from '../manager/reconcile.js';
import { reconcileFailurePolicy } from '../manager/serialized-reconcile.js';
import { stageHostConfiguration, startHostWorkloads, stopHostWorkloads } from '../manager/host-lifecycle.js';
import { hostConfigurationSchema } from '@treeseed/sdk/deployment';

const hostAction = process.argv.find(value => value.startsWith('--host-action='))?.slice('--host-action='.length);
if (hostAction !== undefined) {
	if (hostAction !== 'start' && hostAction !== 'stop' && hostAction !== 'stage') throw new Error('Host action must be start, stop, or stage.');
	if (process.argv.some(value => value.startsWith('--track=') || value.startsWith('--components=') || value === '--force-metadata'))
		throw new Error('Host lifecycle cannot be combined with component reconciliation options.');
	let result;
	if (hostAction === 'stage') {
		let input = '';
		process.stdin.setEncoding('utf8');
		for await (const chunk of process.stdin) {
			input += chunk;
			if (Buffer.byteLength(input, 'utf8') > 1_100_000) throw new Error('Host configuration payload exceeds the allowed size.');
		}
		result = await stageHostConfiguration(hostConfigurationSchema.parse(JSON.parse(input) as unknown));
	} else result = hostAction === 'start' ? await startHostWorkloads() : await stopHostWorkloads();
	process.stdout.write(`${JSON.stringify(result)}\n`);
} else {

const argument = process.argv.find((value) => value.startsWith('--track='));
const track = argument?.slice('--track='.length);
if (track !== undefined && track !== 'stable' && track !== 'development') throw new Error('Track must be stable or development.');
const componentsArgument = process.argv.find((value) => value.startsWith('--components='));
const componentIds = componentsArgument?.slice('--components='.length).split(',').filter(Boolean) ?? [];
if (!componentIds.every((value) => /^[a-z][a-z0-9.-]{1,63}$/u.test(value))) throw new Error('Component scope is invalid.');
const failurePolicy = reconcileFailurePolicy(process.argv.find(value => value.startsWith('--failure-policy='))?.slice('--failure-policy='.length));
const receipt = await reconcile(track, process.argv.includes('--force-metadata'), componentIds, failurePolicy);
process.stdout.write(`${JSON.stringify(receipt ?? null)}\n`);
}
