import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { developmentRuntimeStatus, assertDevelopmentRuntimeMounts } from '../../src/supervisor/development-runtime-copy.js';
import { runtimeRoots } from '../../src/supervisor/development-agent-container.js';
import { developmentCandidateSchema } from '@treeseed/sdk/development';

function row(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'SOURCE_ACCEPTANCE_ROW: Original readable object required');
  return Object.fromEntries(Object.entries(value));
}

test('Actual selected provider copy binds freshly compiled held source exact native read-only entrypoints and immutable completed managed results instead of saved source labels or registry hints', { timeout: 120_000 }, () => {
  const deadline = Date.now() + 120_000, workspace = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT;
  const workdayId = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID, team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
  assert.ok(workspace && isAbsolute(workspace) && workdayId && /^workday-[a-f0-9-]+$/u.test(workdayId));
  const cli = resolve(workspace, 'packages/cli/dist/cli/main.js'), cliBytes = readFileSync(cli);
  const remaining = () => { const value = deadline - Date.now(); assert.ok(value > 0, 'SOURCE_BUILD_ORIGINAL_BOUND: Native observation exceeded the original acceptance watchdog'); return value; };
  const read = (args: string[]) => {
    const native = spawnSync(process.execPath, [cli, ...args, '--server', 'local', '--team', team, '--json'],
      { cwd: workspace, env: process.env, encoding: 'utf8', timeout: remaining(), maxBuffer: 33_554_432 });
    assert.ok(!native.error && native.signal === null && native.status === 0, 'SOURCE_BUILD_PUBLIC_READ: Supported owning public command failed; private diagnostics withheld');
    const envelope = row(JSON.parse(native.stdout)); assert.equal(envelope.ok, true); return row(envelope.result);
  };
  const status = read(['dev', 'status']), session = row(status.session);
  assert.ok(typeof session.sessionId === 'string' && /^dev-[a-z0-9-]{1,64}$/u.test(session.sessionId));
  const sessionId = session.sessionId;
  assert.equal(session.status, 'active'); assert.ok(Array.isArray(session.repositories) && Array.isArray(session.targets) && Array.isArray(status.candidates));
  const sources = session.repositories.map(row).filter(value => value.projectId === 'agent'); assert.equal(sources.length, 1);
  const selected = session.targets.map(row).filter(value => value.projectId === 'agent' && value.targetId === 'provider'); assert.equal(selected.length, 1);
  const source = sources[0]!, target = selected[0]!; assert.ok(target.mode !== 'released' && typeof target.generation === 'number' && Number.isInteger(target.generation));
  assert.ok(typeof source.worktree === 'string' && isAbsolute(source.worktree)); const worktree = realpathSync(source.worktree);
  const head = execFileSync('/usr/bin/git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: remaining() }).trim();
  const cleanSource = () => execFileSync('/usr/bin/git', ['-C', worktree, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', timeout: remaining() });
  assert.equal(cleanSource(), '', 'SOURCE_BUILD_SOURCE: A saved clean candidate cannot authorize currently changed source');
  const candidates = status.candidates.map(value => developmentCandidateSchema.parse(value)).filter(value => value.sessionId === session.sessionId
    && value.verification.status === 'passed' && value.dependencyGenerations['agent.provider'] === target.generation
    && value.source.some(owner => owner.projectId === 'agent' && owner.commit === head && !owner.dirty));
  assert.equal(candidates.length, 1, 'SOURCE_BUILD_CANDIDATE: Exactly one original verified generation and immutable source required, not an old session source snapshot');
  const candidate = candidates[0]!; assert.ok(candidate.artifacts.some(artifact => artifact.projectId === 'agent' && artifact.targetId === 'provider'));
  const directory = resolve('/run/treeseed/development-containers', session.sessionId, 'agent/provider');
  assert.equal(readlinkSync('/proc/self/ns/mnt'), readlinkSync('/proc/1/ns/mnt'));
  const receipt = developmentRuntimeStatus(directory, runtimeRoots.map(value => value.target));
  const root = mkdtempSync(join(tmpdir(), 'selected-provider-source-')), clone = join(root, 'package');
  const inputs = new Map<string, Buffer>();
  const inventory = (directory: string, prefix = ''): Map<string, Buffer> => {
    const result = new Map<string, Buffer>();
    const walk = (path: string, name: string) => {
      const stat = lstatSync(path); assert.ok(!stat.isSymbolicLink(), 'SOURCE_BUILD_INPUT: Redirected compilation or selected code input');
      if (stat.isDirectory()) for (const child of readdirSync(path).sort()) walk(join(path, child), join(name, child));
      else { assert.ok(stat.isFile()); const bytes = readFileSync(path), after = lstatSync(path);
        assert.ok(stat.ino === after.ino && stat.dev === after.dev && stat.size === bytes.length && stat.mtimeMs === after.mtimeMs && stat.ctimeMs === after.ctimeMs);
        result.set(name, bytes); }
    }; walk(directory, prefix); return result;
  };
  try {
    mkdirSync(clone);
    for (const name of ['src', 'scripts']) { for (const [path, bytes] of inventory(join(worktree, name), name)) inputs.set(path, bytes);
      cpSync(join(worktree, name), join(clone, name), { recursive: true }); }
    for (const name of ['package.json', 'tsconfig.json', 'tsconfig.dist.json']) { inputs.set(name, readFileSync(join(worktree, name))); cpSync(join(worktree, name), join(clone, name)); }
    symlinkSync(join(worktree, 'node_modules'), join(clone, 'node_modules'), 'dir');
    const env = { ...process.env }; delete env.TREESEED_AGENT_PROJECT_HANDLERS_ENTRY;
    // Agent-package default source only. Project-owned compilation is covered
    // by its separate exact configured-entry native Kernel and managed cases;
    // no guessed project entry or registry-label fallback is introduced here.
    const compiled = spawnSync(process.execPath, ['--import', 'tsx', './scripts/build/build-dist.ts'],
      { cwd: clone, env, encoding: 'utf8', timeout: remaining(), maxBuffer: 33_554_432 });
    assert.ok(!compiled.error && compiled.signal === null && compiled.status === 0, 'SOURCE_BUILD_COMPILER: Complete original strict owning compiler failed; no installed/source fallback');
    const built = inventory(join(clone, 'dist')), selectedCode = inventory(join(directory, 'runtime/dist'));
    assert.ok(built.size > 0); assert.deepEqual([...selectedCode.keys()], [...built.keys()]);
    for (const [name, bytes] of built) assert.ok(selectedCode.get(name)!.equals(bytes), 'SOURCE_BUILD_BYTES: Selected provider code differs from held source compilation');
    const states = ['manager', 'runner'].map(service => {
      const native = spawnSync('/usr/bin/docker', ['inspect', `treeseed-agent-${service}-1`, '--format',
        '{"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"running":{{json .State.Running}},"pid":{{json .State.Pid}},"environment":{{json .Config.Env}}}'],
        { encoding: 'utf8', timeout: remaining(), maxBuffer: 1_048_576 });
      assert.ok(!native.error && native.signal === null && native.status === 0, 'SOURCE_BUILD_NATIVE_INSTANCE: Original owning instance unavailable');
      const instance = row(JSON.parse(native.stdout)); assert.ok(instance.running === true && typeof instance.pid === 'number' && Number.isInteger(instance.pid) && instance.pid > 0);
      assert.ok(Array.isArray(instance.environment)); const build = instance.environment.filter(value => typeof value === 'string' && value.startsWith('TREESEED_PROVIDER_RUNTIME_BUILD='));
      assert.ok(build.length === 1 && build[0] === `TREESEED_PROVIDER_RUNTIME_BUILD=${receipt.digest}`, 'SOURCE_BUILD_NATIVE_IDENTITY: Loaded provider pin differs from original complete copied-byte receipt');
      const labels: Record<string, string> = {};
      for (const [name, value] of Object.entries(row(instance.labels))) { assert.equal(typeof value, 'string'); assert.ok(typeof value === 'string'); labels[name] = value; }
      assertDevelopmentRuntimeMounts({ labels, mounts: instance.mounts }, sessionId, 'agent.provider', directory, runtimeRoots.map(value => value.target));
      const loaded = inventory(`/proc/${instance.pid}/root/app/dist`); assert.deepEqual([...loaded.keys()], [...built.keys()]);
      for (const [name, bytes] of built) assert.ok(loaded.get(name)!.equals(bytes), 'SOURCE_BUILD_NATIVE_BYTES: Actual instance sees a different generation');
      const descendants = [instance.pid], commands: string[][] = [];
      for (let index = 0; index < descendants.length; index++) {
        assert.ok(descendants.length <= 128, 'SOURCE_BUILD_NATIVE_PROCESS: Original bounded process ownership inventory exceeded');
        const pid = descendants[index]!; commands.push(readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'));
        const children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
        for (const value of children.split(/\s+/u).filter(Boolean)) { assert.match(value, /^[1-9][0-9]*$/u); const child = Number(value); assert.ok(!descendants.includes(child)); descendants.push(child); }
      }
      assert.ok(commands.some(args => args.some(value => /^\.\/dist\/provider\/lifecycle\/entrypoint\.js$/u.test(value)) && args.includes(service)),
        'SOURCE_BUILD_NATIVE_ENTRYPOINT: Actual owning Node process must load the original compiled entrypoint');
      return { service, pid: instance.pid, code: loaded };
    });
    const workday = read(['workdays', 'show', workdayId]), run = row(workday.run); assert.equal(run.id, workdayId);
    assert.ok(['completed', 'failed', 'cancelled', 'expired'].includes(String(run.status)));
    const started = Date.parse(String(run.startedAt)); assert.ok(Number.isFinite(started));
    // Workday events are not a substitute for a complete public assignment page.
    const all: Record<string, unknown>[] = [], ids = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined, previous: { time: number; id: string } | undefined;
    for (let index = 0; index < 40; index++) {
      const pageValue = read(['assignments', 'list', '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])]), page = row(pageValue.page);
      assert.ok(Array.isArray(pageValue.items) && pageValue.items.length <= 100 && page.limit === 100 && typeof page.hasMore === 'boolean');
      for (const value of pageValue.items) {
        const item = row(value), id = item.id, time = Date.parse(String(item.createdAt));
        assert.ok(typeof id === 'string' && id && !ids.has(id) && Number.isFinite(time));
        assert.ok(!previous || time < previous.time || (time === previous.time && id < previous.id));
        assert.ok(item.workDayId === null || typeof item.workDayId === 'string');
        if (item.workDayId === workdayId) assert.ok(time >= started);
        ids.add(id); previous = { time, id }; all.push(item);
      }
      if (!page.hasMore) { assert.equal(page.nextCursor, null); break; }
      assert.ok(index < 39 && pageValue.items.length === 100 && typeof page.nextCursor === 'string' && page.nextCursor && !cursors.has(page.nextCursor));
      const decoded = decodeCapacityPageCursor(page.nextCursor), last = all.at(-1)!; assert.ok(decoded && decoded.id === last.id && decoded.createdAt === last.createdAt);
      cursor = page.nextCursor; cursors.add(cursor);
    }
    const items = all.filter(item => item.workDayId === workdayId); assert.ok(items.length > 0);
    const completed = items.filter(item => item.status === 'completed' && assignmentAttemptSchema.parse(item.assignmentAttempt).effectiveProfile.handlerOrigin === 'agent-package');
    assert.ok(completed.length > 0, 'SOURCE_BUILD_NATIVE_EXECUTION: Actual completed default-handler managed execution required');
    for (const item of completed) { const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), result = assignmentResultSchema.parse(item.assignmentResult);
      assert.equal(attempt.workdayId, workdayId); assert.equal(attempt.provider.runtimeBuild, receipt.digest); assert.equal(result.assignmentId, attempt.id);
      assert.deepEqual(read(['assignments', 'show', attempt.id]), item); }
    assert.deepEqual(developmentRuntimeStatus(directory, runtimeRoots.map(value => value.target)), receipt);
    for (const state of states) { const loaded = inventory(`/proc/${state.pid}/root/app/dist`); assert.deepEqual([...loaded.keys()], [...built.keys()]);
      for (const [name, bytes] of state.code) assert.ok(loaded.get(name)!.equals(bytes)); }
    for (const [name, bytes] of inputs) { assert.ok(readFileSync(join(worktree, name)).equals(bytes)); assert.ok(readFileSync(join(clone, name)).equals(bytes)); }
    assert.deepEqual(read(['dev', 'status']), status); assert.deepEqual(read(['workdays', 'show', workdayId]), workday);
    assert.equal(execFileSync('/usr/bin/git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: remaining() }).trim(), head);
    assert.equal(cleanSource(), ''); assert.ok(readFileSync(cli).equals(cliBytes));
    // Read-only selected native code + actual canonical execution, not a claim
    // of a published OCI build, guest-image compiler lineage, model reasoning,
    // live project-owned source loading or an external billing/teardown pass.
  } finally { rmSync(root, { recursive: true, force: true }); }
});
