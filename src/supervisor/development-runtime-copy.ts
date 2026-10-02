import { createHash } from 'node:crypto';
import { chmodSync, constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

/** Copy code only. No source-owned command executes in the supervisor. */
export interface DevelopmentRuntimeRoot {
	source: string;
	target: string;
}
const defaultRoots=['package.json','dist','node_modules','drizzle'];
const receiptSchema=z.object({files:z.number().int().positive().max(100_000),bytes:z.number().int().nonnegative().max(2*1024**3),
  digest:z.string().regex(/^sha256:[a-f0-9]{64}$/u)}).strict();

/** One digest authority for creation and subsequent selected-byte readback. */
function inspectRuntime(root:string,roots:readonly string[],ownerUid:number) {
  const rootStat=lstatSync(root);
  if(realpathSync(root)!==root||!rootStat.isDirectory()||rootStat.uid!==ownerUid||(rootStat.mode&0o022)!==0)throw new Error('Runtime directory custody is invalid.');
  if(new Set(roots).size!==roots.length||roots.some(name=>!name||name.includes('/')||name==='.'||name==='..')
    ||JSON.stringify(readdirSync(root).sort())!==JSON.stringify([...roots].sort()))throw new Error('Runtime roots do not match the fixed copy.');
  const digest=createHash('sha256'),directories=new Set<string>(),uniqueFiles=new Set<string>();
  let files=0,bytes=0,entries=0;
  const scan=(path:string,depth:number)=>{
    if(++entries>200_000||depth>128)throw new Error('Runtime exceeds custody limits.');
    const stat=lstatSync(path),name=relative(root,path);
    if(stat.uid!==ownerUid||(!stat.isSymbolicLink()&&(stat.mode&0o022)!==0))throw new Error('Runtime node ownership is invalid.');
    if(stat.isSymbolicLink()) {
      const actual=realpathSync(path),link=readlinkSync(path);
      if(!directories.has(actual)||link!==relative(dirname(path),actual))throw new Error('Runtime alias custody is invalid.');
      digest.update(JSON.stringify(['alias',name,link]));return;
    }
    const fd=openSync(path,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
    try {
      const opened=fstatSync(fd);
      if(realpathSync(`/proc/self/fd/${fd}`)!==path||opened.ino!==stat.ino||opened.dev!==stat.dev)throw new Error('Runtime node changed while opening.');
      if(opened.isDirectory()) {
        directories.add(path);
        for(const child of readdirSync(`/proc/self/fd/${fd}`).sort())scan(resolve(path,child),depth+1);
      } else {
        if(!opened.isFile()||(opened.mode&0o444)===0||opened.size>384*1024*1024||++files>100_000)throw new Error('Runtime file custody is invalid.');
        const data=readFileSync(fd),after=fstatSync(fd);
        if(data.length!==opened.size||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs)throw new Error('Runtime bytes changed while reading.');
        digest.update(JSON.stringify([name,data.length,opened.mode&0o111])).update(data);
        const key=`${opened.mode&0o111}:${createHash('sha256').update(data).digest('hex')}`;
        if(!uniqueFiles.has(key)){uniqueFiles.add(key);bytes+=data.length;}
        if(bytes>2*1024**3)throw new Error('Runtime exceeds custody limits.');
      }
    } finally {closeSync(fd);}
  };
  for(const name of roots)scan(resolve(root,name),0);
  return receiptSchema.parse({files,bytes,digest:`sha256:${digest.digest('hex')}`});
}

/** Read only the existing manager-owned copy/receipt; never execute source commands. */
export function developmentRuntimeStatus(directory:string,roots:readonly string[]=defaultRoots,ownerUid=0) {
  try {
    const receipt=resolve(directory,'runtime-receipt.json'),metadata=lstatSync(receipt);
    if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.uid!==ownerUid||metadata.nlink!==1||(metadata.mode&0o077)!==0||metadata.size>1024)
      throw new Error('Receipt custody is invalid.');
    const before=readFileSync(receipt),expected=receiptSchema.parse(JSON.parse(before.toString('utf8')));
    const actual=inspectRuntime(resolve(directory,'runtime'),roots,ownerUid);
    if(JSON.stringify(expected)!==JSON.stringify(actual)||!readFileSync(receipt).equals(before))throw new Error('Runtime receipt does not match selected bytes.');
    return actual;
  } catch {throw new Error('Selected development runtime custody is unavailable or changed.');}
}

/** Docker's actual mount inventory, not a saved Compose recipe, binds selected bytes. */
export function assertDevelopmentRuntimeMounts(state:{labels:Record<string,string>;mounts:unknown},sessionId:string,target:string,directory:string,roots:readonly string[]) {
  if(state.labels['org.treeseed.development.session']!==sessionId||state.labels['org.treeseed.development.target']!==target||!Array.isArray(state.mounts))
    throw new Error('Development runtime ownership does not match the session.');
  const expected=roots.map(name=>({source:resolve(directory,'runtime',name),target:name==='.'?'/app':`/app/${name}`}));
  for(const {source,target:destination} of expected) {
    const mounts=state.mounts.filter(mount=>mount?.Destination===destination);
    if(mounts.length!==1||mounts[0].Source!==source||mounts[0].RW!==false||mounts[0].Type!=='bind')
      throw new Error('Development runtime code mounts do not match the private copy.');
  }
  if(state.mounts.some(mount=>typeof mount?.Destination!=='string'||expected.some(item=>mount.Destination.startsWith(`${item.target}/`)
    ||(mount.Destination!==item.target&&item.target.startsWith(`${mount.Destination.replace(/\/$/u,'')}/`)))))
    throw new Error('Development runtime code mounts contain an overlay.');
}

export function copyDevelopmentRuntime(input: { worktree: string; workspace: string; destination: string; sourceUid: number; roots?: DevelopmentRuntimeRoot[] }) {
  const workspace = realpathSync(input.workspace);
  const destination = resolve(input.destination);
  let files = 0, bytes = 0, entries = 0;
  const copied = new Map<string,string>();
  const within = (path: string) => path === workspace || path.startsWith(workspace + sep);
  if (within(destination)) throw new Error('Candidate custody must be outside the source workspace.');
  // The containing manager directory remains 0700; code is readable inside
  // the bind mount by either a root or nonroot installed runtime identity.
  mkdirSync(destination, { mode: 0o755 });
  chmodSync(destination, 0o755);
  const copy = (source: string, target: string, ancestors: Set<string>) => {
    if (++entries > 200_000 || ancestors.size > 128) throw new Error('Candidate runtime exceeds custody limits.');
    // Inspect the opened object, not a path checked before a possible symlink swap.
    const fd = openSync(source, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const actual = realpathSync(`/proc/self/fd/${fd}`), stat = fstatSync(fd);
      if (!within(actual) || stat.uid !== input.sourceUid)
        throw new Error('Candidate dependency escaped operator-owned workspace custody.');
      if (stat.isDirectory()) {
        if (ancestors.has(actual)) throw new Error('Candidate dependency contains a directory cycle.');
        const prior=copied.get(actual);
        if(prior) {
          const link=relative(dirname(target),prior);
          symlinkSync(link,target);return;
        }
        copied.set(actual,target);
        const next = new Set(ancestors).add(actual);
        mkdirSync(target, { mode: 0o755 });
        chmodSync(target, 0o755);
        for (const name of readdirSync(`/proc/self/fd/${fd}`).sort()) {
          // Linked workspace packages are not installed tarballs. Never carry
          // VCS history, local custody, env files or tool caches into a runtime.
          // npm's .bin is the only supported hidden runtime directory.
          if (name.startsWith('.') && name !== '.bin') continue;
          copy(`/proc/self/fd/${fd}/${name}`, resolve(target, name), next);
        }
      } else {
        // npm uses hardlinks for binaries. Copy their bytes into new private
        // files; never retain hardlinks to the operator's mutable cache.
        if (!stat.isFile() || stat.size > 384 * 1024 * 1024)
          throw new Error('Candidate dependency is not a bounded regular file.');
        if (++files > 100_000) throw new Error('Candidate runtime exceeds custody limits.');
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0, count = 0;
        while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
        if (length !== stat.size) throw new Error('Candidate dependency changed during materialization.');
        const data = buffer.subarray(0, length);
        const key=`file:${stat.mode & 0o111}:${createHash('sha256').update(data).digest('hex')}`;
        const prior=copied.get(key);
        // Private hardlinks preserve module-relative import paths. File
        // symlinks would incorrectly resolve imports from the first copy.
        if(prior) {linkSync(prior,target);return;}
        bytes+=data.length;
        if(bytes>2*1024**3)throw new Error('Candidate runtime exceeds custody limits.');
        writeFileSync(target, data, { flag: 'wx', mode: stat.mode & 0o111 ? 0o755 : 0o644 });
        chmodSync(target, stat.mode & 0o111 ? 0o755 : 0o644);
        copied.set(key,target);
      }
    } finally { closeSync(fd); }
  };
  try {
    const roots = input.roots ?? defaultRoots.map((name) => ({ source: name, target: name }));
    for (const root of roots) {
      if (!root.source || !root.target || root.target.startsWith('/') || root.target.split(/[\\/]/u).includes('..'))
        throw new Error('Candidate runtime root is invalid.');
      copy(resolve(input.worktree, root.source), resolve(destination, root.target), new Set());
    }
    return inspectRuntime(destination,roots.map(root=>root.target),process.getuid!());
  } catch (error) {
    // Only our freshly-created private candidate is removed; never source data.
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
