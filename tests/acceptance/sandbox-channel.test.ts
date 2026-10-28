import {test, expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
class SandboxChannelAcceptance {
  interface():void {
    const result=spawnSync('node',['dist/tests/support/sandbox-channel-program.js','--interface'],{encoding:'utf8',timeout:10000});
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('sandbox-channel-interface-ok\n');
  }
}
const suite=new SandboxChannelAcceptance();
test('acceptance: built public private sandbox channel rejects invalid construction before host effects',suite.interface.bind(suite));
