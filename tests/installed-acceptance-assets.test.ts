import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import * as runtime from '../src/index.js';
import { developmentRuntimeStatus, assertDevelopmentRuntimeMounts } from '../src/supervisor/development-runtime-copy.js';
import { workspaceStorageRoot } from '../src/sandbox/workspace-block-store.js';
import { simulationSourceRepository } from '../src/sandbox/simulation-source-repository.js';
import { sandboxBrokerConfigurationSchema } from '../src/sandbox/protocol.js';
import { workspaceNbdServiceArguments } from '../src/sandbox/workspace-nbd-service.js';
import { kataWarmOperations, WarmSandboxPool } from '../src/sandbox/warm-sandbox-pool.js';

const assets = ['treeseed.package.yaml', 'guarantees/verifiers/source-runtime.verifiers.yaml',
 'guarantees/agent/golden/source-publication.guarantee.yaml', 'guarantees/agent/golden/scenes/source-publication.scene.yaml',
 'tests/acceptance/selected-provider-code.ts', 'tests/acceptance/source-publication.ts', 'tests/acceptance/public-cli.ts'];

it('ships the existing selected Deployment acceptance closure without private source imports or checkout CLI execution', () => {
 const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'],
  { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })) as {files: {path: string}[]}[];
 expect(packed).toBeDefined(); const paths = new Set(packed!.files.map(file => file.path));
 const privateImports: string[] = [], checkoutCliPaths: string[] = [];
 for (const path of assets.filter(value => value.endsWith('.ts') && paths.has(value))) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
   && statement.moduleSpecifier.text.includes('/src/')) privateImports.push(statement.moduleSpecifier.text);
  const visit = (node: ts.Node) => { if (ts.isStringLiteral(node) && node.text.includes('packages/cli/')) checkoutCliPaths.push(node.text); ts.forEachChild(node, visit); }; visit(source);
 }
 expect({missing: assets.filter(path => !paths.has(path)), privateImports, checkoutCliPaths}).toEqual({missing: [], privateImports: [], checkoutCliPaths: []});
});

it('exposes identical owning runtime inspection source custody and warm-pool functions through the existing public package root', () => {
 for (const [name, authority] of Object.entries({developmentRuntimeStatus, assertDevelopmentRuntimeMounts, workspaceStorageRoot,
  simulationSourceRepository, sandboxBrokerConfigurationSchema, workspaceNbdServiceArguments, kataWarmOperations, WarmSandboxPool}))
  expect(Reflect.get(runtime, name), name).toBe(authority);
});

it('resolves only an installed declared CLI binary and denies missing malformed escaped or redirected custody without checkout fallback', async () => {
 const root = mkdtempSync(resolve(tmpdir(), 'deployment-cli-resolution-'));
 const owner = resolve(root, 'node_modules/@treeseed/deployment/tests/acceptance'), cli = resolve(root, 'node_modules/@treeseed/cli');
 mkdirSync(owner, {recursive: true}); mkdirSync(cli, {recursive: true});
 writeFileSync(resolve(owner, 'public-cli.ts'), readFileSync('tests/acceptance/public-cli.ts'));
 const fixture = await import(pathToFileURL(resolve(owner, 'public-cli.ts')).href) as {installedCli: () => string};
 const manifest = {name: '@treeseed/cli', bin: {trsd: './main.js'}};
 try {
  writeFileSync(resolve(cli, 'main.js'), 'unchanged unit fixture');
  const declare = (value: unknown) => writeFileSync(resolve(cli, 'package.json'), JSON.stringify(value));
  declare(manifest); expect(fixture.installedCli()).toBe(resolve(cli, 'main.js'));
  for (const value of [{}, {name: '@other/cli', bin: manifest.bin}, {name: manifest.name},
   ...[undefined, null, 1, '', '../outside.js', '/tmp/escaped-binary', './missing.js', '.'].map(trsd => ({name: manifest.name, bin: {trsd}}))]) {
   declare(value); expect(() => fixture.installedCli()).toThrow();
  }
  declare(manifest); rmSync(resolve(cli, 'main.js')); writeFileSync(resolve(root, 'outside.js'), 'unchanged outside fixture');
  symlinkSync(resolve(root, 'outside.js'), resolve(cli, 'main.js')); expect(() => fixture.installedCli()).toThrow();
  expect(readFileSync(resolve(root, 'outside.js'), 'utf8')).toBe('unchanged outside fixture');
  writeFileSync(resolve(cli, 'package.json'), '{malformed'); expect(() => fixture.installedCli()).toThrow();
  rmSync(resolve(cli, 'package.json')); expect(() => fixture.installedCli()).toThrow();
 } finally {rmSync(root, {recursive: true, force: true}); expect(existsSync(root)).toBe(false);}
});

