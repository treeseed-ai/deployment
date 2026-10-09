import { expect, it, vi } from 'vitest';
import { host } from './fixtures.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';
const boundary=vi.hoisted(()=>({request:vi.fn(async()=>({ready:false,inventory:{complete:true}}))}));
vi.mock('../src/core/configuration.js',async original=>({...await original<typeof import('../src/core/configuration.js')>(),tryLoadHostConfiguration:()=>host()}));
vi.mock('../src/supervisor/client.js',()=>({requestSupervisor:boundary.request}));
const {executeHostCommand}=await import('../src/manager/operations.js');

it('forwards only the fixed sandbox status operation and denies every supplied host path command or namespace',async()=>{
 boundary.request.mockClear();
 await expect(executeHostCommand({handlerId:'local.host.sandbox.status'},{local:true})).resolves.toEqual({ready:false,inventory:{complete:true}});
 expect(boundary.request.mock.calls).toEqual([[{operation:'sandbox.status'}]]);
 for(const input of [{arguments:['/private']},...['path','command','namespace','containerdAddress','stateRoot','socket','payload','workdayId'].map(field=>({options:{[field]:'/untrusted'}})),{configuration:host()}]){
  boundary.request.mockClear();
  await expect(executeHostCommand({handlerId:'local.host.sandbox.status',...input},{local:true})).rejects.toThrow();
  expect(boundary.request).not.toHaveBeenCalled();
 }
});
it('rejects every caller-selected inspection field at the strict supervisor protocol boundary',()=>{
 expect(supervisorOperationSchema.parse({operation:'sandbox.status'})).toEqual({operation:'sandbox.status'});
 for(const field of ['path','command','namespace','containerdAddress','stateRoot','socket','payload','workdayId','arguments','options','configuration'])
  expect(supervisorOperationSchema.safeParse({operation:'sandbox.status',[field]:'/untrusted'}).success,field).toBe(false);
});
