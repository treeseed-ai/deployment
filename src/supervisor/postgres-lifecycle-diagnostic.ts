import { spawnSync } from 'node:child_process';
import { inspectLifecycle } from '../postgres/lifecycle-diagnostic.js';
import { installedComponentRelease } from './component-release.js';

export function inspectInstalledLifecycle(componentId:string, release:string) {
  return inspectLifecycle(installedComponentRelease(componentId,release), async args => {
    const result=spawnSync('/usr/bin/docker',args,{encoding:'utf8',timeout:15000,maxBuffer:262144,
      env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin'}});
    if(result.error || result.status!==0) throw new Error('Bounded lifecycle diagnostic unavailable');
    return args[0]==='logs' ? result.stdout+'\n'+result.stderr : result.stdout;
  });
}
