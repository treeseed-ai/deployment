import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SandboxBrokerConfiguration } from './protocol.js';
import { containerdImageReference } from './image-reference.js';

function command(path: string, args: string[], trim = true): Promise<string | null> {
 return new Promise(resolveCommand => {
  execFile(path, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
   resolveCommand(error ? null : trim ? stdout.trim() : stdout);
  });
 });
}

/** Observations only: this boundary never constructs or reconciles a sandbox runtime. */
export async function inspectSandboxInventory(configuration: SandboxBrokerConfiguration) {
 const startedAt = new Date().toISOString(), errors: string[] = [];
 const prefix = ['--address', configuration.containerdAddress, '--namespace', configuration.namespace];
 const listed = () => Promise.all(['tasks', 'containers'].map(kind => command('/usr/bin/ctr', [...prefix, kind, 'list', '--quiet'], false)));
 const [tasks, containers] = await listed();
 const ids = (value: string) => (value.endsWith('\n') ? value.slice(0, -1) : value).split('\n');
 const validList = (value: string | null | undefined) => {
  if (value === null || value === undefined) return false;
  if (value === '') return true;
  const entries = ids(value);
  return entries.every(id => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(id)) && new Set(entries).size === entries.length;
 };
 if (!validList(tasks)) errors.push('tasks_inventory_unavailable');
 if (!validList(containers)) errors.push('containers_inventory_unavailable');
 let mountNamespace: string | null = null, mountInfo: string | null = null;
 try {
  mountNamespace = readlinkSync('/proc/1/ns/mnt');
  if (!/^mnt:\[\d+\]$/u.test(mountNamespace) || !/^mnt:\[\d+\]$/u.test(readlinkSync('/proc/self/ns/mnt'))) throw new Error();
  mountInfo = readFileSync('/proc/1/mountinfo', 'utf8');
  if (!mountInfo.trim() || !mountInfo.trimEnd().split('\n').every(line => {
   const fields = line.split(' '), separator = fields.indexOf('-');
   return separator >= 6 && fields.length >= separator + 4 && /^\d+$/u.test(fields[0] ?? '')
    && /^\d+$/u.test(fields[1] ?? '') && /^\d+:\d+$/u.test(fields[2] ?? '')
    && (fields[3]?.startsWith('/') || (fields[separator + 1] === 'nsfs'
     && /^[a-z][a-z0-9_]*:\[\d+\]$/u.test(fields[3] ?? ''))) && fields[4]?.startsWith('/');
  })) throw new Error();
 } catch { errors.push('owning_mount_inventory_unavailable'); }
 const managedDirectory: { rootPresent: boolean | null; entries: Array<{ name: string; type: 'directory' | 'file' | 'symlink' | 'other' }> } = { rootPresent: null, entries: [] };
 try {
  const root = configuration.stateRoot;
  if (resolve(root) !== root || !(root === '/var/lib/treeseed/sandboxes' || root.startsWith('/var/lib/treeseed/sandboxes/'))) throw new Error();
  // An absent leaf is meaningful only beneath canonical, accessible directory ancestors.
  const hostPath = (path: string) => `/proc/1/root${path}`;
  const owning = (path: string) => {
   const local = lstatSync(path);
   let host: ReturnType<typeof lstatSync>;
   try { host = lstatSync(hostPath(path)); } catch { throw new Error('Owning host directory observation is unavailable.'); }
   if (!Number.isSafeInteger(local.dev) || !Number.isSafeInteger(local.ino) || local.dev !== host.dev || local.ino !== host.ino) throw new Error();
   return host;
  };
  let ancestor = dirname(root);
  while (ancestor !== '/') {
   if (realpathSync(ancestor) !== ancestor || !owning(ancestor).isDirectory()) throw new Error();
   ancestor = dirname(ancestor);
  }
  try {
   const stat = owning(root);
   if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root) throw new Error();
   managedDirectory.rootPresent = true;
   managedDirectory.entries = readdirSync(hostPath(root)).sort().map(name => {
    if (!name || name === '.' || name === '..' || /[\/\0\r\n]/u.test(name)) throw new Error();
    const entry = owning(resolve(root, name));
    return { name, type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' };
   });
  } catch (error) {
   if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
   // ENOENT while enumerating a present root is an interrupted inventory, not absence.
   if (managedDirectory.rootPresent === true) throw error;
   try { lstatSync(hostPath(root)); throw new Error(); } catch (hostError) {
    if ((hostError as NodeJS.ErrnoException).code !== 'ENOENT') throw hostError;
   }
   managedDirectory.rootPresent = false;
  }
 } catch { errors.push('managed_directory_inventory_unavailable'); }
 const [finalTasks, finalContainers] = await listed();
 const sameInventory = (before: string | null | undefined, after: string | null | undefined) => validList(before) && validList(after)
  && ids(before!).sort().join('\n') === ids(after!).sort().join('\n');
 if (!sameInventory(tasks, finalTasks) || !sameInventory(containers, finalContainers))
  errors.push('containerd_inventory_changed_or_incomplete');
 return { startedAt, completedAt: new Date().toISOString(), complete: errors.length === 0,
  scope: { brokerSocket: configuration.socketPath,
   containerdAddress: configuration.containerdAddress, namespace: configuration.namespace, stateRoot: configuration.stateRoot, mountNamespace },
  tasks: tasks ?? null, containers: containers ?? null, confirmation: { tasks: finalTasks ?? null, containers: finalContainers ?? null },
  mountInfo, managedDirectory, errors };
}

