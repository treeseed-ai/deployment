import {test,expect} from 'bun:test';
import {createServer,type Server,Socket} from 'node:net';
import {mkdtempSync,mkdirSync,chmodSync,rmSync,symlinkSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ServiceSchemas,CanonicalJson,PlanningBlockedError} from '@treeseed-cordis/sdk';
import {ServiceWorkerClient} from '../../src/diagnose.js';
export class ObserverFixture {
 root='';path='';server:Server|undefined;mode='status';readonly operations:string[]=[];readonly connections=new Set<Socket>();
 async start():Promise<void>{this.root=mkdtempSync(join(tmpdir(),'cordis-service-ipc-'));const state=join(this.root,'.cordis'),run=join(state,'run');mkdirSync(state,{mode:0o700});mkdirSync(run,{mode:0o700});this.path=join(run,'host.sock');this.server=createServer(this.connection.bind(this));await new Promise<void>(this.listen.bind(this));chmodSync(this.path,0o600);}
 private listen(resolve:()=>void,reject:(error:Error)=>void):void{this.server!.once('error',reject);this.server!.listen(this.path,resolve);}
 private connection(socket:Socket):void{this.connections.add(socket);socket.on('data',this.data.bind(this,socket));socket.once('close',this.closed.bind(this,socket));}
 private closed(socket:Socket):void{this.connections.delete(socket);}
 private data(socket:Socket,bytes:Buffer):void{const request=JSON.parse(bytes.toString());this.operations.push(request.operation);if(this.mode==='timeout')return;if(this.mode==='oversized'){socket.end(Buffer.alloc(4*1024*1024+1,32));return;}if(this.mode==='duplicate'){socket.end('{"protocol":3,"protocol":3,"success":true,"result":{}}\n');return;}if(this.mode==='runtime'||this.mode==='blocked'){socket.end(JSON.stringify({protocol:3,success:false,kind:this.mode,blockers:[{code:'STALE_GENERATION',message:'CANARY_PRIVATE_WORKER_ERROR'}]})+'\n');return;}if(this.mode==='malformed'){socket.end('CANARY_PRIVATE_WORKER_ERROR\n');return;}if(this.mode==='replaced'){renameSync(this.path,this.path+'.old');symlinkSync(this.path+'.old',this.path);}const result=this.mode==='wrong-result'?{id:'app-'+'c'.repeat(64),accepted:true}:request.operation==='application'?this.application():this.status();socket.end(CanonicalJson.stringify({protocol:3,success:true,result})+'\n');}
 status(){return ServiceSchemas.status.parse({formatVersion:3,installationId:'fixture',engine:'default',desiredComposition:'a'.repeat(64),activeComposition:'a'.repeat(64),ready:true,plugins:[],blockers:[],applicationId:null,services:[],resourceSetDigest:'b'.repeat(64),acknowledgements:[]});}
 application(){return ServiceSchemas.applicationRecord.parse({formatVersion:3,id:'app-'+'c'.repeat(64),planId:'plan-'+'d'.repeat(64),digest:'d'.repeat(64),idempotencyKey:'fixture-request',requestDigest:'c'.repeat(64),sequence:1,phase:'completed',desiredComposition:'a'.repeat(64),activeComposition:'a'.repeat(64),result:'ready',recovery:null,historyReference:'.cordis/applications/app-'+'c'.repeat(64),expectedComposition:null,resourceSetDigest:'b'.repeat(64),acknowledgements:[]});}
 async close():Promise<void>{for(const socket of this.connections)socket.destroy();if(this.server)await new Promise<void>(this.closeServer.bind(this));if(this.root)rmSync(this.root,{recursive:true,force:true});}
 private closeServer(resolve:()=>void):void{this.server!.close(ObserverFixture.done.bind(null,resolve));}
 private static done(resolve:()=>void):void{resolve();}
}
export class ServiceObserverTests {
 protected static construct(socket:string):void{new ServiceWorkerClient({socket});}
}
