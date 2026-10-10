import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { expect, it, onTestFailed } from 'vitest';
import { parse } from 'yaml';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertDisposableNativeHost } from '../scripts/verify-native-host.js';

it('native denied host inspection retains its exact safe phase before resource startup without inventing a passing observation',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'host-inspection-denied-phase-'));
 try {
  const testFile=resolve(root,'denied.test.ts'),reportFile=resolve(root,'report.json');
  writeFileSync(testFile,`import ${JSON.stringify(resolve('tests/sandbox-host-inspection-native.test.ts'))};\n`);
  writeFileSync(resolve(root,'vitest.config.ts'),`export default {test:{include:[${JSON.stringify(testFile)}]}};`);
  const actual=spawnSync(process.execPath,[resolve('node_modules/vitest/vitest.mjs'),'run','--config',resolve(root,'vitest.config.ts'),
   '--reporter=json','--outputFile='+reportFile],{cwd:process.cwd(),env:{...process.env,TREESEED_PRIVILEGED_CACHE_TESTS:'0'},encoding:'utf8',timeout:10_000});
  expect(actual.error).toBeUndefined();expect(actual.signal).toBeNull();expect(actual.status).toBe(1);
  const report=JSON.parse(readFileSync(reportFile,'utf8')) as {numTotalTests:number;numFailedTests:number;numPendingTests:number;numTodoTests:number;
   testResults:{assertionResults:{status:string;failureMessages:string[]}[]}[]};
  expect(report).toMatchObject({numTotalTests:1,numFailedTests:1,numPendingTests:0,numTodoTests:0});
  const rows=report.testResults.flatMap(file=>file.assertionResults);expect(rows).toHaveLength(1);expect(rows[0]!.status).toBe('failed');
  expect(rows[0]!.failureMessages.join('\n')).toContain('Disposable privileged owning-host authorization required');
  expect(rows[0]!.failureMessages.join('\n')).toContain('ACCEPTANCE_HOST_INSPECTION_HOST_AUTHORITY:');
 } finally {rmSync(root,{recursive:true,force:true});expect(existsSync(root)).toBe(false);}
});

