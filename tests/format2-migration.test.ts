import {test,expect}from'bun:test';
import{mkdtempSync,existsSync,rmSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{InstallationStore}from'../src/installed.js';
import{PlanningBlockedError}from'@treeseed-cordis/sdk';
class Format2MigrationTests{
 async authorization():Promise<void>{const root=mkdtempSync(join(tmpdir(),'cordis-migration-deny-')),installation=join(root,'missing');try{let code='';try{await Reflect.apply(new InstallationStore(installation).migrate,new InstallationStore(installation),[{from:2,expectedComposition:'a'.repeat(64)}]);}catch(error){if(error instanceof PlanningBlockedError)code=error.blockers[0]!.code;else throw error;}expect(code).toBe('MIGRATION_AUTHORIZATION_REQUIRED');expect(existsSync(installation)).toBe(false);}finally{rmSync(root,{recursive:true,force:true});}}
 async absent():Promise<void>{const root=mkdtempSync(join(tmpdir(),'cordis-migration-absent-')),installation=join(root,'missing');try{let code='';try{await Reflect.apply(new InstallationStore(installation).migrate,new InstallationStore(installation),[{from:2,expectedComposition:'a'.repeat(64),authorization:'non-serving'}]);}catch(error){if(error instanceof PlanningBlockedError)code=error.blockers[0]!.code;else throw error;}expect(code).toBe('MIGRATION_NOT_REQUIRED');expect(existsSync(installation)).toBe(false);}finally{rmSync(root,{recursive:true,force:true});}}
}
const suite=new Format2MigrationTests();
test('integration: explicit format2 migration requires authorization before filesystem access',suite.authorization.bind(suite));
test('integration: default migration construction refuses absent state without creating it',suite.absent.bind(suite));
