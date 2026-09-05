export const MANAGED_OPENBAO_IMAGE = {
  repository:'openbao/openbao',
  digest:'sha256:11fd73a2102cda9c55d5d881a8c3210303146a7ec1e8ac76f526e175c6d24641',
  version:'2.6.2',
} as const;
export function managedOpenBaoServices(apiImage:string) {
  if(!/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/u.test(apiImage))throw new Error('Immutable API image required.');
  const state='${TREESEED_COMPONENT_DATA_ROOT:-/var/lib/treeseed/components}/api';
  const bind=(source:string,target:string,readOnly=false)=>({type:'bind',source,target,read_only:readOnly});
  return {
    openbao:{image:`${MANAGED_OPENBAO_IMAGE.repository}@${MANAGED_OPENBAO_IMAGE.digest}`,user:'0:0',
      entrypoint:['bao'],command:['server','-config=/run/openbao/openbao.hcl'],restart:'unless-stopped',
      read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],networks:['private'],
      volumes:[bind(`${state}/openbao`,'/openbao/data'),bind('/run/treeseed/openbao/server','/run/openbao',true)],
      environment:{BAO_ADDR:'https://127.0.0.1:8200',BAO_CACERT:'/run/openbao/ca.pem'},
      healthcheck:{test:['CMD-SHELL','bao status >/dev/null 2>&1'],interval:'5s',timeout:'5s',retries:30}},
    'openbao-initialize':{image:apiImage,restart:'no',depends_on:{openbao:{condition:'service_started'}},
      command:['node','--input-type=module','-e',"import {bootstrapManagedOpenBao} from '@treeseed/deployment/security/custody'; await bootstrapManagedOpenBao();"],
      environment:{NODE_EXTRA_CA_CERTS:'/run/openbao-client/ca.pem'},networks:['private'],
      security_opt:['no-new-privileges:true'],volumes:[bind(`${state}/openbao-custody`,'/openbao/custody'),
        bind('/run/treeseed/openbao/bootstrap','/run/openbao-bootstrap',true),bind('/run/treeseed/openbao/client','/run/openbao-client')]},
  };
}
export const managedOpenBaoClient = {
  environment:{TREESEED_OPENBAO_ADDRESS:'https://openbao:8200',TREESEED_OPENBAO_IDENTITY_FILE:'/run/openbao-client/identity.json',NODE_EXTRA_CA_CERTS:'/run/openbao-client/ca.pem'},
  volume:{type:'bind',source:'/run/treeseed/openbao/client',target:'/run/openbao-client',read_only:true},
};
