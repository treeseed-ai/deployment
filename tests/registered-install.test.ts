import{test,expect}from'bun:test';
import{writeFileSync}from'node:fs';
import{join}from'node:path';
import{spawnSync}from'node:child_process';
import{PluginInstallationFixture,PluginFixtureTools}from'@treeseed-cordis/deployment/testing/plugins';
class RegisteredInstallTests{async program():Promise<void>{const fixture=await new PluginInstallationFixture().prepare();try{const input=join(fixture.root,'registered.json'),executable=join(fixture.root,'registered-install');writeFileSync(input,JSON.stringify({root:fixture.root,configuration:fixture.configuration,rebase:true}));PluginFixtureTools.command(process.execPath,['build','dist/tests/plugin-install-program.js','--compile','--target=bun-linux-x64','--outfile',executable]);const result=spawnSync(executable,[input],{encoding:'utf8',timeout:420000});if(result.status!==0)throw new Error(result.stderr);expect(JSON.parse(result.stdout)).toEqual({fixtureOnly:true,registered:true,services:7,sourceFree:true,retained:true});}finally{await fixture.close();}}}
const suite=new RegisteredInstallTests();test('smoke: successive registered selections rebuild current verified closures with the actual source stopped',suite.program.bind(suite),480000);