it('native development image preparation holds one exact official manifest before timed suites and verifies local image readback',()=>{
 const path='.github/workflows/verify.yml',bytes=readFileSync(path);
 const steps=parse(bytes.toString()).jobs.verify.steps as {name?:string;run?:string}[];
 const preparation=steps.find(step=>step.name==='Prepare native development image before timed tests')!.run!;
 const payload=preparation.split("--eval '\n")[1]!.replace(/\n\s*'\s*$/u,'');
 expect(payload).not.toContain("'");
 const commands=preparation.replaceAll('"',"'");
 expect(preparation).toContain('mirror.gcr.io/library/node@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd');
 expect(commands).toContain("docker(['pull','--quiet',image])");
 expect(commands).toContain("docker(['image','inspect',image,'--format','{{.Id}}'])");
 expect(commands).toContain("docker(['tag',image,'node:24-bookworm-slim'])");
 expect(preparation).toContain('resolved!==expected');
 expect(steps.indexOf(steps.find(step=>step.name==='Prepare native development image before timed tests')!)).toBeLessThan(steps.findIndex(step=>step.run?.includes('npm run verify:direct')));
 expect(readFileSync(path)).toEqual(bytes);
});

it('native backup image preparation preserves the owning PostgreSQL digest through fixed mirror acquisition and local readback',()=>{
 const path='tests/identity-runtime/development-backup.ts',bytes=readFileSync(path);
 const source=bytes.toString();
 expect(source).toContain("import { POSTGRES_IMAGE } from '../../dist/src/postgres/compose.js'");
 expect(source).toContain("POSTGRES_IMAGE.replace(/^postgres:/u, 'mirror.gcr.io/library/postgres:')");
 expect(source).toContain("docker(['pull', '--quiet', mirror])");
 expect(source).toContain("docker(['image', 'inspect', mirror, '--format', '{{.Id}}'])");
 expect(source).toContain("assert.match(image, /^sha256:[a-f0-9]{64}$/u)");
 expect(source).not.toContain("docker(['pull', '--quiet', POSTGRES_IMAGE])");
 expect(readFileSync(path)).toEqual(bytes);
});

it('capacity manager owns one persistent bounded writeback policy without prewarming or flushing the cold path', () => {
  const policy=readFileSync('deploy/capacity/writeback.conf','utf8');
  expect(policy.split('\n').filter(line=>line&&!line.startsWith('#'))).toEqual([
    'vm.dirty_background_bytes = 16777216','vm.dirty_bytes = 67108864',
  ]);
  const packaging=readFileSync('scripts/package-deb.ts','utf8');
  expect(packaging.match(/install\('deploy\/capacity\/writeback\.conf', resolve\(stage, 'usr\/lib\/sysctl\.d\/70-treeseed-capacity-writeback\.conf'\)\)/gu)).toHaveLength(1);
  const postinstall=readFileSync('debian/manager/postinst','utf8');
  expect(postinstall.match(/\/usr\/sbin\/sysctl --load \/usr\/lib\/sysctl\.d\/70-treeseed-capacity-writeback\.conf/gu)).toHaveLength(1);
  expect(postinstall).not.toMatch(/drop_caches|dirty_expire|dirty_writeback|\bsync\b/u);
  expect(policy).not.toMatch(/ratio|volatile|drop_caches/u);
});

it('native original Vitest retains controlled phase criteria alongside real assertion and watchdog failures without widening the test allowance', () => {
  const root=mkdtempSync(resolve(tmpdir(),'deployment-native-failure-'));
  try {
    symlinkSync(resolve('node_modules'),resolve(root,'node_modules'),'dir');
    writeFileSync(resolve(root,'vitest.config.ts'),"export default {test:{include:['phase.test.ts']}};\n");
    writeFileSync(resolve(root,'phase.test.ts'),[
      "import {it,onTestFailed} from 'vitest';",
      "it('actual native failure',({signal})=>{onTestFailed(()=>{throw new Error('ACCEPTANCE_NATIVE_COLD_VERIFY_'+(signal.aborted?'WATCHDOG':'FAILURE')+': controlled');});throw new Error('original native failure');});",
      "it('actual watchdog failure',async({signal})=>{onTestFailed(()=>{throw new Error('ACCEPTANCE_NATIVE_COLD_BUILD_'+(signal.aborted?'WATCHDOG':'FAILURE')+': controlled');});await new Promise(()=>{});},20);",
    ].join('\n'));
    const actual=spawnSync(process.execPath,[resolve('node_modules/vitest/vitest.mjs'),'run','--config',resolve(root,'vitest.config.ts'),
      '--reporter=json','--outputFile='+resolve(root,'report.json')],{cwd:root,encoding:'utf8',timeout:10_000});
    expect(actual.error).toBeUndefined();expect(actual.signal).toBeNull();expect(actual.status).toBe(1);
    const report=JSON.parse(readFileSync(resolve(root,'report.json'),'utf8')) as {numTotalTests:number;numFailedTests:number;numPendingTests:number;numTodoTests:number;
      testResults:{assertionResults:{title:string;status:string;duration:number;failureMessages:string[]}[]}[]};
    expect(report.numTotalTests).toBe(2);expect(report.numFailedTests).toBe(2);expect(report.numPendingTests).toBe(0);expect(report.numTodoTests).toBe(0);
    const rows=report.testResults.flatMap(file=>file.assertionResults);expect(rows.map(row=>row.status)).toEqual(['failed','failed']);
    expect(rows[0]?.failureMessages.join('\n')).toContain('original native failure');
    expect(rows[0]?.failureMessages.join('\n')).toContain('ACCEPTANCE_NATIVE_COLD_VERIFY_FAILURE:');
    // This pinned Vitest JSON reporter retains the watchdog's stack-trace error,
    // not the human-readable timeout text. The unresolved callback cannot pass.
    expect(rows[1]?.failureMessages.join('\n')).toContain('Error: STACK_TRACE_ERROR');
    expect(rows[1]?.duration).toBeGreaterThanOrEqual(20);
    expect(rows[1]?.failureMessages.join('\n')).toContain('ACCEPTANCE_NATIVE_COLD_BUILD_WATCHDOG:');
    const workflow=parse(readFileSync(new URL('../.github/workflows/verify.yml',import.meta.url),'utf8'));
    const steps=workflow.jobs.verify.steps as {with?:Record<string,string>}[];
    const checkout=steps.find(step=>step.with?.repository==='treeseed-ai/reviewer')!.with!;
    const reviewer=resolve(checkout.path!);
    const head=spawnSync('git',['-C',reviewer,'rev-parse','HEAD'],{encoding:'utf8',timeout:5000});
    expect(head.status).toBe(0);expect(head.stdout.trim()).toBe(checkout.ref);
    const bytes=readFileSync(resolve(root,'report.json'));
    const consumed=spawnSync(process.execPath,['--import','tsx','--input-type=module','--eval',
      "import {readFileSync} from 'node:fs';const {fullSuiteFailures}=await import(process.argv[1]);console.log(JSON.stringify(fullSuiteFailures(JSON.parse(readFileSync(process.argv[2],'utf8')))));",
      pathToFileURL(resolve(reviewer,'src/verifiers/guarantees/prerequisites.ts')).href,resolve(root,'report.json')],
      {encoding:'utf8',timeout:10_000});
    expect(consumed.error).toBeUndefined();expect(consumed.signal).toBeNull();expect(consumed.status).toBe(0);
    expect(JSON.parse(consumed.stdout)).toEqual([
      {title:'actual native failure',status:'failed',criterion:'ACCEPTANCE_NATIVE_COLD_VERIFY_FAILURE'},
      {title:'actual watchdog failure',status:'failed',criterion:'ACCEPTANCE_NATIVE_COLD_BUILD_WATCHDOG'},
    ]);
    expect(readFileSync(resolve(root,'report.json'))).toEqual(bytes);
  } finally {rmSync(root,{recursive:true,force:true});expect(existsSync(root)).toBe(false);}
});

it('native pinned Reviewer retains bounded owning failure evidence after fresh complete prerequisites without exposing assertion values', () => {
  const workflow=parse(readFileSync('.github/workflows/verify.yml','utf8'));
  const checkout=(workflow.jobs.verify.steps as {with?:Record<string,string>}[])
    .find(step=>step.with?.repository==='treeseed-ai/reviewer')!.with!;
  const reviewer=resolve(checkout.path!),heldHead=spawnSync('git',['-C',reviewer,'rev-parse','HEAD'],{encoding:'utf8',timeout:5000});
  expect(heldHead.status).toBe(0);expect(heldHead.stdout.trim()).toBe(checkout.ref);
  const root=mkdtempSync(resolve(tmpdir(),'deployment-native-evidence-'));
  try {
    for(const path of ['tests','guarantees/verifiers','.treeseed','node_modules/vitest'])mkdirSync(resolve(root,path),{recursive:true});
    cpSync(resolve('node_modules/vitest/vitest.mjs'),resolve(root,'node_modules/vitest/vitest.mjs'));
    symlinkSync(resolve('node_modules/vitest/dist'),resolve(root,'node_modules/vitest/dist'),'dir');
    const files=new Map<string,string>([
      ['.gitignore','node_modules\n.treeseed\n'],
      // The single file already owns the complete two-case suite in one
      // isolated worker; no custom config needs bundling on six invocations.
      ['package.json',JSON.stringify({name:'@fixture/native-evidence',type:'module',scripts:{test:'vitest run'}})],
      ['treeseed.package.yaml',JSON.stringify({development:{project:{id:'native-evidence'},targets:[{id:'runtime',dependencies:[]}]}})],
      ['source.txt',' exact native evidence é\n'],
      ['tests/integration.test.ts',[
        "import {it,expect} from 'vitest';import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';",
        "it('exact native source',()=>{expect(readFileSync('source.txt','utf8')).toBe(' exact native evidence é\\n');appendFileSync('.treeseed/observations','unit\\n');});",
        "it('actual controlled native failure',()=>{",
        " const prior=existsSync('.treeseed/native-count')?Number(readFileSync('.treeseed/native-count','utf8')):0;writeFileSync('.treeseed/native-count',String(prior+1));appendFileSync('.treeseed/observations','native\\n');",
        " if(prior>0&&existsSync('.treeseed/fail-selected'))throw new Error('ACCEPTANCE_NATIVE_EVIDENCE: controlled-private-value');",
        " const bytes=readFileSync('source.txt');writeFileSync('.treeseed/readback',bytes);expect(readFileSync('.treeseed/readback')).toEqual(bytes);",
        '});','',
      ].join('\n')],
      ['guarantees/proof.guarantee.yaml',JSON.stringify({id:'proof',ownerPackage:'@fixture/native-evidence',scene:{required:true,manifest:'guarantees/proof.scene.yaml'}})],
      ['guarantees/proof.scene.yaml',JSON.stringify({scope:'local-component-tests',workflow:['proof.unit','proof.native'].map(ref=>({id:ref,action:{verifier:ref},expect:{status:'passed'}}))})],
      ['guarantees/verifiers/proof.verifiers.yaml',JSON.stringify({verifiers:{
        'proof.unit':{kind:'vitestCase',ownerPackage:'@fixture/native-evidence',testFile:'tests/integration.test.ts',testName:'exact native source'},
        'proof.native':{kind:'vitestCase',ownerPackage:'@fixture/native-evidence',testFile:'tests/integration.test.ts',testName:'actual controlled native failure'},
      }})],
    ]);
    for(const [path,bytes]of files)writeFileSync(resolve(root,path),bytes);
    // Start cold inside this allocation. Cache only Node's compilation, not test
    // results: every prerequisite and selected case still executes in a new child.
    const compileCache=resolve(root,'.treeseed/compile-cache');
    expect(existsSync(compileCache)).toBe(false);
    const native=(executable:string,args:string[])=>spawnSync(executable,args,{cwd:root,encoding:'utf8',timeout:10_000,maxBuffer:8*1024*1024,
      env:{...process.env,NODE_COMPILE_CACHE:compileCache}});
    for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Native evidence inputs']])expect(native('git',args).status).toBe(0);
    const head=native('git',['rev-parse','HEAD']);expect(head.status).toBe(0);
    const invoke=(id:string)=>{
      // Pinned Node 24 executes these erasable TypeScript sources directly;
      // don't start a second transpiler worker for each native CLI invocation.
      const actual=native(process.execPath,[resolve(reviewer,'src/verifiers/guarantees/command.ts'),'--workspace',root,'--environment','local','--ids','proof','--run-id',id]);
      expect(actual.error).toBeUndefined();expect(actual.signal).toBeNull();expect(actual.stderr).toBe('');
      return {actual,report:JSON.parse(actual.stdout) as {ok:boolean;results:{status:string;evidence:string[];steps:{ref:string;status:string;evidence:string[]}[]}[]}};
    };
    writeFileSync(resolve(root,'.treeseed/fail-selected'),'controlled input');
    const failed=invoke('native-failed'),output=resolve(root,'.treeseed/guarantees/runs/native-failed');
    expect(failed.actual.status).toBe(1);expect(failed.report.ok).toBe(false);
    expect(failed.report.results[0]!.steps.map(step=>[step.ref,step.status])).toEqual([['proof.unit','passed'],['proof.native','failed']]);
    const retained=new Map<string,Buffer>();
    for(const path of ['report.json',...failed.report.results[0]!.evidence])retained.set(path,readFileSync(resolve(output,path)));
    const receipt=failed.report.results[0]!.evidence.find(path=>path.includes('prerequisite-'))!;
    expect(JSON.parse(retained.get(receipt)!.toString())).toMatchObject({commit:head.stdout.trim(),passed:true,exitCode:0,checks:{total:2,passed:2,failed:0,skipped:0,todo:0}});
    expect(JSON.parse(retained.get(receipt)!.toString()).command).toEqual([
      process.execPath,resolve(root,'node_modules/vitest/vitest.mjs'),'run','--reporter=json',expect.stringMatching(/^--outputFile=.+\/report\.json$/u),
    ]);
    const evidence=JSON.parse(readFileSync(resolve(output,failed.report.results[0]!.steps[1]!.evidence[0]!),'utf8'));
    expect(evidence).toMatchObject({passed:false,exitCode:1,signal:null,processErrorCode:null,testFile:'tests/integration.test.ts'});
    expect(evidence.checks).toHaveLength(1);expect(evidence.checks[0],JSON.stringify(evidence.checks[0])).toHaveProperty('failure');
    expect(evidence.checks[0]).toMatchObject({title:'actual controlled native failure',status:'failed',failure:{code:'Error',file:'tests/integration.test.ts',line:5,criterion:'ACCEPTANCE_NATIVE_EVIDENCE'}});
    expect(evidence.checks[0].failure.column).toBeGreaterThan(0);
    expect(JSON.stringify(evidence)).not.toMatch(/controlled-private-value|failureMessages|\/tmp\//u);
    expect(readFileSync(resolve(root,'.treeseed/observations'),'utf8').trim().split('\n').sort()).toEqual(['native','native','unit','unit']);
    rmSync(resolve(root,'.treeseed/fail-selected'));
    const retried=invoke('native-fresh-retry');expect(retried.actual.status).toBe(0);expect(retried.report.ok).toBe(true);
    const retryRoot=resolve(root,'.treeseed/guarantees/runs/native-fresh-retry');
    const retryReceipt=retried.report.results[0]!.evidence.find(path=>path.includes('prerequisite-'))!;
    expect(JSON.parse(readFileSync(resolve(retryRoot,retryReceipt),'utf8'))).toMatchObject({commit:head.stdout.trim(),passed:true,checks:{total:2,passed:2,failed:0,skipped:0,todo:0}});
    expect(JSON.parse(readFileSync(resolve(retryRoot,retryReceipt),'utf8')).command).toEqual([
      process.execPath,resolve(root,'node_modules/vitest/vitest.mjs'),'run','--reporter=json',expect.stringMatching(/^--outputFile=.+\/report\.json$/u),
    ]);
    expect(readFileSync(resolve(root,'.treeseed/observations'),'utf8').trim().split('\n')).toHaveLength(8);
    expect(existsSync(compileCache)).toBe(true);
    for(const [path,bytes]of retained)expect(readFileSync(resolve(output,path))).toEqual(bytes);
    for(const [path,bytes]of files)expect(readFileSync(resolve(root,path),'utf8')).toBe(bytes);
    expect(native('git',['rev-parse','HEAD']).stdout).toBe(head.stdout);
  }finally{rmSync(root,{recursive:true,force:true});expect(existsSync(root)).toBe(false);}
  expect(spawnSync('git',['-C',reviewer,'rev-parse','HEAD'],{encoding:'utf8',timeout:5000}).stdout).toBe(heldHead.stdout);
});

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
  expect(steps.filter(step=>step.uses?.startsWith('treeseed-ai/sdk/.github/actions/install-exact-sdk@'))
    .map(step=>step.uses)).toEqual(['treeseed-ai/sdk/.github/actions/install-exact-sdk@cbc03314871d271bce7275c5cee71d950397a0c3']);
  const scene=steps.find(step=>step.name==='Execute coded sandbox component scenes');
  expect(scene?.run).toContain('sudo --preserve-env=');
  expect(scene?.run).toContain('src/verifiers/guarantees/command.ts');
  expect(scene?.env?.TREESEED_PRIVILEGED_CACHE_TESTS).toBe('1');
  expect(scene?.run).not.toContain('source-cache-volume.integration.test.ts');
  expect(steps.some(step=>step.uses?.startsWith('actions/checkout@')&&step.with?.repository==='treeseed-ai/reviewer'&&
    /^[a-f0-9]{40}$/u.test(step.with.ref??'')&&step.with.path==='.treeseed/tools/reviewer')).toBe(true);
  const checkout=steps.findIndex(step=>step.with?.repository==='treeseed-ai/reviewer');
  const privileged=steps.findIndex(step=>step.run?.includes('npm run verify:direct'));
  expect(privileged).toBeGreaterThan(-1);
  expect(checkout).toBeLessThan(privileged);
  expect(checkout).toBeLessThan(steps.findIndex(step=>step.run?.startsWith('sudo ')));
  expect(steps.some(step=>step.name==='Retain coded scene evidence'&&step.with?.['if-no-files-found']==='error')).toBe(true);
});

