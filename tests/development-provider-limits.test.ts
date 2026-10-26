import {expect,it} from 'vitest';
import {providerDailyLimitChange} from '../src/supervisor/development-agent-container.js';
const policy=()=>({schemaVersion:5,adapters:[{id:'implementation',model:{id:'original-model'},nativeLimits:{modelConfigurationId:'original-model',dailyActiveSecondsLimit:28800,capabilityLimits:{acting:{dailyActiveSecondsLimit:28800,maximumAssignmentSeconds:3600}}}}],lanes:[{id:'workday'}]});
it('recognizes prospective shared/capability allowance changes while retaining all other policy',()=>{
 const old=policy(),next=policy();next.adapters[0]!.nativeLimits.dailyActiveSecondsLimit=57600;next.adapters[0]!.nativeLimits.capabilityLimits.acting.dailyActiveSecondsLimit=57600;
 expect(providerDailyLimitChange(JSON.stringify(old),JSON.stringify(next))).toBe(true);
 expect(providerDailyLimitChange(JSON.stringify(old),JSON.stringify(old))).toBe(false);
});
it.each(['identity','model','capability','assignment-limit','lanes','malformed','negative'])('refuses %s change as an allowance-only update',shape=>{
 const old=policy(),next=policy();let text:string;
 if(shape==='identity')next.adapters[0]!.id='another';
 if(shape==='model')next.adapters[0]!.nativeLimits.modelConfigurationId='another';
 if(shape==='capability')Object.assign(next.adapters[0]!.nativeLimits.capabilityLimits,{newCapability:{dailyActiveSecondsLimit:28800}});
 if(shape==='assignment-limit')next.adapters[0]!.nativeLimits.capabilityLimits.acting.maximumAssignmentSeconds=7200;
 if(shape==='lanes')next.lanes[0]!.id='communication';
 if(shape==='negative')next.adapters[0]!.nativeLimits.dailyActiveSecondsLimit=-1;
 text=shape==='malformed'?'schemaVersion: [':JSON.stringify(next);
 expect(providerDailyLimitChange(JSON.stringify(old),text)).toBe(false);
});
