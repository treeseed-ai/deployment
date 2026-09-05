import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { LocalSecretCustody } from './local.js';
import { CustodyError } from './contracts.js';
import { setTimeout as pause } from 'node:timers/promises';
import { OpenBaoCustody } from './openbao.js';

/** One-shot initializer. Its key and recovery storage are outside OpenBao's raft data. */
export async function bootstrapManagedOpenBao(options: {
  address?: string; custodyRoot?: string; keyFile?: string; identityFile?: string;
} = {}) {
  const address=options.address??'https://openbao:8200',root=options.custodyRoot??'/openbao/custody';
  new OpenBaoCustody({address,mount:'treeseed',token:'validation-only',scopes:[{team:'host',project:'bootstrap',environment:'local',purpose:'openbao',name:'initialization'}]});
  const identityFile=options.identityFile??'/run/openbao-client/identity.json';
  const key=readFileSync(options.keyFile??'/run/openbao-bootstrap/custody.key');
  const store=new LocalSecretCustody(root);store.unlock(key);key.fill(0);
  const scope={team:'host',project:'control-plane',environment:'bootstrap',purpose:'openbao',name:'initialization'};
  let token='';
  async function request(path:string,body?:unknown) {
    const response=await fetch(`${address}/v1/${path}`,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{'content-type':'application/json',...(token?{'x-vault-token':token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response.ok)throw new CustodyError(`bootstrap_http_${response.status}`);
    return response.status===204?null:response.json() as Promise<any>;
  }
  try{
    let saved=store.read(scope);
    const deadline=Date.now()+30000;let initialized:any;
    while(!initialized){
      try{initialized=await request('sys/init');}catch{if(Date.now()>=deadline)throw new CustodyError('openbao_not_ready');await pause(250);}
    }
    if(!initialized.initialized){
      if(saved)throw new CustodyError('bootstrap_state_mismatch');
      const receipt=await request('sys/init',{recovery_shares:1,recovery_threshold:1});
      const values={rootToken:String(receipt.root_token),recovery:JSON.stringify(receipt.recovery_keys_base64),phase:'initializing'};
      store.write(scope,values,0);saved=store.read(scope);
    }
    if(!saved)throw new CustodyError('bootstrap_recovery_required');
    if(saved.values.phase!=='ready'){
      token=saved.values.rootToken!;
      if(!token)throw new CustodyError('bootstrap_recovery_required');
      const mounts=await request('sys/mounts');
      if(!mounts['treeseed/'])await request('sys/mounts/treeseed',{type:'kv',options:{version:'2'}});
      await request('treeseed/config',{cas_required:true,max_versions:5});
      const auth=await request('sys/auth');
      if(!auth['approle/'])await request('sys/auth/approle',{type:'approle'});
      const policy=`path "treeseed/data/teams/*" { capabilities = ["create", "read", "update"] }
path "treeseed/metadata/teams/*" { capabilities = ["read"] }
path "treeseed/delete/teams/*" { capabilities = ["update"] }
path "auth/token/revoke-self" { capabilities = ["update"] }`;
      await request('sys/policies/acl/treeseed-control-plane',{policy});
      await request('auth/approle/role/treeseed-control-plane',{token_policies:['treeseed-control-plane'],token_no_default_policy:true,token_ttl:300,token_max_ttl:300,secret_id_ttl:0});
      const role=await request('auth/approle/role/treeseed-control-plane/role-id');
      const secret=await request('auth/approle/role/treeseed-control-plane/secret-id',{});
      const values={...saved.values,phase:'ready',roleId:role.data.role_id,secretId:secret.data.secret_id};
      store.write(scope,values,saved.version);saved=store.read(scope)!;
    }
    if(saved.values.rootToken){
      token=saved.values.rootToken;
      // A crash after revocation is safe: 403 proves that this saved token has no authority.
      try{await request('auth/token/revoke-self',{});}catch(error){if(!(error instanceof CustodyError)||error.code!=='bootstrap_http_403')throw error;}
      const {rootToken:discarded,...values}=saved.values;
      store.write(scope,values,saved.version);saved=store.read(scope)!;
    }
    const temporary=`${identityFile}.new`;
    writeFileSync(temporary,JSON.stringify({roleId:saved.values.roleId,secretId:saved.values.secretId}),{mode:0o600});
    renameSync(temporary,identityFile);
    return {ok:true,custody:'openbao',initialized:true,rootTokenRetained:false};
  }finally{store.lock();}
}
