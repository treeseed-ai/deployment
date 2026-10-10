import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
