import {test,expect} from 'bun:test';
import {createServer,type Server} from 'node:net';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FixtureListeners,FixturePublications} from './fixture-listeners.js';
class ListenerTests{
    private readonly server:Server=createServer();
    private listen(done:(value:void)=>void):void{this.server.listen(0,'127.0.0.1',done);}
    private close(done:(value:void)=>void):void{this.server.close(this.closed.bind(this,done));}
    private closed(done:(value:void)=>void):void{done();}
    async actual():Promise<void>{const root=mkdtempSync(join(tmpdir(),'cordis-listener-evidence-')),file=join(root,'child.ts');writeFileSync(file,"import{createServer}from'node:net';class ChildListener{static readonly server=createServer();static run():void{this.server.listen(0,'127.0.0.1',this.ready.bind(this));}static ready():void{process.stdout.write(JSON.stringify(this.server.address())+'\\n');}}ChildListener.run();\n");const child=Bun.spawn([process.execPath,file],{stdout:'pipe',stderr:'pipe'});try{const reader=child.stdout.getReader(),first=await reader.read();reader.releaseLock();if(!first.value)throw new Error('Child listener prerequisite missing');const childPort=JSON.parse(new TextDecoder().decode(first.value)).port as number,hex=childPort.toString(16).toUpperCase().padStart(4,'0');const before=FixtureListeners.sample(),owned=FixtureListeners.sample(child.pid);expect(owned.length).toBe(1);expect(owned[0]).toContain(':'+hex);expect(before).toContain(owned[0]!);await new Promise<void>(this.listen.bind(this));expect(FixtureListeners.sample()).not.toEqual(before);expect(FixtureListeners.sample(child.pid)).toEqual(owned);}finally{await new Promise<void>(this.close.bind(this));child.kill();await child.exited;rmSync(root,{recursive:true});}}
    publications():void{FixturePublications.assert([],{});expect(FixturePublications.assert.bind(null,[],{'8080/tcp':[{HostIp:'127.0.0.1',HostPort:'12345'}]})).toThrow('FIXTURE_PORT_PUBLICATION_CHANGED');FixturePublications.assert([{id:'https',target:443,publication:{host:'127.0.0.1',port:8443}}],{'443/tcp':[{HostIp:'127.0.0.1',HostPort:'8443'}]});expect(FixturePublications.assert.bind(null,[{id:'https',target:443,publication:{host:'127.0.0.1',port:8443}}],{'443/tcp':[{HostIp:'0.0.0.0',HostPort:'8443'}]})).toThrow('FIXTURE_PORT_PUBLICATION_CHANGED');}
}
const suite=new ListenerTests();
test('unit: actual TCP ownership includes descendants and excludes parent activity from child scope',suite.actual.bind(suite));
test('unit: Docker publication evidence refuses unexpected private or changed public bindings',suite.publications.bind(suite));
