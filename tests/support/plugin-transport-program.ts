import { readFileSync, writeFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CanonicalJson, PlanningBlockedError, type PluginInstallResult } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, InstalledPluginManager } from '@treeseed-cordis/deployment';
import { PluginInstallationFixture } from '@treeseed-cordis/deployment/testing/plugins';
/** Real fault-injection worker, wrapping the default entry; never a production debug hook. */
class PausedJournalWorker {
    static produce(fixture: PluginInstallationFixture): void {
        const path=join(fixture.root,'paused-worker.ts'),entry=fileURLToPath(new URL('../../src/service-worker.js',import.meta.url)),paused=join(fixture.root,'publication-paused'),resume=join(fixture.root,'publication-resume');
        const publisher=fileURLToPath(new URL('../../src/installed.js',import.meta.url)),requests=join(fixture.installation,'.cordis/plugins/requests');
        const source="import fs from'node:fs';import{InstallationStore}from"+JSON.stringify(publisher)+";import{ServiceWorkerProgram}from"+JSON.stringify(entry)+";class JournalPause{private readonly original=InstallationStore.publish;private paused=false;install():void{InstallationStore.publish=this.publish.bind(this);}private publish(directory:Parameters<typeof InstallationStore.publish>[0],name:string,value:unknown,mode=0o600):void{this.original(directory,name,value,mode);if(directory.path==="+JSON.stringify(requests)+"&&name.startsWith('000000000001.')&&!this.paused){this.paused=true;fs.writeFileSync("+JSON.stringify(paused)+",'paused');const deadline=Date.now()+8000;while(!fs.existsSync("+JSON.stringify(resume)+")){if(Date.now()>=deadline)throw new Error('FIXTURE_PUBLICATION_PAUSE_EXPIRED');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}}}new JournalPause().install();process.exitCode=await ServiceWorkerProgram.run(process.argv.slice(2));\n";
        writeFileSync(path,source);const executable=join(fixture.bundle,'paused-worker'),built=spawnSync('bun',['build',path,'--compile','--target=bun-linux-x64','--outfile',executable],{encoding:'utf8',timeout:120000});if(built.status!==0)throw new Error('Fault worker compilation failed: '+built.stderr);
        const bytes=readFileSync(executable);fixture.runtime.release.composition.worker={path:'paused-worker',sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};fixture.runtime.refreshService();
    }
}
class PluginTransportProgram {
    private static delay(done:(value:void)=>void):void{setTimeout(done,20);}
    private static captured(error: unknown):{error:unknown}{return {error};}
    private static worker(fixture:PluginInstallationFixture):number|undefined{try{const child=JSON.parse(readFileSync(join(fixture.installation,'.cordis/launch/child.json'),'utf8')),file=statSync(join(fixture.installation,'.cordis/worker')),running=statSync('/proc/'+child.pid+'/exe');if(file.dev===running.dev&&file.ino===running.ino&&file.uid===process.getuid?.())return child.pid;}catch{}return undefined;}
    private static async refused(manager:InstalledPluginManager,code:string):Promise<void>{try{await manager.inspect('transport-first');}catch(error){if(error instanceof PlanningBlockedError)for(const blocker of error.blockers)if(blocker.code===code)return;throw error;}throw new Error('TRANSPORT_ACCEPTED_INVALID_IDENTITY:'+code);}
    static async run():Promise<void>{
        const fixture=new PluginInstallationFixture();let resumed=false;
        try{
            await fixture.prepare();await fixture.startRegistry();PausedJournalWorker.produce(fixture);await new ComposeDeploymentHost().plan(fixture.configuration);
            const manager=new InstalledPluginManager(fixture.installation),installing=manager.install({source:fixture.source(),providerId:'extension.unselected',idempotencyKey:'transport-first',installationDirectory:fixture.installation,scope:'installation',target:'deployment',configuration:{}}).catch(this.captured),deadline=Date.now()+20000;
            while(!existsSync(join(fixture.root,'publication-paused'))&&Date.now()<deadline)await new Promise(this.delay);
            if(!existsSync(join(fixture.root,'publication-paused'))){const initial=await installing;if('error'in initial){if(initial.error instanceof PlanningBlockedError){const codes:string[]=[];for(const blocker of initial.error.blockers)codes.push(blocker.code);throw new Error('PUBLICATION_SETUP_BLOCKED:'+codes.join(','));}throw initial.error;}throw new Error('ACTUAL_PUBLICATION_NOT_PAUSED:'+initial.state);}
            const reading=manager.inspect('transport-first').catch(this.captured);
            await new Promise(this.delay);writeFileSync(join(fixture.root,'publication-resume'),'resume');resumed=true;
            const observed=await reading;
            if('error'in observed){if(observed.error instanceof PlanningBlockedError){const codes:string[]=[];for(const blocker of observed.error.blockers)codes.push(blocker.code);throw new Error('LIVE_READ_SAMPLED_MUTABLE_PUBLICATION:'+codes.join(','));}throw observed.error;}
            if(observed.requestId!=='transport-first'||observed.state!=='pending'||observed.activeGeneration!==null)throw new Error('Live read lost exact pending request');
            let accepted:PluginInstallResult|{error:unknown}=await installing;if('error'in accepted)throw accepted.error;
            const settled=Date.now()+120000;while(accepted.state==='pending'&&Date.now()<settled){await new Promise(this.delay);accepted=await manager.inspect('transport-first');}
            if(accepted.state!=='prepared'||accepted.applicationId!==null||!accepted.nextActions.includes('select-provider')||existsSync(join(fixture.installation,'.cordis/credentials')))throw new Error('Publication fixture activated a service');
            const receipt=join(fixture.installation,'.cordis/installation.json'),original=readFileSync(receipt),foreign=JSON.parse(original.toString('utf8'));foreign.installationId='foreign-fixture';
            try{writeFileSync(receipt,CanonicalJson.stringify(foreign)+'\n');await this.refused(manager,'FOREIGN_INSTALLATION');}finally{writeFileSync(receipt,original);}
            try{chmodSync(receipt,0o644);await this.refused(manager,'PRIVATE_PERMISSIONS');}finally{chmodSync(receipt,0o600);}
            const planPath=join(fixture.installation,'.cordis/plans'),launch=JSON.parse(readFileSync(join(fixture.installation,'.cordis/launch/intent.json'),'utf8')),planFile=join(planPath,launch.planId+'.json'),planBytes=readFileSync(planFile),changed=JSON.parse(planBytes.toString('utf8'));changed.configuration.installationId='foreign-fixture';
            try{writeFileSync(planFile,CanonicalJson.stringify(changed)+'\n');await this.refused(manager,'PLAN_BINDING');}finally{writeFileSync(planFile,planBytes);}
            const pid=this.worker(fixture);if(!pid)throw new Error('Owned worker missing');process.kill(pid,'SIGTERM');const stopped=Date.now()+15000;while(existsSync(join(fixture.installation,'.cordis/writer.lock'))&&Date.now()<stopped)await new Promise(this.delay);if(existsSync(join(fixture.installation,'.cordis/writer.lock')))throw new Error('Owner failed to close');
            const head=join(fixture.installation,'.cordis/plugins/head.json'),headBytes=readFileSync(head),badHead=JSON.parse(headBytes.toString('utf8'));badHead.count++;
            try{writeFileSync(head,CanonicalJson.stringify(badHead)+'\n');await this.refused(manager,'PLUGIN_JOURNAL_HEAD');}finally{writeFileSync(head,headBytes);}
            process.stdout.write(JSON.stringify({fixtureOnly:true,actualPausedPublication:true,liveRead:true,noActivation:true})+'\n');
        }finally{
            if(!resumed&&existsSync(fixture.root))writeFileSync(join(fixture.root,'publication-resume'),'resume');
            const pending=this.worker(fixture);if(pending&&existsSync(join(fixture.installation,'.cordis/plugins'))){const deadline=Date.now()+120000;while(Date.now()<deadline){try{const record=await new InstalledPluginManager(fixture.installation).inspect('transport-first');if(record.state!=='pending')break;}catch{}await new Promise(this.delay);}}
            const pid=this.worker(fixture);if(pid){try{process.kill(pid,'SIGTERM');}catch{}const deadline=Date.now()+15000;while(existsSync(join(fixture.installation,'.cordis/writer.lock'))&&Date.now()<deadline)await new Promise(this.delay);if(this.worker(fixture)===pid){try{process.kill(pid,'SIGKILL');}catch{}}}
            await fixture.close();
        }
    }
}
await PluginTransportProgram.run();
