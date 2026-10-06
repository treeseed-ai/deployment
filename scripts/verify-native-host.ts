import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SSH_KVM_PREFLIGHT } from '../src/infrastructure/capacity/ssh-preflight.js';

/** Only the empty, disposable Actions VM may receive the original host installer. */
export function assertDisposableNativeHost(env: NodeJS.ProcessEnv, uid: number | undefined, cwd: string,
  present: (path: string) => boolean = existsSync) {
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted'
    || env.GITHUB_REPOSITORY !== 'treeseed-ai/deployment' || env.TREESEED_PRIVILEGED_CACHE_TESTS !== '1'
    || uid !== 0 || !env.GITHUB_WORKSPACE || resolve(env.GITHUB_WORKSPACE) !== resolve(cwd)) {
    throw new Error('An explicitly authorized root GitHub-hosted Deployment workspace is required.');
  }
  for (const path of ['/etc/treeseed', '/var/lib/treeseed', '/usr/lib/treeseed', '/dev/mapper/treeseed-provider-data']) {
    if (present(path)) throw new Error(`Disposable native installation refuses existing TreeSeed state: ${path}`);
  }
}

async function initialize() {
  assertDisposableNativeHost(process.env, process.getuid?.(), realpathSync(process.cwd()));
  // Reuse the original OS/actual KVM_CREATE_VM qualification, not a path-existence substitute.
  execFileSync('/usr/bin/python3', ['-'], { input: SSH_KVM_PREFLIGHT, stdio: ['pipe', 'inherit', 'inherit'] });
  const held = new Map(['workspace-image-builder', 'workspace-candidate-vm', 'workspace-builder-guest', 'workspace-candidate-guest']
    .map(name => [resolve(`dist/src/sandbox/${name}.js`), readFileSync(`dist/src/sandbox/${name}.js`)]));
  const packageNames = ['treeseed-host-runtime', 'treeseed-kata-runtime', 'treeseed-manager', 'treeseed-sdk',
    'treeseed-cli', 'treeseed-release-catalog', 'treeseed-release-catalog-development'];
  const inventory = readdirSync('release/out');
  const packages = packageNames.map(name => {
    const matches = inventory.filter(file => file.startsWith(`${name}_`) && file.endsWith('.deb'));
    if (matches.length !== 1) throw new Error(`One original built ${name} package is required.`);
    return resolve('release/out', matches[0]!);
  });
  execFileSync('/usr/bin/apt-get', ['update'], { stdio: 'inherit' });
  execFileSync('/usr/bin/apt-get', ['install', '--yes', '--no-install-recommends', ...packages],
    { stdio: 'inherit', env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
  execFileSync('/usr/lib/treeseed/manager/bin/initialize-pki', [], { stdio: 'inherit' });

  // The installed CLI uses its original parser, SDK contracts, real manager socket
  // and supervisor. Only interactive input/output is supplied for unattended CI.
  const { loadCatalog } = await import('../src/catalog/load.js');
  const { verifyProviderSecurity } = await import('../src/security/provider-volume.js');
  const command = (executable: string, args: readonly string[], input?: string) => {
    try { return execFileSync(executable, [...args], { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { throw new Error(`Original disposable installer operation failed: ${executable}`); }
  };
  const development = loadCatalog('/usr/share/treeseed/catalogs/development.json');
  command('/usr/bin/systemctl', ['start', 'treeseed-manager-supervisor.service', 'treeseed-manager-api.service']);
  command('/usr/lib/treeseed/runtime/bin/node', ['/usr/lib/treeseed/manager/dist/src/bin/wait-supervisor.js']);
  const runtimePath = '/usr/lib/treeseed/cli/dist/cli/runtime.js';
  const runtime: unknown = await import(runtimePath);
  if (!runtime || typeof runtime !== 'object' || !('runCommandLine' in runtime)
    || typeof runtime.runCommandLine !== 'function') throw new Error('Original installed trsd command runtime is required.');
  const runCommandLine = runtime.runCommandLine;
  const registration = randomBytes(32).toString('base64url'), recovery = randomBytes(32).toString('base64url');
  const answers = new Map([
    ['Control-plane API HTTPS URL: ', 'https://127.0.0.1'],
    ['Team capacity-provider registration code: ', registration],
    ['Recovery bundle passphrase: ', recovery], ['Repeat recovery bundle passphrase: ', recovery],
  ]);
  const prompt = (question: string) => {
    const answer = answers.get(question);
    if (!answer) throw new Error('Unexpected original installer prompt.');
    return answer;
  };
  const cli = async (argv: string[]) => {
    const outputs: string[] = [];
    const exit: unknown = await runCommandLine([...argv, '--json'], {
      interactiveUi: false, prompt, promptSecret: prompt, write: (output: string) => outputs.push(output),
    });
    if (exit !== 0 || outputs.length !== 1) throw new Error(`Original trsd ${argv.slice(0, 3).join(' ')} failed.`);
    const envelope: unknown = JSON.parse(outputs[0]!);
    if (!envelope || typeof envelope !== 'object' || !('ok' in envelope) || envelope.ok !== true) {
      throw new Error('Original trsd installer did not return successful command evidence.');
    }
  };
  await cli(['host', 'initialize', '--profile', 'capacity-provider', '--confirm', '--yes']);
  // Controlled unused registration input is NOT enrollment. The original restart
  // fence remains stopped: no Agent/model/provider credentials or live work is activated.
  const { loadUpdateState } = await import('../src/manager/update-state.js');
  const state = loadUpdateState();
  if (state.runtimeStopped !== true) throw new Error('Disposable capacity host must retain its original stopped-runtime fence.');
  try {
    await cli(['host', 'security', 'initialize', '--confirm', '--recovery-bundle', '/var/lib/treeseed/manager/security/native-ci-recovery.json']);
  } catch (error) {
    // Read only original public boolean readiness facts, never helper stderr,
    // configuration, key files, recovery material or credential-bearing events.
    const { providerSecurityStatus } = await import('../src/security/provider-volume.js');
    const { loadSandboxBrokerConfiguration } = await import('../src/sandbox/configuration.js');
    const { inspectSandboxHost } = await import('../src/sandbox/doctor.js');
    const checks = existsSync('/etc/treeseed/sandbox/broker.json')
      ? inspectSandboxHost(loadSandboxBrokerConfiguration(), { requireBrokerSocket: true }).checks : null;
    console.error(JSON.stringify({ security: providerSecurityStatus(), sandboxChecks: checks }));
    for (const service of ['treeseed-manager-supervisor', 'treeseed-manager-api', 'treeseed-provider-volume', 'treeseed-sandbox-broker']) {
      console.error(command('/usr/bin/systemctl', ['show', `${service}.service`, '--property=ActiveState,SubState,Result,ExecMainStatus']));
    }
    const brokerJournal = command('/usr/bin/journalctl', ['--unit=treeseed-sandbox-broker.service', '--no-pager', '--output=cat', '--lines=100']);
    console.error(JSON.stringify({ brokerStartup: {
      catalogExists: existsSync('/var/lib/treeseed/agent/workspaces/catalog.db'),
      leasesDirectoryExists: existsSync('/var/lib/treeseed/agent/workspaces/leases'),
      sqliteOpenFailure: brokerJournal.includes('unable to open database file'),
      moduleMissing: brokerJournal.includes('ERR_MODULE_NOT_FOUND'),
      readOnlyFilesystem: brokerJournal.includes('EROFS'), permissionDenied: brokerJournal.includes('EACCES'),
      startupFrames: [...new Set(brokerJournal.match(/\/usr\/lib\/treeseed\/manager\/dist\/src\/[a-zA-Z0-9/_.-]+\.js:[0-9]+:[0-9]+/gu) ?? [])],
    } }));
    throw error;
  }
  const receipt: unknown = JSON.parse(readFileSync('/var/lib/treeseed/manager/security/security-receipt.json', 'utf8'));
  if (!receipt || typeof receipt !== 'object' || !('state' in receipt) || receipt.state !== 'known-good'
    || !verifyProviderSecurity(command).verified || !loadUpdateState().runtimeStopped) throw new Error('Actual encrypted native host readiness with stopped runtime required.');
  const { loadSandboxBrokerConfiguration } = await import('../src/sandbox/configuration.js');
  if (loadSandboxBrokerConfiguration().modelGateway) throw new Error('Disposable native CI must not activate model credentials.');
  for (const project of ['treeseed-agent', 'treeseed-capacity-provider']) {
    if (command('/usr/bin/docker', ['ps', '--quiet', '--filter', `label=com.docker.compose.project=${project}`]).trim()) {
      throw new Error('Disposable native CI must not activate provider workloads.');
    }
  }
  for (const [path, bytes] of held) if (!readFileSync(path).equals(bytes)) throw new Error('Held generated native candidate changed during host installation.');
  console.log(JSON.stringify({ initialized: true, disposable: true, enrolled: false, modelActivated: false,
    nativeAcceptance: 'required', catalog: development.catalogDigest }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await initialize();
