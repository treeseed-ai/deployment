import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { resolve } from 'node:path';

it('parses component metadata and binds every scene step to exactly one existing owner test',()=>{
  const root=resolve(import.meta.dirname,'..');
  const metadata=parse(readFileSync(resolve(root,'guarantees/verifiers/golden.verifiers.yaml'),'utf8'));
  const scene=parse(readFileSync(resolve(root,'guarantees/agent/golden/scenes/component-boundaries.scene.yaml'),'utf8'));
  expect(metadata.ownerPackage).toBe('@treeseed/deployment');
  const ids=new Set<string>(),references=new Set<string>();
  for(const step of scene.workflow) {
    expect(ids.has(step.id)).toBe(false);ids.add(step.id);
    expect(references.has(step.action.verifier)).toBe(false);references.add(step.action.verifier);
    const verifier=metadata.verifiers[step.action.verifier];
    expect(verifier).toMatchObject({kind:'vitestCase',ownerPackage:'@treeseed/deployment'});
    expect(existsSync(resolve(root,verifier.testFile))).toBe(true);
    expect(typeof verifier.testName).toBe('string');expect(verifier.testName.trim()).not.toBe('');
    expect(step.expect.status).toBe('passed');
  }
  expect([...references].sort()).toEqual(Object.keys(metadata.verifiers).sort());
});

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
