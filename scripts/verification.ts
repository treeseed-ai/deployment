import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
/** Development-only test scheduling; every file belongs to exactly one smoke job. */
export class VerificationPartitions {
    static readonly transitions=['tests/service-restart.test.ts','tests/service-retained-plan.test.ts'];
    static inventory(files=readdirSync('tests').filter(this.testFile).map(this.path)):Record<string,string[]> {
        const result:Record<string,string[]>={foundation:[],transitions:[]};
        if(new Set(files).size!==files.length||files.length===0)throw new Error('INVALID_TEST_INVENTORY');
        for(const file of files){if(!/^tests\/[a-z0-9-]+\.test\.ts$/.test(file))throw new Error('INVALID_TEST_INVENTORY');result[this.transitions.includes(file)?'transitions':'foundation']!.push(file);}
        for(const required of this.transitions)if(!files.includes(required))throw new Error('MISSING_TRANSITION_TEST');
        for(const group of Object.values(result)){if(group.length===0)throw new Error('EMPTY_TEST_PARTITION');group.sort();}
        return result;
    }
    private static testFile(name:string):boolean{return name.endsWith('.test.ts');}
    private static path(name:string):string{return 'tests/'+name;}
    static run(args:string[]):number {
        try {const inventory=this.inventory();if(args.length===1&&args[0]==='inventory'){process.stdout.write(JSON.stringify(inventory)+'\n');return 0;}
            if(args.length!==2||args[0]!=='smoke'||!Object.hasOwn(inventory,args[1]!))return 2;
            const result=spawnSync(process.execPath,['test',...inventory[args[1]!]!,'--test-name-pattern','^smoke:'],{stdio:'inherit'});return result.status??1;
        }catch{return 2;}
    }
}
if(import.meta.main)process.exitCode=VerificationPartitions.run(process.argv.slice(2));