it('provisions only a disposable native Actions host through the original installer before complete privileged prerequisites', () => {
  const bytes=readFileSync('.github/workflows/verify.yml');
  const workflow=parse(bytes.toString()),job=workflow.jobs.verify;
  const steps=job.steps as {name?:string;run?:string;env?:Record<string,string>}[];
  expect(job['runs-on']).toBe('ubuntu-26.04');
  const native=steps.find(step=>step.name==='Initialize disposable native capacity host');
  expect(native).toBeDefined();
  expect(native?.run).toContain('scripts/verify-native-host.ts');
  expect(native?.run).toContain('sudo --preserve-env=');
  expect(native?.env?.TREESEED_PRIVILEGED_CACHE_TESTS).toBe('1');
  const prerequisite=steps.find(step=>step.run?.includes('npm run verify:direct'));
  expect(prerequisite).toBeDefined();expect(prerequisite?.run).toContain('sudo --preserve-env=');
  expect(prerequisite?.env?.TREESEED_PRIVILEGED_CACHE_TESTS).toBe('1');
  expect(steps.indexOf(native!)).toBeLessThan(steps.indexOf(prerequisite!));
  const scene=steps.find(step=>step.name==='Execute coded sandbox component scenes');
  expect(scene?.run).toMatch(/sudo --preserve-env=[^\s]+,PATH /u);
  expect(readFileSync('.github/workflows/verify.yml')).toEqual(bytes);
});