it('native production Deployment archive loads exact owning acceptance runtime and materializes private bytes without checkout or development dependencies', () => {
 const root = mkdtempSync(resolve(tmpdir(), 'deployment-installed-assets-')), deadline = performance.now() + 120_000;
 const run = (command: string, args: string[], cwd = process.cwd()) => {
  const remaining = Math.floor(deadline - performance.now() - 5000); expect(remaining).toBeGreaterThan(0);
  return execFileSync(command, args, {cwd, encoding: 'utf8', timeout: remaining, maxBuffer: 8 * 1024 * 1024});
 };
 let observation: Record<string, string> | undefined;
 try {
  const packed = JSON.parse(run('npm', ['pack', '.', './node_modules/@treeseed/sdk', './node_modules/@treeseed/identity',
   '--ignore-scripts', '--json', '--pack-destination', root])) as {name: string; filename: string; integrity: string; files: {path: string}[]}[];
  expect(packed).toHaveLength(3); expect(packed.map(value => value.name).sort()).toEqual(['@treeseed/deployment', '@treeseed/identity', '@treeseed/sdk']);
  const archives = packed.map(value => resolve(root, value.filename)), bytes = archives.map(path => readFileSync(path));
  for (let index = 0; index < packed.length; index++) expect(`sha512-${createHash('sha512').update(bytes[index]!).digest('base64')}`).toBe(packed[index]!.integrity);
  const dependencies = Object.fromEntries(packed.map(value => [value.name, `file:${resolve(root, value.filename)}`]));
  writeFileSync(resolve(root, 'package.json'), JSON.stringify({private: true, type: 'module', dependencies,
   overrides: {'@treeseed/sdk': '$@treeseed/sdk', '@treeseed/identity': '$@treeseed/identity'}}));
  run('npm', ['install', '--prefix', root, '--prefer-offline', '--omit=dev', '--ignore-scripts', '--package-lock=false', '--no-save', '--no-audit', '--no-fund', ...archives], root);
  run('npm', ['ls', '--all', '--omit=dev', '--json'], root);
  const installed = resolve(root, 'node_modules/@treeseed/deployment');
  expect(realpathSync(installed)).toBe(installed); expect(lstatSync(installed).isSymbolicLink()).toBe(false);
  for (const path of ['src', 'node_modules/@treeseed/sdk', 'node_modules/@treeseed/identity']) expect(existsSync(resolve(installed, path))).toBe(false);
  for (const path of ['tsx', 'vitest']) expect(existsSync(resolve(root, 'node_modules', path))).toBe(false);
  for (const path of assets) expect(readFileSync(resolve(installed, path)).equals(readFileSync(path)), path).toBe(true);
  writeFileSync(resolve(root, 'consumer.ts'), `import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,statSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';
import {copyDevelopmentRuntime,developmentRuntimeStatus,assertDevelopmentRuntimeMounts,agentDevelopmentRuntimeRoots,workspaceStorageRoot,
 simulationSourceRepository,sandboxBrokerConfigurationSchema,workspaceNbdServiceArguments,kataWarmOperations,WarmSandboxPool} from '@treeseed/deployment';
const workspace=resolve('workspace'),source=resolve(workspace,'source'),selected=resolve('selected');
for(const path of [resolve(source,'dist'),resolve(source,'node_modules'),resolve(source,'drizzle'),selected])mkdirSync(path,{recursive:true});
writeFileSync(resolve(source,'package.json'),'{}');writeFileSync(resolve(source,'dist/entry.js'),'exact independent private bytes');
const receipt=copyDevelopmentRuntime({worktree:source,workspace,destination:resolve(selected,'runtime'),sourceUid:process.getuid!()});
writeFileSync(resolve(selected,'runtime-receipt.json'),JSON.stringify(receipt),{mode:0o600});
assert.deepEqual(developmentRuntimeStatus(selected,undefined,process.getuid!()),receipt);
assert.notEqual(statSync(resolve(source,'dist/entry.js')).ino,statSync(resolve(selected,'runtime/dist/entry.js')).ino);
writeFileSync(resolve(source,'dist/entry.js'),'changed checkout bytes');assert.equal(readFileSync(resolve(selected,'runtime/dist/entry.js'),'utf8'),'exact independent private bytes');
assert.throws(()=>copyDevelopmentRuntime({worktree:source,workspace,destination:resolve(selected,'runtime'),sourceUid:process.getuid!()}),/EEXIST/);
assert.throws(()=>assertDevelopmentRuntimeMounts({labels:{},mounts:[]},'dev-native','agent.provider',selected,['dist']));
assert.equal(Object.isFrozen(agentDevelopmentRuntimeRoots),true);assert.equal(workspaceStorageRoot,'/var/lib/treeseed/agent/workspaces');
const key={controlPlaneId:'native',teamId:'team',projectId:'project',repositoryId:'repository',commit:'a'.repeat(40),formatVersion:1,profile:'source-only'};
assert.equal(simulationSourceRepository(selected,key),simulationSourceRepository(selected,{...key,commit:'b'.repeat(40)}));
assert.throws(()=>simulationSourceRepository(selected,{...key,commit:'staging'}));assert.throws(()=>sandboxBrokerConfigurationSchema.parse({}));
assert.throws(()=>workspaceNbdServiceArguments({id:'foreign',directory:'/tmp',device:'/dev/nbd0',image:'work.qcow2',readOnly:false}));
assert.equal(typeof kataWarmOperations,'function');assert.throws(()=>new WarmSandboxPool({create:async()=>{throw Error('must not start');},destroy:async()=>{throw Error('must not destroy');},onFailure:()=>{}},5));
console.log(JSON.stringify({installedRuntimeContracts:'passed',privateCopy:receipt.digest}));\n`);
  const result = JSON.parse(run(process.execPath, ['consumer.ts'], root)) as {installedRuntimeContracts: string; privateCopy: string};
  expect(result.installedRuntimeContracts).toBe('passed'); expect(result.privateCopy).toMatch(/^sha256:[a-f0-9]{64}$/u);
  for (let index = 0; index < archives.length; index++) expect(readFileSync(archives[index]!).equals(bytes[index]!)).toBe(true);
  const deploymentIndex = packed.findIndex(value => value.name === '@treeseed/deployment');
  observation = {archive: packed[deploymentIndex]!.filename,
   sha256: createHash('sha256').update(bytes[deploymentIndex]!).digest('hex'), installedRuntimeContracts: result.installedRuntimeContracts};
 } finally {rmSync(root, {recursive: true, force: true}); expect(existsSync(root)).toBe(false);}
 expect(observation).toBeDefined(); expect(performance.now()).toBeLessThan(deadline); console.log(JSON.stringify(observation));
}, 120_000);
