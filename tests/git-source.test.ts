import { test, expect } from 'bun:test';
import { writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ServiceReleaseFixture } from './release-fixture.js';
import { PluginFixtureTools } from './plugin-installation-fixture.js';
import { GitFixtureTools } from './git-source-fixture.js';
class GitSourceTests {
    async program(mode:'resolution'|'archive'|'closure'='resolution'):Promise<void>{
        const archive=mode!=='resolution';
        const fixture=await new ServiceReleaseFixture().services();
        try{
            await PluginFixtureTools.tools(fixture);PluginFixtureTools.certificates(fixture);await GitFixtureTools.helper(fixture);const identity=GitFixtureTools.repository(fixture);if(mode==='closure')await GitFixtureTools.runtime(fixture);fixture.refreshService();
            const input=join(fixture.root,'git-source.json'),executable=join(fixture.root,archive?'git-archive-program':'git-source-program');writeFileSync(input,JSON.stringify({root:fixture.root,configuration:fixture.configuration,identity}));PluginFixtureTools.command(process.execPath,['build',archive?'dist/tests/git-archive-program.js':'dist/tests/git-source-program.js','--compile','--target=bun-linux-x64','--outfile',executable]);
            const path=join(fixture.root,'docker-only');mkdirSync(path);const docker=spawnSync('which',['docker'],{encoding:'utf8'});if(docker.status!==0)throw new Error('Docker prerequisite missing');symlinkSync(docker.stdout.trim(),join(path,'docker'));
            const result=spawnSync(executable,[input,mode],{encoding:'utf8',timeout:240000,env:{PATH:path,HOME:fixture.root,DOCKER_CONFIG:process.env.DOCKER_CONFIG,NPM_TOKEN:'NEVER_INHERIT',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: NEVER_INHERIT',HTTPS_PROXY:'http://127.0.0.1:1'}});if(result.status!==0)throw new Error(result.stderr);
            if(mode==='closure')expect(JSON.parse(result.stdout)).toEqual({fixtureOnly:true,native:true,exact:true,sourceFree:true,closure:true,dependency:true,noScripts:true,noActivation:true});else if(archive)expect(JSON.parse(result.stdout)).toEqual({fixtureOnly:true,native:true,exact:true,sourceFree:true,tamperRefused:true,noScripts:true,noActivation:true});else expect(JSON.parse(result.stdout)).toEqual({fixtureOnly:true,native:true,exact:true,moved:true,sourceFree:true,ambiguous:true,denied:true,noActivation:true});
        }finally{PluginFixtureTools.writable(fixture.root);fixture.close();}
    }
}
const suite=new GitSourceTests();
test('smoke: native managed Git resolves approved HTTPS commits once and preserves exact source-free readback',suite.program.bind(suite,'resolution'),300000);

test('smoke: native Git archive custody pins exact trees and refuses tampered source-free artifacts',suite.program.bind(suite,'archive'),300000);

test('smoke: native Git acquisition verifies complete approved runtime closure and source-free receipts',suite.program.bind(suite,'closure'),300000);
