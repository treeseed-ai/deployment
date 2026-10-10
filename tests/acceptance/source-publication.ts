import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assignmentAttemptSchema, assignmentPathAllowed, assignmentReferenceSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { sandboxResultSchema, sourceWorkspaceKeySchema } from '@treeseed/sdk/capacity-provider/sandbox';
import { workspaceStorageRoot, simulationSourceRepository, sandboxBrokerConfigurationSchema, workspaceNbdServiceArguments,
  kataWarmOperations, WarmSandboxPool, containerdImageReference } from '@treeseed/deployment';
import { installedCli } from './public-cli.js';

function row(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'SOURCE_ACCEPTANCE_ROW: Original readable object required');
  return Object.fromEntries(Object.entries(value));
}

// Original public CLI, not a replacement runner, private API, created campaign,
// reconstructed settlement or a cross-package import of Agent test helpers.
test('Actual managed source publications retain native Git bytes released lease usage and host absence beside unchanged failed execution history', { timeout: 120_000 }, () => {
  const workspace = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT, workdayId = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID;
  const team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
  assert.ok(workspace && isAbsolute(workspace)); assert.match(workdayId ?? '', /^workday-[a-f0-9-]+$/u);
  const cli = installedCli(), cliBytes = readFileSync(cli);
  const read = (args: string[]) => {
    let bytes: string;
    try { bytes = execFileSync(process.execPath, [cli, ...args, '--server', 'local', '--team', team, '--json'],
      { cwd: workspace, env: process.env, encoding: 'utf8', timeout: 15_000, maxBuffer: 33_554_432 }); }
    catch { throw new Error('SOURCE_ACCEPTANCE_PUBLIC_READ: Original public command failed; raw credential-bearing diagnostics are not reported.'); }
    const envelope = row(JSON.parse(bytes)); assert.equal(envelope.ok, true); return row(envelope.result);
  };
  const pages = (args: string[]) => {
    const items: Record<string, unknown>[] = [], ids = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined, previous: { time: number; id: string } | undefined;
    for (let index = 0; index < 40; index++) {
      const observed = read([...args, '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])]), page = row(observed.page);
      assert.ok(Array.isArray(observed.items) && observed.items.length <= 100 && page.limit === 100 && typeof page.hasMore === 'boolean');
      for (const value of observed.items) {
        const item = row(value), id = item.id, time = Date.parse(String(item.createdAt));
        assert.ok(typeof id === 'string' && id && !ids.has(id) && Number.isFinite(time));
        assert.ok(!previous || time < previous.time || (time === previous.time && id < previous.id));
        ids.add(id); previous = { time, id }; items.push(item);
      }
      if (!page.hasMore) { assert.equal(page.nextCursor, null); return items; }
      assert.ok(observed.items.length === 100 && typeof page.nextCursor === 'string' && page.nextCursor && !cursors.has(page.nextCursor));
      const next = decodeCapacityPageCursor(page.nextCursor), last = items.at(-1)!;
      assert.ok(next && next.id === last.id && next.createdAt === last.createdAt);
      cursor = page.nextCursor; cursors.add(cursor);
    }
    assert.fail('SOURCE_ACCEPTANCE_PAGE: Original complete forty-page inventory bound exceeded');
  };
  const workday = read(['workdays', 'show', workdayId!]), run = row(workday.run);
  assert.equal(run.id, workdayId); assert.equal(run.executionMode, 'simulation');
  assert.ok(['completed', 'failed', 'cancelled', 'expired'].includes(String(run.status)));
  const inventory = pages(['assignments', 'list']), items = inventory.filter(item => item.workDayId === workdayId);
  assert.ok(items.length > 0);
  const sourceItems = items.filter(item => {
    const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
    return attempt.workspace.mode === 'git' && attempt.grant.sourceWrite.length > 0 && Object.hasOwn(row(item.lifecycleOutput), 'sandboxId');
  });
  assert.ok(sourceItems.some(item => item.status === 'completed'), 'SOURCE_ACCEPTANCE_COMPLETED: Actual published managed source execution required');
  assert.ok(sourceItems.some(item => ['failed', 'returned', 'cancelled', 'expired'].includes(String(item.status))),
    'SOURCE_ACCEPTANCE_FAILED: Actual failed or interrupted source attempt required, not a supplied failure receipt');
  const brokerPath = '/etc/treeseed/sandbox/broker.json', brokerBytes = readFileSync(brokerPath);
  const broker = sandboxBrokerConfigurationSchema.parse(JSON.parse(brokerBytes.toString('utf8')));
  assert.equal(readlinkSync('/proc/self/ns/mnt'), readlinkSync('/proc/1/ns/mnt'), 'SOURCE_ACCEPTANCE_HOST: Owning host namespace required');
  assert.ok(lstatSync(workspaceStorageRoot).isDirectory()); assert.equal(realpathSync(workspaceStorageRoot), workspaceStorageRoot);
  const catalogPath = join(workspaceStorageRoot, 'catalog.db'); assert.ok(lstatSync(catalogPath).isFile());
  const catalog = new DatabaseSync(catalogPath, { readOnly: true });
  const nativeBytes = new Map<string, Buffer>(), refs = new Map<string, string>(), sandboxIds = new Set<string>();
  const auxiliaryVmIds = new Set<string>(); let coldBuilds = 0, verifiedCandidates = 0;
  const publications: Array<{ attempt: ReturnType<typeof assignmentAttemptSchema.parse>; resultId: string;
    repository: string; nativeRepository: string; baseCommit: string; commit: string }> = [];
  const ownedDisks: Array<{ id: string; directory: string; device: string; unit: string; image: string }> = [];
  const usage = new Map<string, Record<string, unknown>[]>(), ledger = new Map<string, Record<string, unknown>[]>();
  const sql = () => ({ images: catalog.prepare('SELECT * FROM workspace_images ORDER BY id').all(),
    leases: catalog.prepare('SELECT * FROM workspace_leases ORDER BY id').all() });
  const absent = (path: string) => {
    try { lstatSync(path); } catch (error) {
      assert.ok(error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT', 'SOURCE_ACCEPTANCE_ABSENCE: Denied unreadable or arbitrary error is not absence'); return;
    }
    assert.fail('SOURCE_ACCEPTANCE_RESIDUE: Original owning execution directory or source disk remains');
  };
  const nativeGit = (repository: string, args: string[]) => execFileSync('/usr/bin/git', ['--git-dir', repository, ...args],
    { encoding: 'utf8', timeout: 15_000, maxBuffer: 33_554_432, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  const observeDiskAbsence = (disk: typeof ownedDisks[number]) => {
    const service = workspaceNbdServiceArguments({ ...disk, image: 'work.qcow2', readOnly: false });
    assert.equal(disk.unit, service.unit); assert.equal(disk.image, join(disk.directory, 'work.qcow2'));
    const runtimeArgument = service.args.find(value => value.startsWith('--property=RuntimeDirectory='));
    assert.ok(runtimeArgument);
    const runtime = `/run/${runtimeArgument.slice('--property=RuntimeDirectory='.length)}`;
    const observed = spawnSync('/usr/bin/systemctl', ['show', disk.unit, '--property=LoadState,ActiveState,SubState,MainPID,ControlPID'],
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 65_536 });
    assert.ok(!observed.error && observed.signal === null && [0, 4].includes(observed.status ?? -1),
      'SOURCE_ACCEPTANCE_NBD_SERVICE: Failed denied or timed-out native observation is not absence');
    const fields = Object.fromEntries(observed.stdout.trim().split('\n').map(line => line.split('=')));
    assert.deepEqual(fields, { LoadState: 'not-found', ActiveState: 'inactive', SubState: 'dead', MainPID: '0', ControlPID: '0' },
      'SOURCE_ACCEPTANCE_NBD_SERVICE: Original assignment service or processes remain');
    absent(runtime); absent(disk.directory);
    // The shared NBD device may have been reused. Check exact former ownership, never require global idle capacity.
    const fence = join(workspaceStorageRoot, 'devices', disk.device.slice('/dev/'.length), 'owner');
    try { assert.notEqual(readFileSync(fence, 'utf8'), disk.id, 'SOURCE_ACCEPTANCE_NBD_FENCE: Original device ownership remains'); }
    catch (error) { if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'ENOENT') throw error; }
    for (const pid of readdirSync('/proc').filter(value => /^[1-9][0-9]*$/u.test(value))) {
      let arguments_: string[];
      try { arguments_ = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); }
      catch (error) { if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') continue; throw error; }
      assert.ok(!arguments_.some(value => value === disk.image || value.startsWith(`${disk.directory}/`)
        || value === `--socket=${runtime}/nbd.sock`), 'SOURCE_ACCEPTANCE_NBD_PROCESS: Owned source disk or socket process remains');
    }
    assert.ok(!readFileSync('/proc/1/mountinfo', 'utf8').includes(disk.directory), 'SOURCE_ACCEPTANCE_NBD_MOUNT: Owned disk mount remains');
  };
  try {
    const beforeSql = JSON.stringify(sql());
    for (const project of new Set(items.map(item => String(item.projectId)))) {
      assert.ok(project && project !== 'undefined');
      usage.set(project, pages(['capacity', 'usage', '--project', project, '--workday', workdayId!]));
      ledger.set(project, pages(['capacity', 'ledger', '--project', project, '--workday', workdayId!]));
    }
    for (const item of sourceItems) {
      const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), output = row(item.lifecycleOutput), sandboxId = output.sandboxId;
      assert.equal(item.id, attempt.id); assert.equal(item.attemptCount, attempt.attempt);
      assert.ok(typeof sandboxId === 'string' && /^sandbox-[A-Za-z0-9-]{1,128}$/u.test(sandboxId) && !sandboxIds.has(sandboxId)); sandboxIds.add(sandboxId);
      const path = join(workspaceStorageRoot, 'results', `${sandboxId}.json`), info = lstatSync(path);
      assert.ok(info.isFile() && info.uid === 0 && (info.mode & 0o077) === 0 && info.nlink === 1);
      assert.equal(realpathSync(path), path); const bytes = readFileSync(path); nativeBytes.set(path, bytes);
      const receipt = row(JSON.parse(bytes.toString('utf8'))), source = sourceWorkspaceKeySchema.parse(receipt.source);
      assert.equal(receipt.schemaVersion, 'treeseed.source-result/v1'); assert.equal(receipt.sandboxId, sandboxId); assert.equal(receipt.teardownVerified, true);
      assert.equal(source.teamId, attempt.teamId); assert.equal(source.projectId, attempt.projectId);
      assert.ok(attempt.workspace.mode === 'git'); assert.equal(source.commit, attempt.workspace.baseCommit);
      assert.ok(typeof receipt.leaseId === 'string' && receipt.leaseId);
      const leases = catalog.prepare('SELECT * FROM workspace_leases WHERE id=?').all(receipt.leaseId);
      assert.equal(leases.length, 1); const lease = row(leases[0]);
      assert.equal(lease.state, 'released'); assert.equal(lease.provider_id, attempt.provider.providerId);
      assert.equal(lease.assignment_id, attempt.id); assert.equal(lease.attempt, attempt.attempt);
      assert.equal(lease.mode, 'work'); assert.equal(lease.publication, 'simulation-branch'); assert.equal(lease.result_artifact_id, `${sandboxId}.json`);
      const images = catalog.prepare('SELECT source_json FROM workspace_images WHERE id=?').all(String(lease.image_id));
      assert.equal(images.length, 1); assert.deepEqual(sourceWorkspaceKeySchema.parse(JSON.parse(String(row(images[0]).source_json))), source);
      const nativeResult = sandboxResultSchema.parse(receipt.result); assert.equal(nativeResult.sandboxId, sandboxId); assert.equal(nativeResult.assignmentId, attempt.id);
      assert.deepEqual(nativeResult, receipt.result, 'SOURCE_ACCEPTANCE_NATIVE_RESULT: Original broker result must already be canonical, not repaired by parsing');
      assert.equal(receipt.status, nativeResult.status);
      const nativeTime = Date.parse(String(receipt.completedAt)), terminal = Date.parse(String(item.completedAt ?? item.returnedAt ?? item.failedAt));
      assert.ok(Number.isFinite(nativeTime) && Number.isFinite(terminal) && Date.parse(attempt.createdAt) <= nativeTime && nativeTime <= terminal);
      const measurements = usage.get(attempt.projectId)!;
      const aggregate = measurements.filter(value => value.assignmentId === attempt.id && value.accountingMode === 'aggregate');
      const diagnostic = measurements.filter(value => value.assignmentId === attempt.id && value.accountingMode === 'informational' && value.usageDimension === 'diagnostic-0');
      assert.equal(aggregate.length, 1); assert.equal(diagnostic.length, 1);
      for (const measurement of [aggregate[0]!, diagnostic[0]!]) {
        assert.equal(measurement.assignmentAttempt, attempt.attempt); assert.equal(measurement.capacityProviderId, attempt.provider.providerId);
        assert.equal(measurement.projectId, attempt.projectId); assert.equal(measurement.workDayId, attempt.workdayId);
      }
      assert.deepEqual(diagnostic[0]!.nativeUsage, nativeResult.usage, 'SOURCE_ACCEPTANCE_USAGE: First native executor counters changed before public readback');
      assert.equal(diagnostic[0]!.activeSeconds, 0); assert.equal(diagnostic[0]!.elapsedSeconds, 0);
      const charges = ledger.get(attempt.projectId)!.filter(value => value.assignmentId === attempt.id && value.phase === 'task_completed_actual_settlement');
      assert.equal(charges.length, 1); assert.equal(charges[0]!.reservationId, attempt.reservationId);
      assert.equal(charges[0]!.activeSeconds, aggregate[0]!.activeSeconds); assert.equal(charges[0]!.elapsedSeconds, aggregate[0]!.elapsedSeconds);
      if (item.status === 'completed') {
        // Read actual sanitized native events from the existing private journal,
        // not the public shape-only summary or a reconstructed timing receipt.
        const time = row(row(row(item.capacityEnvelope).budget).time);
        const startedAt = time.executionStartedAt, deadlineAt = time.executionDeadlineAt;
        assert.ok(typeof startedAt === 'string' && typeof deadlineAt === 'string', 'SOURCE_ACCEPTANCE_CLOCK_WINDOW: Original API productive window required');
        const started = Date.parse(startedAt), deadline = Date.parse(deadlineAt);
        assert.ok(Number.isFinite(started) && Number.isFinite(deadline) && started < deadline
          && Date.parse(attempt.createdAt) <= started && deadline <= Date.parse(attempt.deadline),
        'SOURCE_ACCEPTANCE_CLOCK_WINDOW: Productive window must remain inside original admitted authority');
        const events = row(nativeResult.diagnostics).providerEvents;
        assert.ok(Array.isArray(events) && events.length > 0, 'SOURCE_ACCEPTANCE_CLOCK_EVENTS: Complete native model events required');
        const tools = events.map(row).filter(event => (event.type === 'item.started' || event.type === 'item.completed')
          && ['mcp_tool_call', 'command_execution', 'file_change', 'web_search'].includes(String(row(event.item).type)));
        const isClock = (event: Record<string, unknown>) => {
          const action = row(event.item);
          return action.type === 'mcp_tool_call' && action.server === 'treedx' && action.tool === 'treeseed_time_status';
        };
        assert.ok(tools.length >= 2 && isClock(tools[0]!) && isClock(tools.at(-1)!)
          && tools.at(-1)!.type === 'item.completed', 'SOURCE_ACCEPTANCE_CLOCK_ORDER: First and final native tool actions must be the original clock');
        const pending = new Set<string>(), completed = new Set<string>();
        let checks = 0, remaining = Math.ceil((deadline - started) / 1_000), checkedSinceBlocking = false;
        for (const event of tools) {
          const action = row(event.item), id = action.id;
          assert.ok(typeof id === 'string' && id, 'SOURCE_ACCEPTANCE_CLOCK_TOOL: Native tool identity required');
          assert.ok(isClock(event) || checks > 0, 'SOURCE_ACCEPTANCE_CLOCK_INITIAL: No other attempted tool may precede the first successful clock result');
          if (action.type === 'command_execution' && (event.type === 'item.started' || !pending.has(id))) {
            assert.ok(checkedSinceBlocking, 'SOURCE_ACCEPTANCE_CLOCK_ONGOING: Each potentially blocking command requires a fresh authoritative check');
            checkedSinceBlocking = false;
          }
          if (event.type === 'item.started') {
            assert.ok(!pending.has(id) && !completed.has(id), 'SOURCE_ACCEPTANCE_CLOCK_TOOL: Reused or overlapping native tool identity');
            pending.add(id); continue;
          }
          assert.ok(!completed.has(id), 'SOURCE_ACCEPTANCE_CLOCK_TOOL: Duplicate completed native tool identity');
          pending.delete(id); completed.add(id);
          if (!isClock(event)) continue;
          assert.ok(action.status === 'completed' && !action.error, 'SOURCE_ACCEPTANCE_CLOCK_RESULT: Failed native clock is not completion authority');
          const result = row(action.result), value = row(result.structuredContent);
          assert.ok(result.isError !== true && value.startedAt === startedAt && value.deadlineAt === deadlineAt,
            'SOURCE_ACCEPTANCE_CLOCK_RESULT: Native result must bind the same original API productive window');
          assert.ok(typeof value.remainingSeconds === 'number' && Number.isInteger(value.remainingSeconds)
            && value.remainingSeconds > 0 && value.remainingSeconds <= remaining,
          'SOURCE_ACCEPTANCE_CLOCK_REMAINING: Completed model execution requires positive nonincreasing original remaining authority');
          assert.ok(Array.isArray(result.content) && result.content.length === 1, 'SOURCE_ACCEPTANCE_CLOCK_CONTENT: Exact original MCP content required');
          const content = row(result.content[0]);
          assert.ok(content.type === 'text' && typeof content.text === 'string'
            && content.text === JSON.stringify(value), 'SOURCE_ACCEPTANCE_CLOCK_CONTENT: Native content and structured result must agree byte for byte');
          remaining = value.remainingSeconds; checks++; checkedSinceBlocking = true;
        }
        assert.ok(checks >= 2 && pending.size === 0, 'SOURCE_ACCEPTANCE_CLOCK_CLOSEOUT: Two complete clock results and no pending native tools required');
        const awareness = row(nativeResult.timingAwareness);
        assert.ok(awareness.schemaVersion === 'treeseed.assignment-timing-awareness/v1' && awareness.requiredChecks === 2
          && awareness.completedChecks === checks && awareness.firstToolCompliant === true && awareness.finalToolCompliant === true,
        'SOURCE_ACCEPTANCE_CLOCK_RECEIPT: Existing timing receipt must agree with independently read native results');
        const reference = assignmentReferenceSchema.parse(receipt.sourceReference); assert.ok(reference.kind === 'git');
        assert.equal(reference.repository, attempt.workspace.repository); assert.equal(reference.branch, attempt.workspace.branch);
        assert.equal(nativeResult.status, 'completed'); assert.deepEqual(output.sourceReference, reference);
        const result = assignmentResultSchema.parse(item.assignmentResult); assert.equal(result.assignmentId, attempt.id);
        assert.deepEqual(result.timingAwareness, nativeResult.timingAwareness,
          'SOURCE_ACCEPTANCE_CLOCK_READBACK: Public canonical completion must retain the exact independently read native clock receipt');
        assert.equal(result.status, 'completed'); assert.ok(result.references.some(value => value.kind === 'git' && value.repository === reference.repository
          && value.commit === reference.commit && (value.branch === undefined || value.branch === reference.branch)));
        assert.deepEqual(result.usage.native, aggregate[0]!.nativeUsage);
        const repository = simulationSourceRepository(workspaceStorageRoot, source);
        assert.ok(lstatSync(repository).isDirectory()); assert.equal(realpathSync(repository), repository);
        const ref = `refs/heads/${reference.branch}`;
        assert.equal(nativeGit(repository, ['rev-parse', '--verify', `${ref}^{commit}`]).trim(), reference.commit);
        assert.equal(nativeGit(repository, ['merge-base', '--is-ancestor', source.commit, reference.commit]), '');
        nativeGit(repository, ['fsck', '--strict', '--no-reflogs', reference.commit]);
        // Derive changed paths from the independently read native commit,
        // never from a handler's path summary or its result reference alone.
        const changedPaths = nativeGit(repository, ['diff', '--no-renames', '--name-only', '-z', source.commit, reference.commit]).split('\0');
        assert.equal(changedPaths.pop(), '');
        assert.equal(new Set(changedPaths).size, changedPaths.length);
        for (const path of changedPaths) assert.ok(path && assignmentPathAllowed(path, attempt.workspace.writablePaths),
          'SOURCE_ACCEPTANCE_NATIVE_PATH: Actual published addition deletion rename or modification exceeds the original assignment grant');
        refs.set(`${repository}\n${ref}`, nativeGit(repository, ['show', '--format=raw', '--no-patch', reference.commit]));
        publications.push({ attempt, resultId: result.id, repository: reference.repository, nativeRepository: repository,
          baseCommit: source.commit, commit: reference.commit });
      } else {
        assert.equal(receipt.sourceReference, null); assert.notEqual(nativeResult.status, 'completed');
      }
      const jobPath = join(workspaceStorageRoot, 'jobs', `${sandboxId}.json`), jobBytes = readFileSync(jobPath); nativeBytes.set(jobPath, jobBytes);
      const job = row(JSON.parse(jobBytes.toString('utf8'))), disk = row(job.disk);
      assert.equal(job.state, 'stopped'); assert.equal(job.leaseId, receipt.leaseId);
      const owner = row(job.owner);
      assert.equal(owner.assignmentId, attempt.id); assert.equal(owner.providerId, attempt.provider.providerId);
      assert.equal(owner.attempt, attempt.attempt); assert.equal(owner.teamId, attempt.teamId); assert.equal(owner.projectId, attempt.projectId);
      const ownVm = (value: unknown) => {
        assert.ok(typeof value === 'string' && /^sandbox-warm-[a-f0-9-]{36}$/u.test(value)
          && !auxiliaryVmIds.has(value), 'SOURCE_ACCEPTANCE_AUXILIARY_ID: Original unique native VM identity required, not an inferred stopped count');
        auxiliaryVmIds.add(value); return value;
      };
      if (Object.hasOwn(job, 'builderIds')) {
        assert.ok(Array.isArray(job.builderIds) && job.builderIds.length === 2,
          'SOURCE_ACCEPTANCE_BUILD_IDS: Original cold builder and source verifier identities required');
        job.builderIds.forEach(ownVm); coldBuilds++;
      }
      if (item.status === 'completed') {
        const candidatePath = join(workspaceStorageRoot, 'candidates', `${sandboxId}.json`), details = lstatSync(candidatePath);
        assert.ok(details.isFile() && details.uid === 0 && (details.mode & 0o077) === 0 && details.nlink === 1);
        assert.equal(realpathSync(candidatePath), candidatePath);
        const bytes = readFileSync(candidatePath); nativeBytes.set(candidatePath, bytes);
        const candidate = row(JSON.parse(bytes.toString('utf8')));
        assert.equal(candidate.state, 'published'); assert.equal(candidate.assignmentId, attempt.id);
        assert.equal(candidate.providerId, attempt.provider.providerId); assert.equal(candidate.attempt, attempt.attempt);
        const verifierId = ownVm(candidate.verifierId);
        assert.equal(Object.hasOwn(candidate, 'verifierChildId'), false); assert.equal(candidate.verifierStopped, true);
        assert.deepEqual(candidate.reference, receipt.sourceReference); verifiedCandidates++;
      }
      assert.ok(typeof disk.id === 'string' && /^workspace-lease-[a-f0-9-]{36}$/u.test(disk.id));
      const directory = join(workspaceStorageRoot, 'leases', disk.id); assert.equal(disk.directory, directory);
      assert.ok(typeof disk.device === 'string' && /^\/dev\/nbd[0-9]+$/u.test(disk.device)
        && typeof disk.unit === 'string' && typeof disk.image === 'string', 'SOURCE_ACCEPTANCE_NBD_CUSTODY: Original native disk identity required');
      const owned = { id: disk.id, directory, device: disk.device, unit: disk.unit, image: disk.image };
      ownedDisks.push(owned); observeDiskAbsence(owned);
      absent(directory); absent(join(broker.stateRoot, sandboxId));
    }
    let retainedPredecessorPaths = 0;
    let nativeIntegrations = 0;
    assert.equal(new Set(publications.map(value => value.resultId)).size, publications.length, 'SOURCE_ACCEPTANCE_PREDECESSOR: Distinct original result identities required');
    for (const current of publications) {
      assert.ok(current.attempt.workspace.mode === 'git');
      const primaryInputs = publications.filter(previous => current.attempt.predecessorResultIds.includes(previous.resultId)
        && previous.repository === current.repository && previous.attempt.projectId === current.attempt.projectId);
      if (current.attempt.grant.tools.includes('release') && new Set(primaryInputs.map(value => value.commit)).size > 1) {
        for (const input of primaryInputs) {
          assert.equal(nativeGit(current.nativeRepository, ['merge-base', '--is-ancestor', input.commit, current.commit]), '',
            'SOURCE_ACCEPTANCE_INTEGRATION: Actual integration commit does not retain an exact original Git input');
        }
        // Prove independent branches using native Git's documented exit 1,
        // never interpreting arbitrary command errors as divergent history.
        const ancestor = (left: string, right: string) => {
          const value = spawnSync('/usr/bin/git', ['--git-dir', current.nativeRepository, 'merge-base', '--is-ancestor', left, right],
            { encoding: 'utf8', timeout: 15_000, maxBuffer: 65_536, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
          assert.ok(!value.error && value.signal === null && [0, 1].includes(value.status ?? -1), 'SOURCE_ACCEPTANCE_INTEGRATION: Failed native ancestry read is not divergence');
          return value.status === 0;
        };
        if (primaryInputs.some((left, index) => primaryInputs.slice(index + 1).some(right => !ancestor(left.commit, right.commit) && !ancestor(right.commit, left.commit)))) nativeIntegrations++;
      }
      for (const predecessorId of current.attempt.predecessorResultIds) {
        const previous = publications.find(value => value.resultId === predecessorId);
        if (!previous || previous.repository !== current.repository || previous.attempt.projectId !== current.attempt.projectId) continue;
        assert.ok(previous.attempt.teamId === current.attempt.teamId && previous.attempt.workdayId === current.attempt.workdayId
          && previous.attempt.projectId === current.attempt.projectId && previous.nativeRepository === current.nativeRepository,
        'SOURCE_ACCEPTANCE_PREDECESSOR: Native publication must stay in the original source security domain');
        assert.ok(current.attempt.contextRefs.some(value => value.store === 'git' && value.repository === previous.repository
          && value.commit === previous.commit), 'SOURCE_ACCEPTANCE_PREDECESSOR: Exact predecessor Git context required');
        assert.equal(nativeGit(current.nativeRepository, ['merge-base', '--is-ancestor', previous.commit, current.commit]), '');
        const changed = nativeGit(previous.nativeRepository, ['diff', '--no-renames', '--name-only', '-z', previous.baseCommit, previous.commit]).split('\0');
        assert.equal(changed.pop(), '');
        for (const path of changed) {
          assert.ok(path && assignmentPathAllowed(path, ['**']), 'SOURCE_ACCEPTANCE_PREDECESSOR_PATH: Safe exact native relative path required');
          if (assignmentPathAllowed(path, current.attempt.workspace.writablePaths)) continue;
          const original = nativeGit(previous.nativeRepository, ['ls-tree', '-z', previous.commit, '--', path]);
          assert.ok(nativeGit(current.nativeRepository, ['ls-tree', '-z', current.commit, '--', path]) === original,
            'SOURCE_ACCEPTANCE_PREDECESSOR_BYTES: Denied predecessor path mode object identity or retained deletion changed');
          const blob = /^(?:100644|100755|120000) blob ([a-f0-9]{40}|[a-f0-9]{64})\t/u.exec(original)?.[1];
          if (blob) {
            const bytes = (repository: string, commit: string) => execFileSync('/usr/bin/git', ['--git-dir', repository, 'cat-file', 'blob', `${commit}:${path}`],
              { timeout: 15_000, maxBuffer: 33_554_432, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
            assert.ok(bytes(previous.nativeRepository, previous.commit).equals(bytes(current.nativeRepository, current.commit)), 'SOURCE_ACCEPTANCE_PREDECESSOR_BYTES: Untrimmed native predecessor blob bytes changed');
          }
          retainedPredecessorPaths++;
        }
      }
    }
    assert.ok(retainedPredecessorPaths > 0, 'SOURCE_ACCEPTANCE_PREDECESSOR_INVENTORY: Actual dependent source execution with denied predecessor paths required');
    assert.ok(nativeIntegrations > 0, 'SOURCE_ACCEPTANCE_INTEGRATION_INVENTORY: Actual release-authorized integration of independently divergent native inputs required');
    const ctr = (kind: 'tasks' | 'containers') => execFileSync('/usr/bin/ctr', ['--address', broker.containerdAddress, '--namespace', broker.namespace, kind, 'list', '--quiet'],
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 4_194_304 }).split(/\s+/u).filter(Boolean);
    for (const id of [...ctr('tasks'), ...ctr('containers')]) assert.ok(!sandboxIds.has(id), 'SOURCE_ACCEPTANCE_NATIVE_TASK: Actual execution container or task remains');
    assert.ok(coldBuilds > 0 && verifiedCandidates > 0,
      'SOURCE_ACCEPTANCE_AUXILIARY_INVENTORY: Actual cold source build and published candidate verifier required; warm cache alone is not physical proof');
    const actualTasks = ctr('tasks'), actualContainers = ctr('containers');
    for (const id of auxiliaryVmIds) for (const resource of [id, `${id}-ready`, `${id}-source`, `${id}-candidate`]) {
      assert.ok(!actualTasks.includes(resource) && !actualContainers.includes(resource),
        'SOURCE_ACCEPTANCE_AUXILIARY_RESIDUE: Original builder verifier or readiness child remains');
    }
    const mounts = readFileSync('/proc/1/mountinfo', 'utf8');
    for (const id of sandboxIds) assert.ok(!mounts.includes(`${broker.stateRoot}/${id}/`), 'SOURCE_ACCEPTANCE_NATIVE_MOUNT: Owning execution mount remains');
    for (const [path, bytes] of nativeBytes) assert.ok(readFileSync(path).equals(bytes), 'SOURCE_ACCEPTANCE_IMMUTABLE: Native failed or successful history changed');
    assert.equal(JSON.stringify(sql()), beforeSql);
    for (const [key, bytes] of refs) {
      const [repository, ref] = key.split('\n'); const commit = nativeGit(repository!, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
      assert.equal(nativeGit(repository!, ['show', '--format=raw', '--no-patch', commit]), bytes);
    }
    assert.equal(JSON.stringify(pages(['assignments', 'list'])), JSON.stringify(inventory));
    assert.equal(JSON.stringify(read(['workdays', 'show', workdayId!])), JSON.stringify(workday));
    for (const [project, observations] of usage) assert.equal(JSON.stringify(pages(['capacity', 'usage', '--project', project, '--workday', workdayId!])), JSON.stringify(observations));
    for (const [project, observations] of ledger) assert.equal(JSON.stringify(pages(['capacity', 'ledger', '--project', project, '--workday', workdayId!])), JSON.stringify(observations));
    assert.ok(readFileSync(cli).equals(cliBytes)); assert.ok(readFileSync(brokerPath).equals(brokerBytes));
    for (const disk of ownedDisks) observeDiskAbsence(disk);
  } finally { catalog.close(); }
  // Readback of native publication and represented builder/verifier/execution absence.
  // Unrelated shared warm VMs, NBD services, provider sessions, externally billed model
  // counters and full source-to-selected-build provenance remain separate.
});

test('Native owning warm pool drains only its idle Kata VM and caller-owned execution VM beside immutable actual SDK terminal Workday', { timeout: 30_000 }, async () => {
  const workspace = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT, workdayId = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID;
  assert.ok(workspace && isAbsolute(workspace)); assert.match(workdayId ?? '', /^workday-[a-f0-9-]+$/u);
  const team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed', cli = installedCli();
  const cliBytes = readFileSync(cli), brokerPath = '/etc/treeseed/sandbox/broker.json', brokerBytes = readFileSync(brokerPath);
  const broker = sandboxBrokerConfigurationSchema.parse(JSON.parse(brokerBytes.toString('utf8')));
  assert.equal(readlinkSync('/proc/self/ns/mnt'), readlinkSync('/proc/1/ns/mnt'));
  const image = broker.guestImages[0]; assert.ok(image, 'WARM_NATIVE_IMAGE: Existing pinned image required');
  const read = (args: string[]) => {
    let bytes: string;
    try { bytes = execFileSync(process.execPath, [cli, ...args, '--server', 'local', '--team', team, '--json'],
      { cwd: workspace, env: process.env, encoding: 'utf8', timeout: 5000, maxBuffer: 33_554_432 }); }
    catch { throw new Error('WARM_NATIVE_PUBLIC_READ: Original public read failed; no credential-bearing diagnostics disclosed'); }
    const envelope = row(JSON.parse(bytes)); assert.equal(envelope.ok, true); return row(envelope.result);
  };
  const publicRun = read(['workdays', 'show', workdayId!]), run = row(publicRun.run);
  assert.equal(run.id, workdayId); assert.equal(run.executionMode, 'simulation');
  assert.ok(['completed', 'failed', 'cancelled', 'expired'].includes(String(run.status)));
  const native = kataWarmOperations(broker, error => { throw error; }), created: string[] = [];
  const pool = new WarmSandboxPool({ ...native, create: async shape => {
    const id = await native.create(shape); created.push(id); return id;
  } }, 1);
  const list = (kind: 'tasks' | 'containers') => {
    const result = spawnSync('/usr/bin/ctr', ['--address', broker.containerdAddress, '--namespace', broker.namespace, kind, 'list', '--quiet'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 65_536, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } });
    assert.ok(!result.error && result.signal === null && result.status === 0, 'WARM_NATIVE_READ: Denied or failed containerd observation is not absence');
    return result.stdout.trim().split(/\s+/u).filter(Boolean);
  };
  const shape = { image: containerdImageReference(image.image, image.digest), cpuCores: 1, memoryBytes: 1_073_741_824, network: 'none' as const };
  try {
    const acquired = await pool.acquire(shape);
    assert.equal(acquired.warmed, false); assert.match(acquired.id, /^sandbox-warm-[a-f0-9-]{36}$/u);
    // Drain awaits the original pending prewarm creation and destroys that idle VM only.
    await pool.drain(); assert.equal(created.length, 2); assert.equal(new Set(created).size, 2);
    const idle = created.find(id => id !== acquired.id); assert.ok(idle);
    for (const kind of ['tasks', 'containers'] as const) {
      const actual = list(kind); assert.ok(actual.includes(acquired.id)); assert.ok(!actual.includes(idle));
      for (const id of created) assert.ok(!actual.includes(`${id}-ready`));
    }
    await native.destroy(acquired.id); await native.destroy(acquired.id);
    for (const kind of ['tasks', 'containers'] as const) for (const id of created) assert.ok(!list(kind).includes(id));
    await assert.rejects(pool.acquire(shape), /stopped/u);
    assert.deepEqual(read(['workdays', 'show', workdayId!]), publicRun);
    assert.deepEqual(readFileSync(cli), cliBytes); assert.deepEqual(readFileSync(brokerPath), brokerBytes);
  } finally {
    await pool.drain();
    const outcomes = await Promise.allSettled(created.map(id => native.destroy(id)));
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  }
  // This owns fresh unassigned pool VMs. It does not retrofit missing builder/verifier
  // identities, claim model charges, or infer other providers' resources are idle.
});
