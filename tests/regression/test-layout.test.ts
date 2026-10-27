import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {TestLayout} from '../../.agents/skills/release-workflow/scripts/test-layout.js';
class TestLayoutRegression {
 private check(path:string,source:string):string[]{const root=mkdtempSync(join(tmpdir(),'test-layout-'));try{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),source);return new TestLayout().inspect(root);}finally{rmSync(root,{recursive:true,force:true});}}
 valid():void{for(const tier of ['acceptance','regression','integration','unit'])expect(this.check('tests/'+tier+'/provider-selection.test.ts',"import {test} from 'bun:test';class Cases {run():void{}}const suite=new Cases();test('case',suite.run.bind(suite));")).toEqual([]);}
 misplaced():void{for(const path of ['tests/flat.test.ts','src/provider.test.ts','tests/support/hidden.ts','tests/unit/hidden.ts'])expect(this.check(path,"import {test as scenario} from 'bun:test';class Cases {run():void{}}const suite=new Cases();scenario('case',suite.run.bind(suite));").length).toBeGreaterThan(0);}
 phases():void{for(const name of ['task3d-agent','phase-4-provider','task-3c'])expect(this.check('tests/unit/'+name+'.test.ts',"import {test} from 'bun:test';class Cases {run():void{}}const suite=new Cases();test('case',suite.run.bind(suite));").length).toBeGreaterThan(0);}
 discovery():void{const root=mkdtempSync(join(tmpdir(),'test-discovery-'));try{
  mkdirSync(join(root,'tests/unit'),{recursive:true});writeFileSync(join(root,'tests/unit/value.test.ts'),"import {test} from 'bun:test';class Cases {run():void{}}const suite=new Cases();test('case',suite.run.bind(suite));");
  const scripts:Record<string,string>={};for(const tier of ['acceptance','regression','integration','unit'])scripts['test:'+tier]='bun test ./tests/'+tier;
  for(const command of ['bun test ./tests/unit','bun test tests/unit/ --timeout 30000','bun test ./tests/unit --pass-with-no-tests']){scripts['test:unit']=command;writeFileSync(join(root,'package.json'),JSON.stringify({scripts}));expect(new TestLayout().inspect(root)).toEqual([]);}
  for(const command of ['bun test ./tests --test-name-pattern ^unit:','bun test ./tests/unit/only-one.test.ts','echo tests/unit && bun test ./tests/unit/only-one.test.ts','bun test ./tests/unit --test-name-pattern selected','bun test ./tests/unit ./tests/acceptance/one.test.ts']){scripts['test:unit']=command;writeFileSync(join(root,'package.json'),JSON.stringify({scripts}));expect(new TestLayout().inspect(root).length).toBeGreaterThan(0);}
 }finally{rmSync(root,{recursive:true,force:true});}}
 private matrix(root:string,patterns:string[]):void{let source='jobs:\n  programs:\n    strategy:\n      matrix:\n        include:\n';for(const pattern of patterns)source+='          - pattern: '+JSON.stringify(pattern)+'\n';source+='    steps:\n      - run: bun test ./tests --test-name-pattern "${{ matrix.pattern }}"\n';writeFileSync(join(root,'.github/workflows/verify.yml'),source);}
 partitions():void{const root=mkdtempSync(join(tmpdir(),'test-partitions-'));try{
  mkdirSync(join(root,'tests/unit'),{recursive:true});mkdirSync(join(root,'.github/workflows'),{recursive:true});writeFileSync(join(root,'tests/unit/value.test.ts'),"import {test} from 'bun:test';class Cases {run():void{}}const suite=new Cases();test('case',suite.run.bind(suite));");
  const scripts:Record<string,string>={};for(const tier of ['acceptance','regression','integration','unit'])scripts['test:'+tier]='bun test ./tests/'+tier;writeFileSync(join(root,'package.json'),JSON.stringify({scripts}));
  this.matrix(root,['^case$']);expect(new TestLayout().inspect(root)).toEqual([]);
  for(const patterns of [['^different$'],['^case$','^case$'],['^case$','^unused$'],['['],[]]){this.matrix(root,patterns);expect(new TestLayout().inspect(root).length).toBeGreaterThan(0);}
 }finally{rmSync(root,{recursive:true,force:true});}}
 support():void{expect(this.check('tests/support/provider.ts','export class Fixture {run():void{}}')).toEqual([]);expect(this.check('tests/support/hidden.ts',"import * as cases from 'node:test';class Cases {run():void{}}const suite=new Cases();cases.test('case',suite.run.bind(suite));").length).toBeGreaterThan(0);}
}
const suite=new TestLayoutRegression();
test('regression: every required test tier accepts capability names',suite.valid.bind(suite));
test('regression: misplaced and aliased hidden test registrations fail layout verification',suite.misplaced.bind(suite));
test('regression: task and phase filenames cannot become permanent suites',suite.phases.bind(suite));
test('regression: shared fixture classes are permitted without hidden namespace tests',suite.support.bind(suite));
test('regression: tier commands cannot silently omit files through name filters',suite.discovery.bind(suite));
test('regression: CI name partitions are exhaustive disjoint nonempty and valid',suite.partitions.bind(suite));
