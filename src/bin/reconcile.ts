import { reconcile } from '../manager/reconcile.js';
import { reconcileFailurePolicy } from '../manager/serialized-reconcile.js';
import { startHostWorkloads, stopHostWorkloads } from '../manager/host-lifecycle.js';

const hostAction = process.argv.find(value => value.startsWith('--host-action='))?.slice('--host-action='.length);
if (hostAction !== undefined) {
	if (hostAction !== 'start' && hostAction !== 'stop') throw new Error('Host action must be start or stop.');
	if (process.argv.some(value => value.startsWith('--track=') || value.startsWith('--components=') || value === '--force-metadata'))
		throw new Error('Host lifecycle cannot be combined with component reconciliation options.');
	const result = hostAction === 'start' ? await startHostWorkloads() : await stopHostWorkloads();
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
