import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OsSecretCustody } from './os.js';

const scope={team:'host',project:'control-plane',environment:'bootstrap',purpose:'openbao',name:'identity'};
function write(path:string,value:string|Buffer){const temporary=`${path}.new`;writeFileSync(temporary,value,{mode:0o600});renameSync(temporary,path);}

/** Called only by the privileged manager, never by downloaded application code. */
export function prepareManagedOpenBao(stateRoot:string,runtimeRoot='/run/treeseed/openbao') {
  const os=new OsSecretCustody(join(stateRoot,'openbao-os'),false);
  mkdirSync(runtimeRoot,{recursive:true,mode:0o700});
  for(const name of ['server','bootstrap','client'])mkdirSync(join(runtimeRoot,name),{recursive:true,mode:0o700});
  for(const name of ['openbao','openbao-custody'])mkdirSync(join(stateRoot,name),{recursive:true,mode:0o700});
  let identity=os.initialized?os.run(c=>c.read(scope))?.values:undefined;
  if(!identity){
    if(readdirSync(join(stateRoot,'openbao')).length||readdirSync(join(stateRoot,'openbao-custody')).length)
      throw new Error('Existing OpenBao state requires its original OS custody; recovery is required.');
    const temporary=mkdtempSync(join(runtimeRoot,'tls-'));
    try {
      execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:3072','-nodes','-days','3650',
        '-subj','/CN=treeseed-openbao','-addext','subjectAltName=DNS:openbao,IP:127.0.0.1',
        '-keyout',join(temporary,'tls.key'),'-out',join(temporary,'ca.pem')],{stdio:['ignore','pipe','pipe']});
      identity={sealKey:randomBytes(32).toString('base64'),custodyKey:randomBytes(32).toString('base64'),
        tlsKey:readFileSync(join(temporary,'tls.key'),'utf8'),certificate:readFileSync(join(temporary,'ca.pem'),'utf8')};
      os.run(c=>c.write(scope,identity!,0),true);
    }finally{rmSync(temporary,{recursive:true,force:true});}
  }
  write(join(runtimeRoot,'server/seal.key'),Buffer.from(identity.sealKey!,'base64'));
  write(join(runtimeRoot,'bootstrap/custody.key'),Buffer.from(identity.custodyKey!,'base64'));
  write(join(runtimeRoot,'server/tls.key'),identity.tlsKey!);
  write(join(runtimeRoot,'server/ca.pem'),identity.certificate!);
  write(join(runtimeRoot,'client/ca.pem'),identity.certificate!);
  write(join(runtimeRoot,'server/openbao.hcl'),managedOpenBaoConfiguration());
  return {configured:true,custody:'os',server:'openbao'};
}

/** Identical service configuration locally and on a cloud host with injected bootstrap files. */
export function managedOpenBaoConfiguration() {
  return `ui = false
disable_mlock = true
api_addr = "https://openbao:8200"
cluster_addr = "https://openbao:8201"
storage "raft" {
  path = "/openbao/data"
  node_id = "control-plane"
}
listener "tcp" {
  address = "0.0.0.0:8200"
  tls_cert_file = "/run/openbao/ca.pem"
  tls_key_file = "/run/openbao/tls.key"
}
seal "static" {
  current_key_id = "treeseed-os-v1"
  current_key = "file:///run/openbao/seal.key"
}
`;
}
