import * as runtime from '@treeseed/deployment';
import type { copyDevelopmentRuntime } from '../../src/supervisor/development-runtime-copy.js';

const materialize: typeof copyDevelopmentRuntime = Reflect.get(runtime, 'copyDevelopmentRuntime');
if (typeof materialize !== 'function') throw new Error('Public runtime materialization API is unavailable.');
const input: Parameters<typeof copyDevelopmentRuntime>[0] = JSON.parse(process.argv[2]!);
console.log(JSON.stringify(materialize(input)));
