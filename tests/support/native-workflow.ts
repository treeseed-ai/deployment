import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

/** Inspect the actual local preparation action as part of its calling workflow. */
export function nativeWorkflow(source: string) {
  const workflow = parse(source);
  for (const job of Object.values(workflow.jobs) as { steps: { uses?: string }[] }[]) {
    job.steps = job.steps.flatMap(step => step.uses === './.github/actions/prepare-reviewer'
      ? parse(readFileSync(new URL('../../.github/actions/prepare-reviewer/action.yml', import.meta.url), 'utf8')).runs.steps
      : [step]);
  }
  return workflow;
}
