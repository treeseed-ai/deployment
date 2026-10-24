import { CapabilityToken, ProviderSchemas, PlatformSchemas, type ProviderDeclaration, type ProviderArtifact } from '@treeseed-cordis/sdk';
import { Context, type ProviderRegistration } from '@treeseed-cordis/sdk/runtime';
import { ComposeDeploymentHost, DockerCommands, HostSystem, LoopbackProbe, type DeploymentHost, type DiagnosticCommands, type DiagnosticSystem, type DiagnosticPorts } from './diagnose.js';
class DeploymentValidation {
  parse(value:unknown):DeploymentHost {if(!value||typeof (value as DeploymentHost).diagnose!=='function'||typeof (value as DeploymentHost).plan!=='function')throw new Error('Invalid Deployment adapter');return value as DeploymentHost;}
}
class CommandsValidation {parse(value:unknown):DiagnosticCommands {if(!value||typeof (value as DiagnosticCommands).execute!=='function')throw new Error('Invalid commands adapter');return value as DiagnosticCommands;}}
class SystemValidation {parse(value:unknown):DiagnosticSystem {if(!value||typeof (value as DiagnosticSystem).host!=='function'||typeof (value as DiagnosticSystem).storage!=='function')throw new Error('Invalid system adapter');return value as DiagnosticSystem;}}
class PortsValidation {parse(value:unknown):DiagnosticPorts {if(!value||typeof (value as DiagnosticPorts).available!=='function')throw new Error('Invalid port adapter');return value as DiagnosticPorts;}}
export const DeploymentCapability=new CapabilityToken<DeploymentHost>('deployment','0.3.0-cordis.1',new DeploymentValidation());
const commandsToken=new CapabilityToken<DiagnosticCommands>('deployment.commands','0.3.0-cordis.1',new CommandsValidation());
const systemToken=new CapabilityToken<DiagnosticSystem>('deployment.system','0.3.0-cordis.1',new SystemValidation());
const portsToken=new CapabilityToken<DiagnosticPorts>('deployment.ports','0.3.0-cordis.1',new PortsValidation());
class Declarations {
  static define(id:string,capability:string,inject:string[]=[]):ProviderDeclaration {return ProviderSchemas.declaration.parse({id,pluginId:'deployment',capability,contractVersion:'0.3.0-cordis.1',target:'cli',provide:[capability],inject});}
}
class CommandsPlugin {
  static readonly declaration=Declarations.define('docker-cli','deployment.commands');
  static readonly provide=this.declaration.provide;static readonly inject=this.declaration.inject;static readonly Config=PlatformSchemas.empty;
  constructor(context:Context){context.provide(commandsToken.id,new DockerCommands());}
}
class SystemPlugin {
  static readonly declaration=Declarations.define('local-host','deployment.system');
  static readonly provide=this.declaration.provide;static readonly inject=this.declaration.inject;static readonly Config=PlatformSchemas.empty;
  constructor(context:Context){context.provide(systemToken.id,new HostSystem());}
}
class PortsPlugin {
  static readonly declaration=Declarations.define('loopback','deployment.ports');
  static readonly provide=this.declaration.provide;static readonly inject=this.declaration.inject;static readonly Config=PlatformSchemas.empty;
  constructor(context:Context){context.provide(portsToken.id,new LoopbackProbe());}
}
export class DeploymentPlugin {
  static readonly declaration=Declarations.define('compose','deployment',[commandsToken.id,systemToken.id,portsToken.id]);
  static readonly provide=this.declaration.provide;static readonly inject=this.declaration.inject;static readonly Config=PlatformSchemas.empty;
  constructor(context:Context){const commands=commandsToken.parse(Reflect.get(context,commandsToken.id)),system=systemToken.parse(Reflect.get(context,systemToken.id)),ports=portsToken.parse(Reflect.get(context,portsToken.id));context.provide(DeploymentCapability.id,new ComposeDeploymentHost(commands,system,ports));}
}
export class DeploymentComposition {
  static registrations(artifact:ProviderArtifact):ProviderRegistration[] {
    return [
      {token:commandsToken,plugin:CommandsPlugin,declaration:CommandsPlugin.declaration,configuration:{},artifact},
      {token:systemToken,plugin:SystemPlugin,declaration:SystemPlugin.declaration,configuration:{},artifact},
      {token:portsToken,plugin:PortsPlugin,declaration:PortsPlugin.declaration,configuration:{},artifact},
      {token:DeploymentCapability,plugin:DeploymentPlugin,declaration:DeploymentPlugin.declaration,configuration:{},artifact}
    ];
  }
  static selections(scopeId:string):Array<{scopeId:string;capability:string;providerId:string}> {return [{scopeId,capability:commandsToken.id,providerId:CommandsPlugin.declaration.id},{scopeId,capability:systemToken.id,providerId:SystemPlugin.declaration.id},{scopeId,capability:portsToken.id,providerId:PortsPlugin.declaration.id},{scopeId,capability:DeploymentCapability.id,providerId:DeploymentPlugin.declaration.id}];}
}
