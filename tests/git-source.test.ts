import { test, expect } from 'bun:test';
import { writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ServiceReleaseFixture } from './release-fixture.js';
import { PluginFixtureTools } from './plugin-installation-fixture.js';
import { GitFixtureTools } from './git-source-fixture.js';
class GitSourceTests {
    async program():Promise<void>{
        const fixture=await new ServiceReleaseFixture().services();
        try{
            await PluginFixtureTools.tools(fixture);PluginFixtureTools.certificates(fixture);await GitFixtureTools.helper(fixture);const identity=GitFixtureTools.repository(fixture.root);fixture.refreshService();
            const input=join(fixture.root,'git-source.json'),executable=join(fixture.root,'git-source-program');writeFileSync(input,JSON.stringify({root:fixture.root,configuration:fixture.configuration,identity}));PluginFixtureTools.command(process.execPath,['build','dist/tests/git-source-program.js','--compile','--target=bun-linux-x64','--outfile',executable]);
            const path=join(fixture.root,'docker-only');mkdirSync(path);const docker=spawnSync('which',['docker'],{encoding:'utf8'});if(docker.status!==0)throw new Error('Docker prerequisite missing');symlinkSync(docker.stdout.trim(),join(path,'docker'));
            const result=spawnSync(executable,[input],{encoding:'utf8',timeout:240000,env:{PATH:path,HOME:fixture.root,DOCKER_CONFIG:process.env.DOCKER_CONFIG,NPM_TOKEN:'NEVER_INHERIT',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: NEVER_INHERIT',HTTPS_PROXY:'http://127.0.0.1:1'}});if(result.status!==0)throw new Error(result.stderr);
            expect(JSON.parse(result.stdout)).toEqual({fixtureOnly:true,native:true,exact:true,moved:true,sourceFree:true,ambiguous:true,denied:true,noActivation:true});
        }finally{PluginFixtureTools.writable(fixture.root);fixture.close();}
    }
}
const suite=new GitSourceTests();
test('smoke: native managed Git resolves approved HTTPS commits once and preserves exact source-free readback',suite.program.bind(suite),300000);
