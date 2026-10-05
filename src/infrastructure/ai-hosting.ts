import { AI_HOSTING_TARGETS, aiHostingDeploymentSchema, aiHostingScheduleSchema, deploymentDigest, hostedTopologyStateKey, type AiHostingSchedule } from '@treeseed/sdk/deployment';

/** Pure catalog planning: no credential resolution, cloud requests or billable operations. */
export function planAiHosting(input: unknown) {
  const deployment = aiHostingDeploymentSchema.parse(input);
  const targets = deployment.components.map(component => ({...AI_HOSTING_TARGETS.find(target => target.id === component.componentId)!, ...component}));
  return {
    schemaVersion:'treeseed.ai-hosting-plan/v1' as const,
    digest:deploymentDigest(deployment), deployment, targets,
    stateKey:hostedTopologyStateKey({...deployment,stackId:'ai-hosting'}),
    requiredBindings:[
      ...targets.map(target=>({bindingId:deployment.hostingBindingId,capability:target.capability,purpose:'hosting' as const})),
      ...deployment.storage.map(storage=>({...storage,capability:'object-storage' as const})),
    ],
    runtime:{components:targets.map(target=>target.componentId),gpuAdmission:deployment.gpuAdmission,credentialDelivery:'authorized-operation-session'},
    infrastructure:{driver:'opentofu',providerSource:'NexGenCloud/hyperstack',resourceType:'hyperstack_core_virtual_machine'},
    execution:{ready:false,blockers:['hyperstack-managed-acceptance-required']},
    warnings:[
      'Saving a service connection or planning does not rent a GPU.',
      'SHUTOFF remains billable. Hibernation retains storage/IP charges and restore capacity is not guaranteed.',
      'Drain and verify durable checkpoints before hibernation. Refresh authorized storage access on resume.',
    ],
  };
}

/** Evaluate wall-clock windows in the requested zone; both repeated DST minutes belong to the window. */
export function aiHostingWindowActive(input: AiHostingSchedule, instant: Date) {
  const schedule = aiHostingScheduleSchema.parse(input);
  if (!Number.isFinite(instant.getTime())) throw new Error('A valid evaluation time is required.');
  const parts = new Intl.DateTimeFormat('en-US',{timeZone:schedule.timeZone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(instant);
  const part = (type:string)=>parts.find(item=>item.type===type)!.value;
  const day = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(part('weekday'))+1;
  const minute = Number(part('hour'))*60+Number(part('minute'));
  const minutes = (value:string)=>Number(value.slice(0,2))*60+Number(value.slice(3));
  const start = minutes(schedule.start)-schedule.startupLeadMinutes, end = minutes(schedule.end);
  const today = schedule.weekdays.includes(day)&&minute>=Math.max(0,start)&&minute<end;
  const nextDay = day===7?1:day+1;
  return today || (start<0&&schedule.weekdays.includes(nextDay)&&minute>=1440+start);
}
