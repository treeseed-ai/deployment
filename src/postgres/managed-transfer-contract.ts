import { z } from 'zod';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { postgresTransferIntentSchema } from './transfer.js';

const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const id=z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/u);
const container=z.string().regex(/^[a-f0-9]{64}$/u);
export const managedPostgresTransferSelectionSchema=z.object({
  componentId:id,serviceId:id,requirementId:id,generation:z.number().int().positive().safe(),backupDigest:digest,
  allowLocaleConversion:z.boolean(),selections:z.array(z.object({componentId:id,
    release:z.string().regex(/^[0-9][a-zA-Z0-9.+~-]{0,127}$/u)}).strict()).min(1).max(128)
    .refine(value=>new Set(value.map(item=>item.componentId)).size===value.length,'Distinct installed component selections required'),
}).strict();
export type ManagedPostgresTransferSelection=z.infer<typeof managedPostgresTransferSelectionSchema>;
export const managedPostgresTransferPlanSchema=z.object({
  schemaVersion:z.literal('treeseed.managed-postgres-transfer-plan/v1'),
  intent:postgresTransferIntentSchema,intentDigest:digest,
  sourceNetworks:z.object({container,networks:z.array(container).max(128),digest}).strict(),
  targetContainerDigest:digest,configurationDigest:digest,componentDigest:digest,selectionDigest:digest,planDigest:digest,
}).strict().superRefine((value,context)=>{
  const {planDigest,...descriptor}=value;
  if(planDigest!==deploymentDigest(descriptor) || value.intentDigest!==deploymentDigest(value.intent))
    context.addIssue({code:'custom',message:'Exact managed PostgreSQL transfer plan required'});
});
export type ManagedPostgresTransferPlan=z.infer<typeof managedPostgresTransferPlanSchema>;
