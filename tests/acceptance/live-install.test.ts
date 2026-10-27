import{test,expect}from'bun:test';
import{spawnSync}from'node:child_process';
import{writeFileSync}from'node:fs';
import{join}from'node:path';
import{LiveProbeFixture}from'../support/live-probe-fixture.js';
import{PluginFixtureTools}from'../support/plugin-installation-fixture.js';
class LiveInstallTests{async program():Promise<void>{const fixture=await new LiveProbeFixture().prepareLive();try{const input=join(fixture.root,'live.json'),executable=join(fixture.root,'live-install');writeFileSync(input,JSON.stringify({root:fixture.root,configuration:fixture.configuration}));PluginFixtureTools.command(process.execPath,['build','dist/tests/support/live-install-program.js','--compile','--target=bun-linux-x64','--outfile',executable]);const result=spawnSync(executable,[input],{encoding:'utf8',timeout:420000});if(result.status!==0)throw new Error(result.stderr);expect(JSON.parse(result.stdout)).toEqual({fixtureOnly:true,live:true,actualLease:true,admissionClosed:true,cleanupAwaited:true,resourcesRetained:true,readBack:true,sourceFree:true});}finally{fixture.close();}}}
const suite=new LiveInstallTests();test("acceptance: registered exact live probe drains real native leases and retains physical state before activation acknowledgement",suite.program.bind(suite),480000);
