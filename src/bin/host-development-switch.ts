import { execFileSync } from 'node:child_process';
import { switchHostDevelopment } from '../supervisor/host-development.js';

const action = process.argv[2], generationId = process.argv[3];
if ((action !== 'activate' && action !== 'deactivate') || !generationId) throw new Error('Host development switch requires an action and generation.');
switchHostDevelopment(action, generationId, (executable, arguments_, input) => execFileSync(executable, [...arguments_], { stdio: input === undefined ? 'inherit' : ['pipe', 'pipe', 'inherit'], ...(input === undefined ? {} : { input, encoding: 'utf8' }) }));
