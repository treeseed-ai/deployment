import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {writeFileSync,lstatSync,chmodSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {ServiceReleaseFixture} from './release-fixture.js';
class ReleaseCacheTests {
    async program():Promise<void>{const fixture=await new ServiceReleaseFixture().services();try{const path=join(fixture.root,'release-cache-input.json');writeFileSync(path,JSON.stringify(fixture.configuration));const result=spawnSync('node',['dist/tests/release-cache-program.js',path],{encoding:'utf8',timeout:60000});if(result.status!==0)throw new Error(result.stderr);expect(JSON.parse(result.stdout)).toEqual({fixture:true,exact:true,private:true,allowlisted:true,reused:true,sourceFree:true,tamperRefused:true,noRuntimeEffects:true});}finally{this.writable(fixture.root);fixture.close();}}
    private writable(path:string):void{const stat=lstatSync(path);if(stat.isSymbolicLink())return;if(stat.isDirectory()){chmodSync(path,0o700);for(const name of readdirSync(path))this.writable(join(path,name));}else chmodSync(path,0o600);}
}
const suite=new ReleaseCacheTests();test('smoke: built exact release custody preserves original archives and selected OCI bytes source-free without runtime effects',suite.program.bind(suite),90000);
