import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
class ServiceImportTests {
    program():void{for(const runtime of ['bun','node'])for(const entry of ['diagnose','service-application','service-host','service-ipc','service-plan']){const file=pathToFileURL(resolve(runtime==='bun'?'src':'dist/src',entry+(runtime==='bun'?'.ts':'.js'))).href,code="class Program{static async run(){await import("+JSON.stringify(file)+");process.stdout.write('cold-import-ok\\n');}}await Program.run();",result=spawnSync(runtime,runtime==='bun'?['--eval',code]:['--input-type=module','-e',code],{encoding:'utf8',timeout:10000});expect(result.stderr).toBe('');expect(result.status).toBe(0);expect(result.stdout).toBe('cold-import-ok\n');}}
}
const imports=new ServiceImportTests();
test("acceptance: fresh Bun and Node service entries initialize independently of warmed modules",imports.program.bind(imports),120000);
