import { beforeEach,expect,it,vi } from 'vitest';
import { withApplicationBackupKey } from '../src/supervisor/backup.js';
const f=vi.hoisted(()=>({decrypt:vi.fn()}));
vi.mock('node:child_process',async original=>({...await original<object>(),execFileSync:f.decrypt}));
beforeEach(()=>vi.clearAllMocks());
it.each([false,true])('clears the existing recovery KEK after bounded transfer use (failure=%s)',async failure=>{
  const encoded=Buffer.from(Buffer.alloc(32,7).toString('base64url'));f.decrypt.mockReturnValue(encoded);let received:Buffer|undefined;
  const operation=withApplicationBackupKey(async key=>{received=key;expect(key.equals(Buffer.alloc(32,7))).toBe(true);if(failure)throw new Error('fixture');return {used:true};});
  if(failure)await expect(operation).rejects.toThrow('fixture');else expect(await operation).toEqual({used:true});
  expect(encoded.every(value=>value===0)).toBe(true);expect(received?.every(value=>value===0)).toBe(true);
  expect(f.decrypt.mock.calls[0]?.[0]).toBe('/usr/bin/systemd-creds');
  expect(f.decrypt.mock.calls[0]?.[1][0]).toBe('decrypt');
});
it('rejects malformed custody material before any transfer callback',async()=>{
  const callback=vi.fn(),encoded=Buffer.from('invalid');f.decrypt.mockReturnValue(encoded);
  await expect(withApplicationBackupKey(callback)).rejects.toThrow('credential');expect(callback).not.toHaveBeenCalled();
  expect(encoded.every(value=>value===0)).toBe(true);
});
