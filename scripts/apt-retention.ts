import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Archive { name: string; digest: string | null; size: number; url: string }
export interface Package { name: string; digest: string; size: number; package: string; version: string; depends: string }
// GitHub normalizes '~' in uploaded release-asset names to '.'. Content still
// must match exactly; filenames alone never establish archive custody.
const archived = (p: Package, a: Archive) => p.name.replaceAll('~', '.') === a.name.replaceAll('~', '.') && p.digest === a.digest && p.size === a.size;
export function retentionPlan(packages: Package[], current: Archive[], previous: Archive[], archives: Archive[], matches: (version: string, operator: string, required: string) => boolean) {
  if (!current.length || !previous.length) throw new Error('Both complete release package sets are required.');
  const roots = [...current, ...previous];
  for (const asset of roots) if (!packages.some(p => archived(p, asset)))
    throw new Error(`Release package missing or changed: ${asset.name}`);
  const keep = [...new Set(roots.map(a => packages.find(p => p.name === a.name && archived(p, a)) ?? packages.find(p => archived(p, a))!))];
  for (const p of keep) for (const group of p.depends.split(',').filter(Boolean)) {
    const alternatives = group.split('|').map(part => part.trim());
    if (!alternatives.some(part => /^treeseed(?:-|\s|$)/u.test(part))) continue;
    const satisfied = alternatives.some(part => {
      const parsed = /^([a-z0-9+.-]+)(?::(?:any|native|amd64|all))?(?:\s*\((=|>=|<=|>>|<<)\s*([^\s)]+)\))?$/u.exec(part);
      if (!parsed) throw new Error(`Unsupported dependency in ${p.name}: ${part}`);
      if (!parsed[1]!.startsWith('treeseed')) return false;
      return keep.some(candidate => candidate.package === parsed[1] && (!parsed[2] || matches(candidate.version, parsed[2], parsed[3]!)));
    });
    if (!satisfied) throw new Error(`Retained dependency closure is incomplete: ${p.name}: ${group}`);
  }
  const remove = packages.filter(p => !keep.includes(p)).map(p => {
    const archive = archives.find(a => archived(p, a));
    if (!archive) throw new Error(`No verified release archive for ${p.name}; nothing may be removed.`);
    return { ...p, archive: archive.url };
  });
  return { keep, remove, beforeBytes: packages.reduce((n, p) => n + p.size, 0), afterBytes: keep.reduce((n, p) => n + p.size, 0) };
}

function release(tag: string) {
  if (!/^0\.1\.0-rc\.[0-9]+$/u.test(tag)) throw new Error('Expected an exact development release tag.');
  return JSON.parse(execFileSync('gh', ['api', `repos/treeseed-ai/deployment/releases/tags/${tag}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
}
function assets(value: any): Archive[] {
  if (value.draft) throw new Error('Draft releases cannot establish archive custody.');
  return value.assets.filter((a: any) => a.name.endsWith('.deb')).map((a: any) => ({ name: a.name, digest: a.digest, size: a.size, url: a.browser_download_url }));
}

/** Only a checked-out development pool is mutable; stable and GitHub archives are never touched. */
export function retainDevelopmentPool(apt: string, currentTag: string, explicitRollback?: string, apply = true) {
  const pool = join(apt, 'pool', 'development'), receiptPath = join(apt, 'development-retention.json');
  for (const path of [apt, join(apt, 'pool'), pool]) if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('Unsafe APT pool.');
  let prior: { currentTag: string; rollbackTag: string } | undefined;
  try { prior = JSON.parse(readFileSync(receiptPath, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const rollbackTag = explicitRollback ?? (prior?.currentTag === currentTag ? prior.rollbackTag : prior?.currentTag);
  if (!rollbackTag || rollbackTag === currentTag) throw new Error('A distinct accepted rollback tag is required on first retention.');
  const current = assets(release(currentTag)), previous = assets(release(rollbackTag));
  const packages = readdirSync(pool).map(name => {
    if (!/^treeseed[a-z0-9._+~-]*\.deb$/u.test(name)) throw new Error(`Unmanaged file in development pool: ${name}`);
    const path = join(pool, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Unsafe package: ${name}`);
    const digest = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    const fields = execFileSync('dpkg-deb', ['--field', path], { encoding: 'utf8' });
    const field = (key: string) => new RegExp(`^${key}: (.*)$`, 'mu').exec(fields)?.[1] ?? '';
    return { name, digest, size: stat.size, package: field('Package'), version: field('Version'), depends: [field('Pre-Depends'), field('Depends')].filter(Boolean).join(',') };
  });
  const archives: Archive[] = [...current, ...previous];
  for (let page = 1; packages.some(p => !archives.some(a => archived(p, a))); page++) {
    const releases = JSON.parse(execFileSync('gh', ['api', `repos/treeseed-ai/deployment/releases?per_page=100&page=${page}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
    if (!releases.length) break;
    archives.push(...releases.filter((r: any) => !r.draft).flatMap(assets));
  }
  const plan = retentionPlan(packages, current, previous, archives, (v, op, required) => {
    try { execFileSync('dpkg', ['--compare-versions', v, op, required]); return true; } catch { return false; }
  });
  writeFileSync('apt-retention-plan.json', JSON.stringify({ currentTag, rollbackTag, ...plan }, null, 2));
  if (!apply) return plan;
  // All archives and both dependency closures are checked before the first unlink.
  for (const p of plan.remove) unlinkSync(join(pool, p.name));
  writeFileSync(receiptPath, `${JSON.stringify({ schemaVersion: 1, currentTag, rollbackTag, packages: plan.keep }, null, 2)}\n`);
  return plan;
}
