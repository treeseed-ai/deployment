import {expect, it, vi} from 'vitest';
import {validateManagedServiceCredentials} from '../src/security/services/validate.js';
const accountId='a'.repeat(32), zoneId='b'.repeat(32);
const zone={id:zoneId,name:'example.com',account:{id:accountId}};
const connection={providerId:'cloudflare',nonSecretConfig:{accountId,domain:'Example.COM'}};
it('resolves the exact account/domain with bounded read-only DNS authority',async()=>{
  const fetchImpl=vi.fn(async()=>Response.json({success:true,result:[zone],result_info:{total_count:1}}));
  expect(await validateManagedServiceCredentials(connection,'cloudflare-dns',{apiToken:'test-token'},fetchImpl)).toEqual({domain:'example.com',zoneId});
  const [url,init]=fetchImpl.mock.calls[0] as unknown as [string,RequestInit];
  const parsed=new URL(url);expect(parsed.origin).toBe('https://api.cloudflare.com');
  expect(parsed.searchParams.get('name')).toBe('example.com');expect(parsed.searchParams.get('account.id')).toBe(accountId);
  expect(init.redirect).toBe('error');expect(init.signal).toBeDefined();
});
it.each([[],[zone,zone],[{...zone,name:'other.com'}],[{...zone,account:{id:'c'.repeat(32)}}],[{...zone,id:'invalid'}]].map(result=>({result})))('rejects missing, ambiguous or mismatched zones',async ({result})=>{
  await expect(validateManagedServiceCredentials(connection,'cloudflare-dns',{apiToken:'test-token'},async()=>Response.json({success:true,result}))).rejects.toThrow('validation failed');
});
it.each(['https://example.com','example.com/path','*.example.com','localhost','example.com?x=1','example.com@evil.com'])('rejects unsafe domain %s before fetching',async domain=>{
  const fetchImpl=vi.fn();await expect(validateManagedServiceCredentials({...connection,nonSecretConfig:{accountId,domain}},'cloudflare-dns',{apiToken:'test-token'},fetchImpl)).rejects.toThrow();expect(fetchImpl).not.toHaveBeenCalled();
});
it('redacts failures and bounds response size',async()=>{
  for(const response of [new Response('test-token',{status:403}),new Response('',{status:302}),new Response('x'.repeat(70_000)),Response.json({success:true,result:[zone],result_info:{total_count:2}})])
    await expect(validateManagedServiceCredentials(connection,'cloudflare-dns',{apiToken:'test-token'},async()=>response)).rejects.toThrow('Managed service credential validation failed.');
});
