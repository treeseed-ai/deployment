import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
/** Development-only test scheduling; every file belongs to exactly one smoke job. */
export class VerificationPartitions {
    static readonly transitions=['tests/acceptance/service-restart.test.ts','tests/acceptance/service-retained-plan.test.ts'];
    static readonly sources=['tests/acceptance/npm-source.test.ts','tests/acceptance/git-source.test.ts','tests/acceptance/git-build.test.ts'];
    static readonly runtime=['tests/acceptance/service-application.test.ts','tests/acceptance/service-authority.test.ts'];
    static inventory(files=readdirSync('tests/acceptance').filter(this.testFile).map(this.path)):Record<string,string[]> {
        const result:Record<string,string[]>={foundation:[],transitions:[],sources:[],runtime:[],'git-installed':[],registered:[],'build-registered':[]};
        if(new Set(files).size!==files.length||files.length===0)throw new Error('INVALID_TEST_INVENTORY');
        for(const file of files){if(!/^tests\/acceptance\/[a-z0-9-]+\.test\.ts$/.test(file))throw new Error('INVALID_TEST_INVENTORY');const group=file==='tests/acceptance/build-registered-install.test.ts'?'build-registered':['tests/acceptance/registered-install.test.ts','tests/acceptance/git-registered-install.test.ts'].includes(file)?'registered':file==='tests/acceptance/git-install.test.ts'?'git-installed':this.transitions.includes(file)?'transitions':this.sources.includes(file)?'sources':this.runtime.includes(file)||file.endsWith('-install.test.ts')?'runtime':'foundation';result[group]!.push(file);}
        for(const required of [...this.transitions,...this.sources,...this.runtime,'tests/acceptance/git-install.test.ts','tests/acceptance/registered-install.test.ts','tests/acceptance/git-registered-install.test.ts','tests/acceptance/build-registered-install.test.ts'])if(!files.includes(required))throw new Error('MISSING_REQUIRED_TEST');
        for(const group of Object.values(result)){if(group.length===0)throw new Error('EMPTY_TEST_PARTITION');group.sort();}
        return result;
    }
    private static testFile(name:string):boolean{return name.endsWith('.test.ts');}
    private static path(name:string):string{return 'tests/acceptance/'+name;}
    static run(args:string[]):number {
        try {const inventory=this.inventory();if(args.length===1&&args[0]==='inventory'){process.stdout.write(JSON.stringify(inventory)+'\n');return 0;}
            if(args.length!==2||args[0]!=='smoke'||!Object.hasOwn(inventory,args[1]!))return 2;
            const result=spawnSync(process.execPath,['test',...inventory[args[1]!]!],{stdio:'inherit'});return result.status??1;
        }catch{return 2;}
    }
}
if(import.meta.main)process.exitCode=VerificationPartitions.run(process.argv.slice(2));
