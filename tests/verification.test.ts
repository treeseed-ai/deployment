import {test,expect} from 'bun:test';
import {readFileSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
class VerificationPartitionTests {
    workflow():void {const workflow=readFileSync('.github/workflows/verify.yml','utf8');expect(workflow).toContain('needs: [checks, smoke]');expect(workflow).toContain('partition: [foundation, transitions]');expect(workflow).toContain('if: always()');expect(workflow).toContain("needs.smoke.result == 'success'");expect(workflow).toContain('bun scripts/verification.ts smoke ${{ matrix.partition }}');}
    inventory():void {const result=spawnSync(process.execPath,['scripts/verification.ts','inventory'],{encoding:'utf8'});expect(result.status).toBe(0);const parts=JSON.parse(result.stdout) as Record<string,string[]>;expect(Object.keys(parts).sort()).toEqual(['foundation','transitions']);const all=[...parts.foundation!,...parts.transitions!];expect(new Set(all).size).toBe(all.length);expect(all.sort()).toEqual(readdirSync('tests').filter(this.testFile).map(this.path).sort());expect(parts.transitions).toEqual(['tests/service-restart.test.ts','tests/service-retained-plan.test.ts']);const invalid=spawnSync(process.execPath,['scripts/verification.ts','smoke','unknown'],{encoding:'utf8'});expect(invalid.status).toBe(2);expect(invalid.stdout).toBe('');}
    private testFile(name:string):boolean{return name.endsWith('.test.ts');}
    private path(name:string):string{return 'tests/'+name;}
}
const suite=new VerificationPartitionTests();
test('unit: aggregate CI gate requires every exhaustive smoke partition',suite.workflow.bind(suite));
test('unit: partition inventory is disjoint exhaustive and rejects unknown groups before execution',suite.inventory.bind(suite));