it('capacity execution packaging binds one exact SDK dependency to its original installer and every transitive consumer', () => {
  const inputs=new Map(['package.json','package-lock.json','.github/workflows/verify.yml'].map(path=>[path,readFileSync(path)]));
  const manifest=JSON.parse(inputs.get('package.json')!.toString()),lock=JSON.parse(inputs.get('package-lock.json')!.toString());
  const steps=parse(inputs.get('.github/workflows/verify.yml')!.toString()).jobs.verify.steps as {uses?:string;run?:string;env?:Record<string,string>}[];
  const installers=steps.filter(step=>step.uses?.startsWith('treeseed-ai/sdk/.github/actions/install-exact-sdk@'));
  expect(installers).toHaveLength(1);
  const commit=installers[0]!.uses!.split('@').at(-1); expect(commit).toMatch(/^[a-f0-9]{40}$/u);
  expect(manifest.dependencies['@treeseed/sdk']).toBe(`git+https://github.com/treeseed-ai/sdk.git#${commit}`);
  expect(manifest.overrides['@treeseed/sdk']).toBe('$@treeseed/sdk');
  expect(Object.keys(lock.packages).filter(path=>path.endsWith('node_modules/@treeseed/sdk'))).toEqual(['node_modules/@treeseed/sdk']);
  expect(lock.packages[''].dependencies['@treeseed/sdk']).toBe(manifest.dependencies['@treeseed/sdk']);
  expect(lock.packages['node_modules/@treeseed/sdk'].resolved.split('#').at(-1)).toBe(commit);
  expect(installers[0]?.env?.NODE_ENV).toBe('production');
  const prune=steps.findIndex(step=>step.run==='npm prune --ignore-scripts --no-audit --no-fund --workspaces=false');
  expect(prune).toBeGreaterThan(steps.indexOf(installers[0]!));
  const complete=steps.findIndex(step=>step.run?.includes('npm run verify:direct'));
  expect(complete).toBeGreaterThan(-1);expect(prune).toBeLessThan(complete);
  for(const [path,bytes] of inputs)expect(readFileSync(path)).toEqual(bytes);
});

