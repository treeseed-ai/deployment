import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
class PluginTransportTests {
    program():void{const result=spawnSync(process.execPath,['dist/tests/plugin-transport-program.js'],{encoding:'utf8',timeout:180000});if(result.status!==0)throw new Error(result.stderr);expect(JSON.parse(result.stdout)).toEqual({fixtureOnly:true,actualPausedPublication:true,liveRead:true,noActivation:true});}
}
const suite=new PluginTransportTests();
test('smoke: installed transport reads through the owner during real paused journal publication',suite.program.bind(suite),240000);
