import { reconcile } from '../manager/reconcile.js';
import { reconcileFailurePolicy } from '../manager/serialized-reconcile.js';

const argument = process.argv.find((value) => value.startsWith('--track='));
const track = argument?.slice('--track='.length);
if (track !== undefined && track !== 'stable' && track !== 'development') throw new Error('Track must be stable or development.');
const componentsArgument = process.argv.find((value) => value.startsWith('--components='));
const componentIds = componentsArgument?.slice('--components='.length).split(',').filter(Boolean) ?? [];
if (!componentIds.every((value) => /^[a-z][a-z0-9.-]{1,63}$/u.test(value))) throw new Error('Component scope is invalid.');
const failurePolicy = reconcileFailurePolicy(process.argv.find(value => value.startsWith('--failure-policy='))?.slice('--failure-policy='.length));
const receipt = await reconcile(track, process.argv.includes('--force-metadata'), componentIds, failurePolicy);
process.stdout.write(`${JSON.stringify(receipt ?? null)}\n`);
