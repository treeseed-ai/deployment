import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { resolveDevelopmentRuntimeImage } from '../src/supervisor/development-container.js';

// Real owning supervisor/session/copy/filesystem execution in a separate Node process.
// The Docker command transport inside the fixture is simulated; this is not live-manager acceptance.
function run(shape:string) {
    const command=(_exe:string,args:readonly string[])=>execFileSync('/usr/bin/docker',[...args],{encoding:'utf8',timeout:180_000,stdio:['ignore','pipe','pipe']});
    const image=resolveDevelopmentRuntimeImage(command),owner=resolve(import.meta.dirname,'..'),workspace=resolve(owner,'../..');
    const output=command('/usr/bin/docker',['run','--rm','--network','none','--group-add',String(statSync(owner).gid),'--cap-drop','ALL','--cap-add','CHOWN','--security-opt','no-new-privileges:true',
      '--mount',`type=bind,source=${workspace},target=${workspace},readonly`,'--workdir',owner,
      '--env','TREESEED_HANDOFF_DISPOSABLE=1',image,'node','--import','tsx','tests/support/provider-handoff-native.ts',shape]);
    return JSON.parse(output) as unknown;
}
it.each(['ready','running','recovery','malformed','bad-claim','copy-failure','runner-stop-failure','runner-stop-uncertain','manager-stop-uncertain'])(
  'preserves selected provider bytes and execution after %s rejection in an isolated filesystem', shape=>{
    expect(run(shape)).toEqual({shape,rejected:true,selectedBytesUnchanged:true,executionUnchanged:true});
  },240_000);
it.each(['polling','empty','first-start'])(
  'selects the prepared provider snapshot after %s admission through the original boundary',shape=>{
    expect(run(shape)).toEqual({shape,started:true,runtimeCustodyVerified:true});
  },240_000);
