import {z} from 'zod';
export const developmentContainerSchema=z.object({operation:z.literal('development.container'),
  sessionId:z.string().regex(/^dev-[a-z0-9-]{1,64}$/),targetId:z.enum(['service','operations-runner']),
  action:z.enum(['start','stop','status','logs'])}).strict();
