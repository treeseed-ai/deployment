import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { hostDevelopmentActivationSchema, hostDevelopmentFileSchema, hostDevelopmentStatus } from './host-development.js';

/** Read selected generation bytes through the existing privileged status boundary.
 * This is file custody, not a claim about source builds or already-loaded modules. */
export function hostDevelopmentRuntimeStatus(hostRoot = '/var/lib/treeseed/manager/host-development') {
  const state = hostDevelopmentStatus(hostRoot);
  if (state.status !== 'active') return {...state, files:null};
  if (!/^dev-[0-9]{10,16}-[a-f0-9]{8}$/u.test(state.generationId)) throw new Error('Selected host generation identity is invalid.');
  const root = resolve(realpathSync(hostRoot),'generations',state.generationId);
  if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root || !lstatSync(root).isDirectory())
    throw new Error('Selected host generation must be its exact immutable directory.');
  const files: {path:string;size:number;sha256:string}[] = [];
  const scan = (directory:string) => {
    for(const name of readdirSync(directory)) {
      const path=resolve(directory,name), local=relative(root,path), metadata=lstatSync(path);
      if(metadata.isSymbolicLink()) throw new Error('Selected host runtime contains a symbolic link.');
      if(directory===root && !['package.json','dist','node_modules'].includes(name))
        throw new Error('Selected host runtime contains an unsupported root.');
      if(metadata.isDirectory()) { scan(path); continue; }
      if(!metadata.isFile() || (metadata.mode & 0o444)===0) throw new Error('Selected host runtime contains an unsupported or unreadable node.');
      const entry=hostDevelopmentFileSchema.parse({path:local,size:metadata.size,sha256:`sha256:${'0'.repeat(64)}`});
      if(files.length>=4096)throw new Error('Selected host runtime exceeds its bounded file inventory.');
      const bytes=readFileSync(path);
      if(bytes.byteLength!==entry.size)throw new Error('Selected host runtime changed while reading.');
      files.push({...entry,sha256:`sha256:${createHash('sha256').update(bytes).digest('hex')}`});
    }
  };
  scan(root);
  files.sort((left,right)=>left.path.localeCompare(right.path));
  hostDevelopmentActivationSchema.parse({generationId:state.generationId,worktree:state.worktree,
    packageSha256:files.find(file=>file.path==='package.json')?.sha256,files});
  const digest=`sha256:${createHash('sha256').update(JSON.stringify(files)).digest('hex')}`;
  if(digest!==state.manifestDigest || JSON.stringify(hostDevelopmentStatus(hostRoot))!==JSON.stringify(state))
    throw new Error('Selected host runtime does not match its exact activation manifest.');
  return {...state,files};
}
