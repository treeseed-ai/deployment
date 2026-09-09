import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { createAccessTokenVerifier, discoverSigningKeys } from '@treeseed/identity';

export const cliScopes = ['treeseed:read','treeseed:knowledge:write','treeseed:governance:write','treeseed:projects:write','treeseed:execution'];
export const cliScopeDefinitions = cliScopes.map(name => ({name,protocol:'openid-connect',attributes:{'include.in.token.scope':'true','display.on.consent.screen':'true'}}));

/** Published CLI + real Keycloak + real OS custody; the small API is a typed
 * protocol fixture, not a replacement for subsequent live API acceptance. */
export async function cliFixture(root:string) {
  let resource='',issuer='',subject='';
  let verify:ReturnType<typeof createAccessTokenVerifier> | undefined;
  const seenTokens = new Set<string>();
  const server = createServer({key:readFileSync(join(root,'tls/key.pem')),cert:readFileSync(join(root,'tls/cert.pem'))},async(request,response)=>{
    response.setHeader('content-type','application/json');response.setHeader('cache-control','no-store');
    try {
      if (request.url === '/.well-known/oauth-protected-resource') {
        response.end(JSON.stringify({resource,authorization_servers:[issuer],scopes_supported:cliScopes}));return;
      }
      if (request.url !== '/v1/me' || !verify) {response.writeHead(404);response.end('{}');return;}
      const token=request.headers.authorization?.replace(/^Bearer /,'') ?? '';
      seenTokens.add(token);
      const principal=await verify(token);assert.equal(principal.identity.subject,subject);
      response.end(JSON.stringify({data:{principal:{id:'preserved-local-user',displayName:'Acceptance user',scopes:principal.scopes},teams:[]}}));
    } catch {response.writeHead(401);response.end('{}');}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address && typeof address !== 'string');
  resource=`https://127.0.0.1:${address.port}`;
  return {
    resource,
    async verify(selectedIssuer:string,context:BrowserContext,expectedSubject:string) {
      issuer=selectedIssuer;subject=expectedSubject;
      verify=createAccessTokenVerifier({issuer,audience:resource,profile:'keycloak',verificationKey:await discoverSigningKeys({issuer,transport:fetch}),
        resolvePrincipal:async identity=>identity.subject===subject ? {principalId:'preserved-local-user',kind:'human'} : null});
      const modulePath='@treeseed/cli/dist/cli/runtime.js';
      const {runCommandLine}=await import(modulePath) as {runCommandLine(args:string[],context:{env:NodeJS.ProcessEnv;interactiveUi:boolean;write:(value:string,stream?:string)=>void;openExternal?:(url:string)=>Promise<boolean>}):Promise<number>};
      const output:string[]=[];
      const env={TREESEED_CONFIG_HOME:join(root,'cli-custody'),TREESEED_API_BASE_URL:resource};
      const page=await context.newPage();page.setDefaultTimeout(20000);
      try {
        const exit=await runCommandLine(['auth','login','--timeout','20','--json'],{env,interactiveUi:false,write:value=>output.push(value),openExternal:async url=>{await page.goto(url);return true;}});
        assert.equal(exit,0,'Published CLI sign-in failed');
        assert.equal(await runCommandLine(['auth','status','--json'],{env,interactiveUi:false,write:value=>output.push(value)}),0);
        const directory=join(env.TREESEED_CONFIG_HOME,'custody');
        const records=readdirSync(directory).filter(name=>name.endsWith('.enc'));assert.equal(records.length,1);
        const ciphertext=readFileSync(join(directory,records[0]!),'utf8');
        for (const token of seenTokens) {assert.ok(token);assert.equal(ciphertext.includes(token),false);assert.equal(output.join('').includes(token),false);}
        assert.ok(readdirSync(directory).includes('custody.cred'));
        assert.equal(await runCommandLine(['auth','logout','--json'],{env,interactiveUi:false,write:value=>output.push(value)}),0);
        assert.ok(output.some(value=>{try{return JSON.parse(value).result?.upstreamRevoked===true;}catch{return false;}}));
        assert.notEqual(await runCommandLine(['auth','status','--json'],{env,interactiveUi:false,write:value=>output.push(value)}),0);
        return ['published-cli-pkce-sso','cli-api-principal-mapping','cli-real-os-custody','cli-upstream-and-local-logout'];
      } finally {await page.close();seenTokens.clear();}
    },
    async close(){await new Promise<void>(resolve=>server.close(()=>resolve()));},
  };
}