it('every native execution workflow installs the same declared exact SDK before compiling its owning acceptance sources', () => {
  const dependency=JSON.parse(readFileSync('package.json','utf8')).dependencies['@treeseed/sdk'] as string;
  const commit=dependency.split('#').at(-1)!;
  expect(commit).toMatch(/^[a-f0-9]{40}$/u);
  const workflows=['verify.yml','development-backup.yml','identity-acceptance.yml','postgres-transfer.yml'];
  for(const name of workflows){
    const path=resolve('.github/workflows',name),bytes=readFileSync(path);
    const workflow=parse(bytes.toString()) as {jobs:Record<string,{steps:{uses?:string;run?:string;with?:Record<string,unknown>}[]}>};
    const runtimes=Object.values(workflow.jobs).flatMap(job=>job.steps).filter(step=>step.uses?.startsWith('actions/setup-node@'));
    expect(runtimes.length,name).toBeGreaterThan(0);
    for(const runtime of runtimes)expect(runtime.with?.['node-version'],name).toBe('24.12.0');
    const installers=Object.values(workflow.jobs).flatMap(job=>job.steps)
      .filter(step=>step.uses?.startsWith('treeseed-ai/sdk/.github/actions/install-exact-sdk@'));
    expect(installers.length,name).toBeGreaterThan(0);
    expect(installers.map(step=>step.uses),name).toEqual(installers.map(()=>`treeseed-ai/sdk/.github/actions/install-exact-sdk@${commit}`));
    expect(readFileSync(path)).toEqual(bytes);
  }
});

