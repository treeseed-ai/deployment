import{test,expect}from'bun:test';
import{writeFileSync,mkdirSync,symlinkSync}from'node:fs';
import{join}from'node:path';
import{spawnSync}from'node:child_process';
import{PluginInstallationFixture,PluginFixtureTools}from'@treeseed-cordis/deployment/testing/plugins';
import{ServiceRuntimeFixture}from'../support/service-runtime-fixture.js';
import{GitFixtureTools}from'../support/git-source-fixture.js';
class GitInstallTests{
    async program(mode:'fresh'|'retained'|'built'='fresh'):Promise<void>{const fixture=await new PluginInstallationFixture().prepare();try{await GitFixtureTools.helper(fixture.runtime);const gitIdentity=GitFixtureTools.installationRepository(fixture.runtime),gitBuild=mode==='built'?{...GitFixtureTools.buildRepository(fixture.runtime),image:ServiceRuntimeFixture.base}:undefined;fixture.runtime.refreshService();const fresh=mode==='fresh',name=fresh?'installed-plugin-program':'plugin-install-program',input=join(fixture.root,'git-install.json'),executable=join(fixture.root,name);writeFileSync(input,JSON.stringify({root:fixture.root,configuration:fixture.configuration,gitIdentity,gitBuild,selection:mode!=='fresh'}));PluginFixtureTools.command(process.execPath,['build','dist/tests/'+name+'.js','--compile','--target=bun-linux-x64','--outfile',executable]);const path=join(fixture.root,'docker-only');mkdirSync(path);const docker=spawnSync('which',['docker'],{encoding:'utf8'});if(docker.status!==0)throw new Error('Docker prerequisite missing');symlinkSync(docker.stdout.trim(),join(path,'docker'));const result=spawnSync(executable,[input],{encoding:'utf8',timeout:420000,env:{PATH:path,HOME:fixture.root,DOCKER_CONFIG:process.env.DOCKER_CONFIG,NPM_TOKEN:'NEVER_INHERIT',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: NEVER_INHERIT'}});if(result.status!==0)throw new Error(result.stderr);expect(JSON.parse(result.stdout)).toEqual(fresh?{fixtureOnly:true,freshOwner:true,active:true,sourceFree:true,noScripts:true}:{fixtureOnly:true,services:6,active:true,alreadyActive:true,unsafePrepared:true,retained:true,sourceFree:true,noScripts:true});}finally{await fixture.close();}}
}
const suite=new GitInstallTests();
test("acceptance: default installed Git manager starts the exact durable owner and replays accepted bytes source-free",suite.program.bind(suite,'fresh'),480000);
test("acceptance: genuine Git install shares the typed retained-resource and unsafe-replacement contract",suite.program.bind(suite,'retained'),480000);
test("acceptance: approved built-source Git install retains resources through the same native activation path",suite.program.bind(suite,'built'),480000);
