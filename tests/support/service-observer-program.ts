import { readFileSync, rmSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import { ServiceSchemas,type ServicePlan } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, ServiceHostRuntime, ServiceWorkerOwnerClient, ServiceWorkerClient, ServicePlanStore, ServiceRuntimeInspection, LocalDockerCommands } from '@treeseed-cordis/deployment';
class ObserverRace {
    private static readonly original=LocalDockerCommands.prototype.run;private static directory='';static changed=false;static starts=0;
    static install(plan:ServicePlan):void{this.directory=plan.configuration.installationDirectory;LocalDockerCommands.prototype.run=ObserverRace.run;}
    static restore():void{LocalDockerCommands.prototype.run=this.original;}
    private static async run(this:LocalDockerCommands,engine:Parameters<LocalDockerCommands['run']>[0],args:string[],timeout?:number):Promise<string>{
        if(args[0]==='container'&&args[1]==='start')ObserverRace.starts++;
        const result=await ObserverRace.original.call(this,engine,args,timeout);
        if(args[0]==='container'&&args[1]==='create'&&args.some(ObserverRace.mount)){
            const socket=join(ObserverRace.directory,'.cordis/run/host.sock'),backup=join(ObserverRace.directory,'observer-race.sock');renameSync(socket,backup);try{symlinkSync(join(ObserverRace.directory,'.cordis/control/worker.sock'),socket);unlinkSync(socket);}finally{renameSync(backup,socket);}ObserverRace.changed=true;
        }return result;
    }
    private static mount(value:string):boolean{return value.includes('target=/run/cordis-host,readonly');}
}
class ObserverProgram {
    static async run(file: string,mode='normal'): Promise<void> {
        const configuration = ServiceSchemas.configuration.parse(JSON.parse(readFileSync(file, 'utf8'))), plan = await new ComposeDeploymentHost().plan(configuration); if (plan.formatVersion !== 3) throw new Error('Wrong format'); if(mode==='race')ObserverRace.install(plan); const host = await ServiceHostRuntime.start(plan), owner = new ServiceWorkerOwnerClient({ installationDirectory: configuration.installationDirectory }), observer = new ServiceWorkerClient({ installationDirectory: configuration.installationDirectory });
        try {
            const accepted = await owner.submit({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'observer-mounted-fixture' }), until = Date.now() + 90000; let application = await owner.application(accepted.id);
            while (!['completed', 'failed', 'cancelled'].includes(application.phase) && Date.now() < until) { await new Promise(this.delay); application = await owner.application(accepted.id); }
            if(mode==='race'){const current=new ServicePlanStore(configuration.installationDirectory).current();if(application.phase!=='failed'||application.recovery!=='repair-required'||current!==null||!ObserverRace.changed||ObserverRace.starts!==0)throw new Error('Observer replacement was adopted or started');const inspection=spawnSync('docker',['--host',plan.expectedEngine.endpoint,'container','inspect','--format','{{.State.Running}}',plan.projectName+'_observer-17'],{encoding:'utf8'});if(inspection.status!==0||inspection.stdout.trim()!=='false')throw new Error('Uncertain container ran');process.stdout.write(JSON.stringify({fixtureOnly:true,raceRejected:true,started:false,repairRequired:true})+'\n');return;}
            if (application.phase !== 'completed') throw new Error('Observer fixture failed: ' + JSON.stringify(application)); const status = await observer.status(); if (!status.ready || status.services.length !== 1 || new ServicePlanStore(configuration.installationDirectory).records().length !== 1) throw new Error('Observer submitted owner work or was not ready');
            rmSync(configuration.release.directory, { recursive: true }); if (!(await observer.status()).ready) throw new Error('Observer required original sources'); await host.close(); const retained=spawnSync('docker',['--host',plan.expectedEngine.endpoint,'container','inspect','--format','{{.State.Running}}',plan.projectName+'_observer-17'],{encoding:'utf8'});if(retained.status!==0||retained.stdout.trim()!=='true')throw new Error('Host close stopped container');let refused=false;try{await new ServiceRuntimeInspection(plan).service('observer-17');}catch{refused=true;}if(!refused)throw new Error('Closed observer still qualified');
            process.stdout.write(JSON.stringify({ fixtureOnly: true, observerRead: true, readonly: true, ownerDenied: true, measuredEntry: true, sourceFree: true, retained: true }) + '\n');
        } finally { await host.close(); ObserverRace.restore(); }
    }
    private static delay(accept: (value: void) => void): void { setTimeout(accept, 100); }
}
await ObserverProgram.run(process.argv[2]!,process.argv[3]);
