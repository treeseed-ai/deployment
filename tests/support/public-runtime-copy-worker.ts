import * as runtime from '@treeseed/deployment';
import type { copyDevelopmentRuntime } from '../../src/supervisor/development-runtime-copy.js';

const materialize: typeof copyDevelopmentRuntime = Reflect.get(runtime, 'copyDevelopmentRuntime');
if (typeof materialize !== 'function') throw new Error('Public runtime materialization API is unavailable.');
const input: Parameters<typeof copyDevelopmentRuntime>[0] = JSON.parse(process.argv[2]!);
if (process.argv[3] === 'provider') {
 const roots: NonNullable<Parameters<typeof copyDevelopmentRuntime>[0]['roots']> = Reflect.get(runtime, 'agentDevelopmentRuntimeRoots');
 if (!Array.isArray(roots)) throw new Error('Public provider runtime roots are unavailable.');
 input.roots = roots;
}
console.log(JSON.stringify(materialize(input)));
