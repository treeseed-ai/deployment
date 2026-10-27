import { test, expect } from 'bun:test';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstallationStore } from '../../src/installed.js';
import { PlanningBlockedError } from '@treeseed-cordis/sdk';
class Format2MigrationTests {
    async authorization(): Promise<void> { const root = mkdtempSync(join(tmpdir(), 'cordis-migration-deny-')), installation = join(root, 'missing'); try {
        let code = '';
        try {
            await Reflect.apply(new InstallationStore(installation).migrate, new InstallationStore(installation), [{ from: 2, expectedComposition: 'a'.repeat(64) }]);
        }
        catch (error) {
            if (error instanceof PlanningBlockedError)
                code = error.blockers[0]!.code;
            else
                throw error;
        }
        expect(code).toBe('MIGRATION_AUTHORIZATION_REQUIRED');
        expect(existsSync(installation)).toBe(false);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    } }
    async absent(): Promise<void> { const root = mkdtempSync(join(tmpdir(), 'cordis-migration-absent-')), installation = join(root, 'missing'); try {
        let code = '';
        try {
            await Reflect.apply(new InstallationStore(installation).migrate, new InstallationStore(installation), [{ from: 2, expectedComposition: 'a'.repeat(64), authorization: 'non-serving' }]);
        }
        catch (error) {
            if (error instanceof PlanningBlockedError)
                code = error.blockers[0]!.code;
            else
                throw error;
        }
        expect(code).toBe('MIGRATION_NOT_REQUIRED');
        expect(existsSync(installation)).toBe(false);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    } }
}
const suite = new Format2MigrationTests();
test('integration: explicit format2 migration requires authorization before filesystem access', suite.authorization.bind(suite));
test('integration: default migration construction refuses absent state without creating it', suite.absent.bind(suite));
import { mkdirSync, writeFileSync } from 'node:fs';
import { ServicePlanStore } from '../../src/service-plan.js';
import { Format2Migration } from '../../src/format2-migration.js';
class InterruptedMigrationTests {
    interrupted(): void { const root = mkdtempSync(join(tmpdir(), 'cordis-migration-interrupted-')), state = join(root, '.cordis'); try {
        mkdirSync(state, { mode: 0o700 });
        mkdirSync(join(state, 'migration-2-to-3'), { mode: 0o700 });
        writeFileSync(join(state, 'migration-2-to-3/intent.json'), '{}', { mode: 0o600 });
        let code = '';
        try {
            new ServicePlanStore(root).inspect();
        }
        catch (error) {
            if (error instanceof PlanningBlockedError)
                code = error.blockers[0]!.code;
            else
                throw error;
        }
        expect(code).toBe('MIGRATION_REPAIR_REQUIRED');
        expect(Format2Migration.read.bind(null, root)).toThrow(PlanningBlockedError);
        expect(existsSync(join(state, 'installation.json'))).toBe(false);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    } }
}
const interrupted = new InterruptedMigrationTests();
test('integration: interrupted migration fences readers without adopting or overwriting uncertain state', interrupted.interrupted.bind(interrupted));

class CanonicalMigrationTests {
 async scope():Promise<void>{const root=mkdtempSync(join(tmpdir(),'cordis-migration-scope-'));try{let code='';try{await Format2Migration.run(root+'/unused/../missing',{from:2,authorization:'non-serving',expectedComposition:'a'.repeat(64)});}catch(error){if(error instanceof PlanningBlockedError)code=error.blockers[0]!.code;else throw error;}expect(code).toBe('MIGRATION_SCOPE');expect(existsSync(join(root,'missing'))).toBe(false);}finally{rmSync(root,{recursive:true,force:true});}}
}
const canonical=new CanonicalMigrationTests();test('integration: direct migration rejects ambiguous paths before scope publication',canonical.scope.bind(canonical));
