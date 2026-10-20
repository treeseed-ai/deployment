import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

/** GitHub expands this local composite; contract tests inspect the same effective steps. */
export const nativeVerificationAction = './.github/actions/verify-native';
export function expandNativeSteps<T>(steps: T[]): T[] {
	return steps.flatMap(step => {
		if ((step as { uses?: string }).uses !== nativeVerificationAction) return [step];
		const action = parse(readFileSync('.github/actions/verify-native/action.yml', 'utf8'));
		assert.equal(action.runs.using, 'composite'); assert(Array.isArray(action.runs.steps));
		return action.runs.steps as T[];
	});
}
