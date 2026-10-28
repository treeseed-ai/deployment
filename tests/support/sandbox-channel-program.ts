import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
class SandboxChannelProgram {
  async run():Promise<void> {
    const load=createRequire(import.meta.url);
    const module:object=load('@treeseed-cordis/deployment/sandbox-control');
    assert.equal(typeof Reflect.get(module,'SandboxControlApplication'),'function');
    assert.equal(typeof Reflect.get(module,'SandboxSocketClient'),'function');
    process.stdout.write('sandbox-channel-interface-ok\n');
  }
}
if(import.meta.main)await new SandboxChannelProgram().run();
