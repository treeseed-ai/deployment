import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PlanningBlockedError, type PluginInstallResult } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, InstalledPluginManager } from '@treeseed-cordis/deployment';
import { PluginInstallationFixture } from '@treeseed-cordis/deployment/testing/plugins';
/** Real fault-injection worker, wrapping the default entry; never a production debug hook. */
class PausedJournalWorker {
    static produce(fixture: PluginInstallationFixture): void {
        const path=join(fixture.root,'paused-worker.ts'),entry=fileURLToPath(new URL('../src/service-worker.js',import.meta.url)),paused=join(fixture.root,'publication-paused'),resume=join(fixture.root,'publication-resume'),target=join(fixture.installation,'.cordis/plugins/head.json');
        const source="import fs,{type PathLike}from'node:fs';import{syncBuiltinESMExports}from'node:module';import{ServiceWorkerProgram}from"+JSON.stringify(entry)+";class JournalPause{private readonly renameOriginal=fs.renameSync;private paused=false;install():void{fs.renameSync=this.rename.bind(this);syncBuiltinESMExports();}private rename(from:PathLike,to:PathLike):void{if(String(to)==="+JSON.stringify(target)+"&&!this.paused){this.paused=true;fs.writeFileSync("+JSON.stringify(paused)+",'paused');const deadline=Date.now()+8000;while(!fs.existsSync("+JSON.stringify(resume)+")){if(Date.now()>=deadline)throw new Error('FIXTURE_PUBLICATION_PAUSE_EXPIRED');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}this.renameOriginal(from,to);}}new JournalPause().install();process.exitCode=await ServiceWorkerProgram.run(process.argv.slice(2));\n";
        writeFileSync(path,source);const executable=join(fixture.bundle,'paused-worker'),built=spawnSync('bun',['build',path,'--compile','--target=bun-linux-x64','--outfile',executable],{encoding:'utf8',timeout:120000});if(built.status!==0)throw new Error('Fault worker compilation failed: '+built.stderr);
        const bytes=readFileSync(executable);fixture.runtime.release.composition.worker={path:'paused-worker',sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};fixture.runtime.refreshService();
    }
}
class PluginTransportProgram {
    private static delay(done:(value:void)=>void):void{setTimeout(done,20);}
    private static captured(error: unknown):{error:unknown}{return {error};}
    private static worker(fixture:PluginInstallationFixture):number|undefined{try{const child=JSON.parse(readFileSync(join(fixture.installation,'.cordis/launch/child.json'),'utf8')),file=statSync(join(fixture.installation,'.cordis/worker')),running=statSync('/proc/'+child.pid+'/exe');if(file.dev===running.dev&&file.ino===running.ino&&file.uid===process.getuid?.())return child.pid;}catch{}return undefined;}
    static async run():Promise<void>{
        const fixture=new PluginInstallationFixture();let resumed=false;
        try{
            await fixture.prepare();await fixture.startRegistry();PausedJournalWorker.produce(fixture);await new ComposeDeploymentHost().plan(fixture.configuration);
            const manager=new InstalledPluginManager(fixture.installation),installing=manager.install({source:fixture.source(),providerId:'extension.unselected',idempotencyKey:'transport-first',installationDirectory:fixture.installation,scope:'installation',target:'deployment',configuration:{}}).catch(this.captured),deadline=Date.now()+20000;
            while(!existsSync(join(fixture.root,'publication-paused'))&&Date.now()<deadline)await new Promise(this.delay);
            if(!existsSync(join(fixture.root,'publication-paused')))throw new Error('ACTUAL_PUBLICATION_NOT_PAUSED');
            const reading=manager.inspect('transport-first').catch(this.captured);
            await new Promise(this.delay);writeFileSync(join(fixture.root,'publication-resume'),'resume');resumed=true;
            const observed=await reading;
            if('error'in observed){if(observed.error instanceof PlanningBlockedError){const codes:string[]=[];for(const blocker of observed.error.blockers)codes.push(blocker.code);throw new Error('LIVE_READ_SAMPLED_MUTABLE_PUBLICATION:'+codes.join(','));}throw observed.error;}
            if(observed.requestId!=='transport-first'||observed.state!=='pending'||observed.activeGeneration!==null)throw new Error('Live read lost exact pending request');
            let accepted:PluginInstallResult|{error:unknown}=await installing;if('error'in accepted)throw accepted.error;
            const settled=Date.now()+120000;while(accepted.state==='pending'&&Date.now()<settled){await new Promise(this.delay);accepted=await manager.inspect('transport-first');}
            if(accepted.state!=='prepared'||accepted.applicationId!==null||!accepted.nextActions.includes('select-provider')||existsSync(join(fixture.installation,'.cordis/credentials')))throw new Error('Publication fixture activated a service');
            process.stdout.write(JSON.stringify({fixtureOnly:true,actualPausedPublication:true,liveRead:true,noActivation:true})+'\n');
        }finally{
            if(!resumed&&existsSync(fixture.root))writeFileSync(join(fixture.root,'publication-resume'),'resume');
            const pid=this.worker(fixture);if(pid){try{process.kill(pid,'SIGTERM');}catch{}const deadline=Date.now()+15000;while(existsSync(join(fixture.installation,'.cordis/writer.lock'))&&Date.now()<deadline)await new Promise(this.delay);if(this.worker(fixture)===pid){try{process.kill(pid,'SIGKILL');}catch{}}}
            await fixture.close();
        }
    }
}
await PluginTransportProgram.run();
