import {describe,it,expect} from 'vitest';
import {aiHostingWindowActive,planAiHosting} from '../src/infrastructure/ai-hosting.js';
import {validateManagedServiceCredentials} from '../src/security/services/validate.js';
const schedule={timeZone:'America/New_York',weekdays:[1,2,3,4,5],start:'09:00',end:'17:00',startupLeadMinutes:30,idleAction:'hibernate' as const,activeWorkPolicy:'drain-and-checkpoint' as const};
describe('AI hosting scheduling and custody',()=>{
  it('uses local workdays through DST and includes startup lead time',()=>{
    expect(aiHostingWindowActive(schedule,new Date('2026-03-06T13:30:00Z'))).toBe(true);
    expect(aiHostingWindowActive(schedule,new Date('2026-03-09T12:30:00Z'))).toBe(true);
    expect(aiHostingWindowActive(schedule,new Date('2026-03-09T12:29:00Z'))).toBe(false);
    expect(aiHostingWindowActive(schedule,new Date('2026-03-09T21:00:00Z'))).toBe(false);
    expect(aiHostingWindowActive(schedule,new Date('2026-03-08T14:00:00Z'))).toBe(false);
  });
  it('supports lead time crossing midnight and rejects invalid instants',()=>{
    expect(aiHostingWindowActive({...schedule,start:'00:15'},new Date('2026-03-09T03:50:00Z'))).toBe(true);
    expect(()=>aiHostingWindowActive(schedule,new Date('invalid'))).toThrow();
  });
  it('plans immutable isolated intent without pretending to execute',()=>{
    const input={schemaVersion:'treeseed.ai-hosting-deployment/v1',teamId:'team',projectId:'project',deploymentId:'gpu',environment:'staging',provider:'hyperstack',hostingBindingId:'hosting',components:[{componentId:'ai-inference',releaseDigest:`sha256:${'a'.repeat(64)}`}],machine:{name:'gpu',environmentName:'env',flavorName:'flavor',imageName:'image',keypairName:'key',volumeName:'volume'},gpuAdmission:'exclusive-engine',storage:[{bindingId:'models',purpose:'models',access:'read'}],schedule};
    const plan=planAiHosting(input);
    expect(plan).toEqual(planAiHosting(input));
    expect(plan.stateKey).toBe('teams/team/opentofu/v1/deployments/gpu/environments/staging/stacks/ai-hosting/terraform.tfstate');
    expect(plan.execution.ready).toBe(false);
    expect(plan.requiredBindings).toContainEqual({bindingId:'models',purpose:'models',access:'read',capability:'object-storage'});
  });
  it('checks Hyperstack read-only at its fixed endpoint; never follows redirects',async()=>{
    let calls=0;
    await validateManagedServiceCredentials({providerId:'hyperstack',nonSecretConfig:{}},'hyperstack-runtime',{apiToken:'fixture-secret'},async(url,init)=>{
      calls++;expect(url).toBe('https://infrahub-api.nexgencloud.com/v1/core/environments');
      expect(init?.redirect).toBe('error');expect(new Headers(init?.headers).get('api_key')).toBe('fixture-secret');
      expect(init?.method??'GET').toBe('GET');
      return Response.json({status:true,environments:[]});
    });
    expect(calls).toBe(1);
  });
  it('redacts upstream failures and rejects unexpected profiles',async()=>{
    for(const profile of ['hyperstack-runtime','wrong']) await expect(validateManagedServiceCredentials({providerId:'hyperstack',nonSecretConfig:{}},profile,{apiToken:'fixture-secret'},async()=>{throw new Error('fixture-secret');})).rejects.toThrow(/^Managed service credential validation failed\.$/);
  });
});
