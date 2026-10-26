import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
class PublicPluginFixtureTests {
    private command(program: string, args: string[], cwd: string, cache?: string): string {
        const result = spawnSync(program, args, { cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, BUN_INSTALL_CACHE_DIR: cache ?? process.env.BUN_INSTALL_CACHE_DIR } });
        if (result.status !== 0) throw new Error(result.stderr || 'Public fixture command failed');
        return result.stdout;
    }
    private async consumer(mode:'npm'|'git'|'built'): Promise<void> {
        const root = mkdtempSync(join(tmpdir(), 'cordis-public-plugins-')), archives = join(root, 'archives'), consumer = join(root, 'consumer');
        mkdirSync(archives); mkdirSync(consumer);
        try {
            this.command(process.execPath, ['pm', 'pack', '--destination', archives], process.cwd());
            const metadata = JSON.parse(readFileSync('package.json', 'utf8')), archive = join(archives, metadata.name.replace('@', '').replace('/', '-') + '-' + metadata.version + '.tgz');
            writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'public-fixture-consumer', private: true, type: 'module', dependencies: { '@treeseed-cordis/deployment': 'file:' + archive, '@treeseed-cordis/sdk': 'file:' + resolve('vendor/sdk.tgz') } }));
            this.command(process.execPath, ['install', '--ignore-scripts', '--no-env-file'], consumer, join(root, 'empty-consumer-cache'));
            const entry = join(consumer, 'program.ts');
            const start=mode==='npm'?'await fixture.startRegistry();':'await fixture.startGit('+String(mode==='built')+');';
            writeFileSync(entry, "import{PluginInstallationFixture}from'@treeseed-cordis/deployment/testing/plugins';import{ComposeDeploymentHost}from'@treeseed-cordis/deployment';import{existsSync}from'node:fs';import{join}from'node:path';export class PublicFixtureConsumer{static async run():Promise<void>{const fixture=new PluginInstallationFixture();try{await fixture.prepare();"+start+"const plan=await new ComposeDeploymentHost().plan(fixture.configuration);if(plan.formatVersion!==3||plan.composition.services.length!==4||!plan.acquisitionPolicy||("+JSON.stringify(mode)+"==='npm'?!fixture.source().endsWith('@1.0.0'):!fixture.source().startsWith('https://'))||existsSync(join(fixture.root,'SCRIPT_CANARY'))||existsSync(join(fixture.root,'MUST_NOT_RUN'))||existsSync(join(fixture.installation,'.cordis/credentials')))throw new Error('PUBLIC_PLUGIN_FIXTURE_MISMATCH');process.stdout.write(JSON.stringify({fixtureOnly:true,publicArchive:true,prepared:true,noActivation:true,sourceKind:"+JSON.stringify(mode)+"})+'\\n');}finally{await fixture.close();}}}await PublicFixtureConsumer.run();\n");
            // A real consumer runs the packed public module without bundling its build-time worker producer.
            const result = this.command(process.execPath, [entry], consumer);
            expect(JSON.parse(result)).toEqual({ fixtureOnly: true, publicArchive: true, prepared: true, noActivation: true, sourceKind:mode });
        } finally { rmSync(root, { recursive: true, force: true }); }
    }
}
const suite = new PublicPluginFixtureTests();
test('smoke: packed public plugin fixture constructs a genuine prepared bundle in an independent consumer', suite.program.bind(suite), 180000);

test('smoke: packed public Git fixture prepares genuine helper and immutable source policy in an independent consumer',suite.git.bind(suite),180000);
test('smoke: packed public build fixture binds an approved genuine source-only Git commit without activation',suite.built.bind(suite),180000);
