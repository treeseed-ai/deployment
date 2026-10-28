import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createServer,type Socket,type Server} from 'node:net';
import {mkdtempSync,readFileSync,writeFileSync,chmodSync,realpathSync,renameSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {SandboxSocketClient,UnixSocketPlugin,UnixSocketToken} from '../../src/sandbox-channel.js';
import {SafeDirectory} from '../../src/filesystem.js';
import {CordisScope,type ProviderLease} from '@treeseed-cordis/sdk/runtime';

class UnixPeerFixture {
  readonly directory=mkdtempSync(join(tmpdir(),'sandbox-peer-'));
  readonly path=join(this.directory,'control.sock');
  readonly authorityFile=join(this.directory,'authority.json');
  readonly scope={installationId:'installation:fixture',serviceId:'worker',providerGeneration:'a'.repeat(64),serviceGeneration:'b'.repeat(64)};
  private readonly server=createServer(this.connected.bind(this));
  private readonly sockets=new Set<Socket>();
  connections=0;
  corrupt=false;
  constructor(){writeFileSync(this.authorityFile,JSON.stringify(this.authority()),{mode:0o600});}
  authority():object {
    return {credential:'c'.repeat(64),grant:{schemaVersion:'treeseed.sandbox-grant/v1',id:'grant:fixture',revision:1,scope:this.scope,state:'granted',expiresAtEpochMs:Date.now()+60000,operations:['ready','create','inspect','assign','execute','destroy']}};
  }
  async start():Promise<void>{const ready=once(this.server,'listening');this.server.listen(this.path);await ready;chmodSync(this.path,0o600);}
  private connected(socket:Socket):void {this.connections++;this.sockets.add(socket);socket.once('data',this.reply.bind(this,socket));}
  private reply(socket:Socket,bytes:Buffer):void {
    const frame=JSON.parse(bytes.toString());
    assert.equal(frame.credential,'c'.repeat(64));
    const request=frame.request;
    const result={state:'available',configurationDigest:'d'.repeat(64),capabilityVersion:'1.0.0-cordis.1'};
    const response={schemaVersion:request.schemaVersion,requestId:this.corrupt?'foreign':request.requestId,scope:request.scope,operation:'ready',success:true,result,problem:null};
    socket.end(JSON.stringify(response)+'\n');
  }
  client(scope=this.scope):SandboxSocketClient {return new SandboxSocketClient({endpointDirectory:this.directory,authorityFile:this.authorityFile,scope,timeoutMs:1000});}
  async close():Promise<void>{for(const socket of this.sockets)socket.destroy();const closed=once(this.server,'close');this.server.close();await closed;}
}
class SandboxChannelIntegration {
  async peer():Promise<void> {
    const fixture=new UnixPeerFixture();await fixture.start();
    try {
      assert.equal((await fixture.client().ready(new AbortController().signal)).state,'available');
      fixture.corrupt=true;
      await assert.rejects(fixture.client().ready(new AbortController().signal),{message:'SANDBOX_RESPONSE_MISMATCH'});
    } finally {await fixture.close();}
  }
  async scope():Promise<void> {
    const fixture=new UnixPeerFixture();await fixture.start();
    try {
      const client=fixture.client({...fixture.scope,serviceId:'foreign'});
      await assert.rejects(client.ready(new AbortController().signal),{message:'SANDBOX_SCOPE_MISMATCH'});
      assert.equal(fixture.connections,0);
      chmodSync(fixture.authorityFile,0o644);
      await assert.rejects(fixture.client().ready(new AbortController().signal));
      assert.equal(fixture.connections,0);
    } finally {await fixture.close();}
  }
  async descriptor():Promise<void> {
    const root=mkdtempSync(join(tmpdir(),'sandbox-fd-'));
    const directory=SafeDirectory.open(root);
    const scope=await this.native();
    const lease=await scope.acquire(UnixSocketToken);
    const server=createServer();
    try {await this.foreign(directory,lease,server);}
    finally {if(server.listening)server.close();await lease.release();await scope.close();directory.close();}
  }
  private async foreign(directory:SafeDirectory,lease:ProviderLease<{bind(directory:SafeDirectory):Promise<number>}>,server:Server):Promise<void> {
    const fd=await lease.value.bind(directory);
    const listening=once(server,'listening');server.listen({fd});await listening;
    const path=directory.childPath('control.sock');
    renameSync(path,directory.childPath('retained.sock'));
    writeFileSync(path,'foreign-state',{mode:0o600});
    const closed=once(server,'close');server.close();await closed;
    assert.equal(readFileSync(path,'utf8'),'foreign-state');
    assert.equal(existsSync(directory.childPath('retained.sock')),true);
  }
  private async native():Promise<CordisScope> {
    const path=realpathSync('/lib/x86_64-linux-gnu/libc.so.6');
    const sha256=createHash('sha256').update(readFileSync(path)).digest('hex');
    const declaration=UnixSocketPlugin.declaration;
    return CordisScope.start({registrations:[{plugin:UnixSocketPlugin,token:UnixSocketToken,declaration,configuration:{path,sha256},artifact:{kind:'bundled',identity:'fixture-native-unix-io'}}],selections:[{scopeId:'installation:fixture:host',capability:UnixSocketToken.id,providerId:declaration.id}]},{scopeId:'installation:fixture:host',target:'deployment',principalId:'uid:'+process.getuid!(),resourceScope:'installation:fixture'});
  }
}
const suite=new SandboxChannelIntegration();
test('integration: real private Unix client binds matching replies and refuses substituted request identity',suite.peer.bind(suite));
test('integration: private sandbox client denies foreign grant scope and public authority before connection',suite.scope.bind(suite));
test('integration: default native Unix descriptor ownership preserves foreign pathname on listener close',suite.descriptor.bind(suite));