it('native capacity execution package install retains exact held SDK bytes and requires one valid tree and nonempty SBOM before scene admission', () => {
  const root=mkdtempSync(resolve(tmpdir(),'deployment-capacity-sdk-'));
  const inputs=new Map(['package.json','package-lock.json','.github/workflows/verify.yml'].map(path=>[path,readFileSync(path)]));
  const sdkBytes=readFileSync('node_modules/@treeseed/sdk/package.json');
  let phase='PREPARATION';
  onTestFailed(()=>{throw new Error(`ACCEPTANCE_NATIVE_SDK_INSTALL_${phase}: Original native package-install failure; retain its failed disposition.`);});
  const run=(command:string,args:string[],cwd=root,env:NodeJS.ProcessEnv=process.env)=>{
    phase=`${command}_${args[0]??'COMMAND'}`.toUpperCase().replace(/[^A-Z0-9_]/gu,'_');
    return spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:15_000,maxBuffer:8*1024*1024});
  };
  const passed=(result:ReturnType<typeof run>)=>{expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,result.stdout+result.stderr).toBe(0);};
  try {
    const runtime=run('node',['--version']);passed(runtime);expect(runtime.stdout.trim()).toBe(process.version);
    passed(run('npm',['ls','--all','--json'],process.cwd()));
    for(const [path,bytes] of inputs){mkdirSync(resolve(root,path,'..'),{recursive:true});writeFileSync(resolve(root,path),bytes);}
    const packed=run('npm',['pack','--ignore-scripts','--json','--pack-destination',root,'./node_modules/@treeseed/sdk'],process.cwd());passed(packed);
    const inventory=JSON.parse(packed.stdout) as {name:string;version:string;filename:string}[];
    expect(inventory).toHaveLength(1);expect(inventory[0]?.name).toBe('@treeseed/sdk');expect(inventory[0]?.version).toBe(JSON.parse(sdkBytes.toString()).version);
    const archive=resolve(root,inventory[0]!.filename),archiveBytes=readFileSync(archive);
    passed(run('npm',['ci','--ignore-scripts','--no-audit','--no-fund','--workspaces=false']));
    const destination=resolve(root,'node_modules/@treeseed/sdk');rmSync(destination,{recursive:true});mkdirSync(destination);
    passed(run('tar',['-xzf',archive,'--strip-components=1','-C',destination]));
    const steps=parse(inputs.get('.github/workflows/verify.yml')!.toString()).jobs.verify.steps as {uses?:string;run?:string;env?:Record<string,string>}[];
    const installer=steps.find(step=>step.uses?.startsWith('treeseed-ai/sdk/.github/actions/install-exact-sdk@'));
    expect(installer?.env?.NODE_ENV).toBe('production');
    passed(run('npm',['install','--prefix',destination,'--ignore-scripts','--no-save','--package-lock=false','--no-audit','--no-fund'],root,{...process.env,NODE_ENV:installer!.env!.NODE_ENV}));
    const prune=steps.find(step=>step.run==='npm prune --ignore-scripts --no-audit --no-fund --workspaces=false');expect(prune).toBeDefined();
    passed(run('bash',['-euo','pipefail','-c',prune!.run!]));passed(run('npm',['ls','--all','--json']));
    const publicEntry=createRequire(resolve(root,'package.json')).resolve('@treeseed/sdk/agent-capacity');
    expect(createRequire(resolve(root,'node_modules/@treeseed/identity/package.json')).resolve('@treeseed/sdk/agent-capacity')).toBe(publicEntry);
    const sbom=run('npm',['sbom','--sbom-format','cyclonedx']);passed(sbom);
    const components=JSON.parse(sbom.stdout).components as {name:string;group?:string;version:string}[];
    expect(Array.isArray(components)).toBe(true);expect(components.length).toBeGreaterThan(0);
    expect(components.filter(component=>component.name==='@treeseed/sdk'||component.name==='sdk'&&component.group==='@treeseed')).toMatchObject([{version:inventory[0]!.version}]);
    expect(components.filter(component=>component.name==='@treeseed/sdk'||component.name==='sdk'&&component.group==='@treeseed')).toHaveLength(1);
    expect(readFileSync(resolve(destination,'package.json'))).toEqual(sdkBytes);expect(readFileSync(archive)).toEqual(archiveBytes);
    for(const [path,bytes] of inputs){expect(readFileSync(path)).toEqual(bytes);expect(readFileSync(resolve(root,path))).toEqual(bytes);}
    expect(readFileSync('node_modules/@treeseed/sdk/package.json')).toEqual(sdkBytes);
  } finally {rmSync(root,{recursive:true,force:true});expect(existsSync(root)).toBe(false);}
},30_000);

