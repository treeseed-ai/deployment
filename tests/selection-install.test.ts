import {test,expect} from 'bun:test';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {PluginInstallationFixture,PluginFixtureTools} from '@treeseed-cordis/deployment/testing/plugins';
class SelectionInstallTests{
    denied():void{const result=spawnSync(process.execPath,['dist/tests/selection-program.js'],{encoding:'utf8',timeout:30000});if(result.status!==0)throw new Error(result.stderr);expect(result.status).toBe(0);}
    async program():Promise<void>{const fixture=await new PluginInstallationFixture().prepare();try{const input=join(fixture.root,'selection.json'),program=join(fixture.root,'selection');writeFileSync(input,JSON.stringify({root:fixture.root,configuration:fixture.configuration,selection:true}));PluginFixtureTools.command(process.execPath,['build','dist/tests/plugin-install-program.js','--compile','--target=bun-linux-x64','--outfile',program]);const result=spawnSync(program,[input],{encoding:'utf8',timeout:420000});if(result.status!==0)throw new Error(result.stderr);expect(JSON.parse(result.stdout)).toEqual({fixtureOnly:true,services:6,active:true,alreadyActive:true,unsafePrepared:true,retained:true,sourceFree:true,noScripts:true});}finally{await fixture.close();}}
}
const suite=new SelectionInstallTests();
test('smoke: registered provider selection reuses exact accepted bytes and current target acknowledgements',suite.program.bind(suite),480000);

test('smoke: actual native selection root refuses an unregistered provider without activation',suite.denied.bind(suite),60000);
