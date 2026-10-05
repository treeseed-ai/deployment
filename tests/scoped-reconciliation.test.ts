import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serializedReconcileArguments } from '../src/index.js';

describe('scoped component reconciliation', () => {
	it('limits storage configuration activation to the API component', () => {
		expect(serializedReconcileArguments(undefined, false, ['api'])).toContain('--components=api');
		const operations = readFileSync(resolve(process.cwd(), 'src/manager/operations.ts'), 'utf8');
		expect(operations).toContain("serializedReconcile(undefined, false, ['api'])");
	});
});
