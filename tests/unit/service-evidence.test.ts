import { test, expect } from 'bun:test';
import { ServiceSchemas, PlanningBlockedError } from '@treeseed-cordis/sdk';
import { ServiceAcknowledgements } from '../../src/service-application.js';
/** Pure admission inputs; the API installed-root smoke supplies actual direct/routed evidence. */
class EvidenceTests {
    private evidence() { return ServiceSchemas.acknowledgement.parse({target:'api',scopeId:'installation:fixture:service:api-main',generation:'a'.repeat(64),runtimeGeneration:'b'.repeat(64),observationDigest:'c'.repeat(64),ready:true}); }
    private denied(set: ServiceAcknowledgements, value: ReturnType<typeof ServiceSchemas.acknowledgement.parse>): void {let caught:unknown;try{set.add(value);}catch(error){caught=error;}expect(caught).toBeInstanceOf(PlanningBlockedError);expect((caught as PlanningBlockedError).blockers.map(EvidenceTests.code)).toEqual(['INVALID_TARGET_ACKNOWLEDGEMENT']);}
    private static code(value:{code:string}):string{return value.code;}
    identical(): void { const first=this.evidence(),set=new ServiceAcknowledgements(first.generation);set.add(first);set.add({...first});expect(set.values()).toEqual([first]); }
    conflict(): void { for(const field of ['runtimeGeneration','observationDigest'] as const){const first=this.evidence(),set=new ServiceAcknowledgements(first.generation);set.add(first);this.denied(set,{...first,[field]:'d'.repeat(64)});expect(set.values()).toEqual([first]);} }
    invalid(): void { const first=this.evidence();for(const changed of [{...first,generation:'d'.repeat(64)},{...first,ready:false}]){const set=new ServiceAcknowledgements(first.generation);this.denied(set,changed);expect(set.values()).toEqual([]);} }
    distinct(): void {const first=this.evidence(),second={...first,scopeId:'installation:fixture:service:z'},set=new ServiceAcknowledgements(first.generation);set.add(second);set.add(first);expect(set.values()).toEqual([first,second]);}
}
const evidence=new EvidenceTests();
test('unit: identical direct and routed target evidence coalesces',evidence.identical.bind(evidence));
test('unit: repeated target runtime or observation conflicts fail without replacing evidence',evidence.conflict.bind(evidence));
test('unit: unready and stale composition evidence cannot be accepted',evidence.invalid.bind(evidence));
test('unit: distinct target scopes remain separate and deterministically sorted',evidence.distinct.bind(evidence));
