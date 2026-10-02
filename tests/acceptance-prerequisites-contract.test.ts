import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

it('runs complete privileged owner prerequisites before coded scenes without a filtered substitute', () => {
  const workflow=parse(readFileSync(new URL('../.github/workflows/verify.yml',import.meta.url),'utf8'));
  const steps=workflow.jobs.verify.steps as {name?:string;run?:string;env?:Record<string,string>;uses?:string;with?:Record<string,string>}[];
  const scene=steps.find(step=>step.name==='Execute coded sandbox component scenes');
  expect(scene?.run).toContain('sudo --preserve-env=');
  expect(scene?.run).toContain('src/verifiers/guarantees/command.ts');
  expect(scene?.env?.TREESEED_PRIVILEGED_CACHE_TESTS).toBe('1');
  expect(scene?.run).not.toContain('source-cache-volume.integration.test.ts');
  expect(steps.some(step=>step.uses?.startsWith('actions/checkout@')&&step.with?.repository==='treeseed-ai/reviewer'&&
    /^[a-f0-9]{40}$/u.test(step.with.ref??'')&&step.with.path==='.treeseed/tools/reviewer')).toBe(true);
  expect(steps.some(step=>step.name==='Retain coded scene evidence'&&step.with?.['if-no-files-found']==='error')).toBe(true);
});