it('disposable native installer denies missing malformed nonroot foreign and existing host authority before any installation', () => {
  const root=resolve('.'),env={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'treeseed-ai/deployment',
    TREESEED_PRIVILEGED_CACHE_TESTS:'1',GITHUB_WORKSPACE:root},held=structuredClone(env);
  expect(()=>assertDisposableNativeHost(env,0,root,()=>false)).not.toThrow();
  for(const key of Object.keys(env))for(const value of [undefined,'','false','foreign']){
    const invalid={...env,[key]:value};expect(()=>assertDisposableNativeHost(invalid,0,root,()=>false)).toThrow();
  }
  for(const uid of [undefined,1,1000,-1,NaN])expect(()=>assertDisposableNativeHost(env,uid,root,()=>false)).toThrow();
  for(const path of ['/etc/treeseed','/var/lib/treeseed','/usr/lib/treeseed','/dev/mapper/treeseed-provider-data']){
    expect(()=>assertDisposableNativeHost(env,0,root,candidate=>candidate===path)).toThrow('refuses existing TreeSeed state');
  }
  expect(env).toEqual(held);
});

it('native installer subprocess rejects a non Actions caller without touching held configuration or candidate bytes', () => {
  const paths=['scripts/verify-native-host.ts','.github/workflows/verify.yml','dist/src/sandbox/workspace-image-builder.js'];
  const held=new Map(paths.map(path=>[path,readFileSync(path)]));
  const actual=spawnSync(process.execPath,['--import','tsx','scripts/verify-native-host.ts'],{
    env:{PATH:process.env.PATH??'/usr/bin:/bin',GITHUB_ACTIONS:'false'},encoding:'utf8',timeout:5000});
  expect(actual.error).toBeUndefined();expect(actual.signal).toBeNull();expect(actual.status).toBe(1);
  expect(actual.stderr).toContain('An explicitly authorized root GitHub-hosted Deployment workspace is required.');
  expect(actual.stdout).toBe('');for(const [path,bytes] of held)expect(readFileSync(path)).toEqual(bytes);
});

