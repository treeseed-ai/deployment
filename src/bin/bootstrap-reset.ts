import { readFileSync, unlinkSync } from 'node:fs';
import { z } from 'zod';
import { requestSupervisor } from '../supervisor/client.js';

const path = '/var/lib/treeseed/bootstrap/seed/reset-unaccepted-components.json';
const componentIds = z.array(z.string().regex(/^[a-z][a-z0-9.-]+$/u)).min(1).max(32).parse(JSON.parse(readFileSync(path, 'utf8')));
for (const componentId of [...new Set(componentIds)].sort()) await requestSupervisor({ operation: 'component.reset-unaccepted', componentId });
unlinkSync(path);
