import { restoreManagedGeneration, retryManagedRecovery } from '../manager/recovery.js';

const arguments_ = process.argv.slice(2);
if (arguments_.length !== 1 || (arguments_[0] !== '--retry' && !/^--generation=[1-9][0-9]*$/u.test(arguments_[0]!))) throw new Error('One exact recovery generation or retry is required.');
if (arguments_[0] === '--retry') {
	process.stdout.write(`${JSON.stringify(await retryManagedRecovery())}\n`);
} else {
const generation = Number(arguments_[0]!.slice('--generation='.length));
if (!Number.isSafeInteger(generation)) throw new Error('Recovery generation is invalid.');
process.stdout.write(`${JSON.stringify(await restoreManagedGeneration(generation))}\n`);
}
