import { resetAndReconcile } from '../manager/reset.js';

const receipt = await resetAndReconcile();
process.stdout.write(`${JSON.stringify(receipt ?? null)}\n`);
