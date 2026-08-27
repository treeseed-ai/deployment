import { reconcile } from '../manager/reconcile.js';

const argument = process.argv.find((value) => value.startsWith('--track='));
const track = argument?.slice('--track='.length);
if (track !== undefined && track !== 'stable' && track !== 'development') throw new Error('Track must be stable or development.');
const receipt = await reconcile(track);
process.stdout.write(`${JSON.stringify(receipt ?? null)}\n`);