function readinessCommand(path: string, args: string[]) {
	try { return execFileSync(path, args, { encoding: 'utf8', timeout: 10_000 }).trim(); }
	catch { return null; }
}


export function inspectSandboxHost(configuration: SandboxBrokerConfiguration, options: { requireBrokerSocket?: boolean } = {}) {
	const checks = {
		kvm: existsSync('/dev/kvm'), containerd: existsSync(configuration.containerdAddress),
		kataRuntime: false, trustedProviders: existsSync(configuration.trustedProvidersPath),
		modelGateway: !configuration.modelGateway || (existsSync(configuration.modelGateway.credentialFile) || existsSync(`/etc/treeseed/credentials/${configuration.modelGateway.credentialFile.split('/').at(-1)}.cred`)) && configuration.modelGateway.allowedProviders.length > 0 && configuration.modelGateway.allowedModels.length > 0,
		relay: existsSync(configuration.relay.certificateFile) && (existsSync(configuration.relay.privateKeyFile) || existsSync('/etc/treeseed/credentials/sandbox-relay-tls-key.cred')) && existsSync('/etc/cni/net.d/20-treeseed-sandboxes.conflist'),
		brokerSocket: options.requireBrokerSocket !== true || existsSync(configuration.socketPath), guestImages: configuration.guestImages.length > 0,
	};
	try { accessSync('/dev/kvm', constants.R_OK | constants.W_OK); } catch { checks.kvm = false; }
	checks.containerd = checks.containerd && readinessCommand('/usr/bin/ctr', ['--address', configuration.containerdAddress, 'version']) !== null;
	checks.kataRuntime = existsSync('/usr/local/bin/containerd-shim-kata-v2') && existsSync('/etc/kata-containers/configuration.toml');
	const readyImages = readinessCommand('/usr/bin/ctr', ['--address', configuration.containerdAddress, '--namespace', configuration.namespace, 'images', 'check', '--quiet']);
	const readyImageReferences = new Set((readyImages ?? '').split('\n').map((entry) => entry.trim()).filter(Boolean));
	checks.guestImages = checks.guestImages && configuration.guestImages.every((entry) => readyImageReferences.has(containerdImageReference(entry.image, entry.digest)));
	const version = readinessCommand('/usr/local/bin/containerd-shim-kata-v2', ['--version']);
	const kernel = existsSync('/proc/version') ? readFileSync('/proc/version', 'utf8').trim() : 'unknown';
	const ready = Object.values(checks).every(Boolean);
	return { schemaVersion: 1, ready, reason: ready ? null : 'sandbox_host_prerequisites_unavailable', checks, runtime: configuration.runtime, kataVersion: version, hostKernel: kernel };
}