it('native pinned Reviewer checkout plans every original capacity component case without executing or rewriting candidate evidence', () => {
  const root=process.cwd(),workflow=parse(readFileSync('.github/workflows/verify.yml','utf8'));
  const steps=workflow.jobs.verify.steps as {with?:Record<string,string>}[];
  const checkout=steps.find(step=>step.with?.repository==='treeseed-ai/reviewer')!.with!;
  const reviewer=resolve(root,checkout.path!),command=resolve(reviewer,'src/verifiers/guarantees/command.ts');
  const held=new Map(['.github/workflows/verify.yml','guarantees/verifiers/golden.verifiers.yaml',
    'guarantees/agent/golden/scenes/component-boundaries.scene.yaml',command].map(path=>[path,readFileSync(path)]));
  const git=(args:string[])=>spawnSync('git',['-C',reviewer,...args],{encoding:'utf8',timeout:5000});
  const head=git(['rev-parse','HEAD']);expect(head.error).toBeUndefined();expect(head.signal).toBeNull();
  expect(head.status,head.stderr).toBe(0);expect(head.stdout.trim()).toBe(checkout.ref);
  const source=git(['show',`${checkout.ref}:src/verifiers/guarantees/command.ts`]);
  expect(source.error).toBeUndefined();expect(source.signal).toBeNull();expect(source.status,source.stderr).toBe(0);
  expect(source.stdout).toBe(held.get(command)!.toString());
  const scene=parse(held.get('guarantees/agent/golden/scenes/component-boundaries.scene.yaml')!.toString());
  const ids=scene.workflow.map((step:{action:{verifier:string}})=>step.action.verifier) as string[];
  const actual=spawnSync(process.execPath,['--import','tsx',command,'--workspace',root,'--environment','local',
    '--ids','guarantee.deployment.golden.component-boundaries','--plan'],{encoding:'utf8',timeout:15_000,maxBuffer:8*1024*1024});
  expect(actual.error).toBeUndefined();expect(actual.signal).toBeNull();expect(actual.status,actual.stderr).toBe(0);
  const plan=JSON.parse(actual.stdout);expect(plan.ok).toBe(true);expect(plan.diagnostics).toEqual([]);
  expect(plan.entries).toHaveLength(1);expect(plan.entries[0].scope).toBe('local-component-tests');
  expect(plan.entries[0].id).toBe('guarantee.deployment.golden.component-boundaries');
  expect(new Set(plan.entries[0].verifierRefs)).toEqual(new Set(ids));
  expect(new Set(plan.entries[0].sceneVerifierRefs)).toEqual(new Set(ids));
  expect(ids.length).toBeGreaterThan(0);expect(new Set(ids).size).toBe(ids.length);
  for(const [path,bytes] of held)expect(readFileSync(path).equals(bytes)).toBe(true);
  expect(git(['rev-parse','HEAD']).stdout).toBe(head.stdout);
});
