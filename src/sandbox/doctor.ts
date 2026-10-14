import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, readlinkSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import type { SandboxBrokerConfiguration } from './protocol.js';
import { containerdImageReference } from './image-reference.js';
import { inspectManagedDirectory } from './directory-inspection.js';

function command(path: string, args: string[], trim = true): Promise<string | null> {
 return new Promise(resolveCommand => {
  execFile(path, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
   resolveCommand(error ? null : trim ? stdout.trim() : stdout);
  });
 });
}

type NbdDeviceObservation = { device: string; threadId: number | null; processId: number | null;
 executable: string | null; image: string | null; failure: string | null };

/** Read the sole positional image, never an option's private value. Unknown
 * separate-value options remain unsupported instead of guessing their arity. */
function nbdImageArgument(args: string[]): string {
 let image: string | undefined, positionalOnly = false;
 for (let index = 1; index < args.length; index++) {
  const argument = args[index]!;
  if (!positionalOnly && argument === '--') { positionalOnly = true; continue; }
  if (!positionalOnly && argument === '--description') {
   if (++index >= args.length) throw new Error('unsupported'); continue;
  }
  if (!positionalOnly && (argument === '--fork' || argument === '--read-only'
   || /^--[a-z][a-z0-9-]*=/u.test(argument))) continue;
  if (argument.startsWith('-') || !argument || image !== undefined) throw new Error('unsupported');
  image = argument;
 }
 if (!image || /^[a-z][a-z0-9+.-]*:/iu.test(image)) throw new Error('unsupported');
 return image;
}

/** Kernel observations only; no catalog, disk content or transport is changed. */
function inspectNbdDevices(): { devices: NbdDeviceObservation[] | null; complete: boolean } {
 let names: string[];
 try {
  names = readdirSync('/sys/block').filter(name => name.startsWith('nbd')).sort();
  if (new Set(names).size !== names.length || names.some(name => !/^nbd[0-9]+$/u.test(name))) throw new Error();
 } catch { return { devices: null, complete: false }; }
 const devices: NbdDeviceObservation[] = []; let complete = true;
 for (const name of names) {
  const observation: NbdDeviceObservation = { device: '/dev/' + name, threadId: null, processId: null, executable: null, image: null, failure: null };
  devices.push(observation); let stage = 'pid';
  try {
   const raw = readFileSync('/sys/block/' + name + '/pid', 'utf8'), pid = /^([1-9][0-9]*)\n?$/u.exec(raw)?.[1];
   if (!pid || !Number.isSafeInteger(Number(pid))) throw new Error('invalid'); observation.threadId = Number(pid);
   stage = 'thread'; const status = readFileSync('/proc/' + pid + '/status', 'utf8');
   const processId = /^Tgid:[ \t]+([1-9][0-9]*)$/mu.exec(status)?.[1];
   if (!processId || !Number.isSafeInteger(Number(processId))) throw new Error('invalid'); observation.processId = Number(processId);
   stage = 'executable'; observation.executable = readlinkSync('/proc/' + processId + '/exe');
   if (!isAbsolute(observation.executable)) throw new Error('invalid');
   if (basename(observation.executable.replace(/ \(deleted\)$/u, '')) === 'qemu-nbd') {
    stage = 'image'; const commandLine = readFileSync('/proc/' + processId + '/cmdline', 'utf8');
    const args = commandLine.split('\0').slice(0, -1);
    if (!commandLine.endsWith('\0') || args.length < 2
     || args.some(argument => argument === '--image-opts' || argument.startsWith('--image-opts='))) throw new Error('unsupported');
    const image = nbdImageArgument(args);
    const cwd = isAbsolute(image) ? '/' : readlinkSync('/proc/' + processId + '/cwd');
    if (!isAbsolute(cwd) || cwd.endsWith(' (deleted)')) throw new Error('unavailable');
    observation.image = resolve(cwd, image);
   }
  } catch (failure) {
   if (stage === 'pid' && (failure as NodeJS.ErrnoException).code === 'ENOENT') continue;
   observation.failure = stage + ':' + ((failure as NodeJS.ErrnoException).code ?? 'invalid'); complete = false;
  }
 }
 return { devices, complete };
}

/** Observations only: this boundary never constructs or reconciles a sandbox runtime. */
export async function inspectSandboxInventory(configuration: SandboxBrokerConfiguration) {
 const startedAt = new Date().toISOString(), errors: string[] = [];
 const prefix = ['--address', configuration.containerdAddress, '--namespace', configuration.namespace];
 const listed = () => Promise.all(['tasks', 'containers'].map(kind => command('/usr/bin/ctr', [...prefix, kind, 'list', '--quiet'], false)));
 const [tasks, containers] = await listed();
 const nbd = inspectNbdDevices();
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
  inspectManagedDirectory(root, managedDirectory);
 } catch { errors.push('managed_directory_inventory_unavailable'); }
 const [finalTasks, finalContainers] = await listed();
 const finalNbd = inspectNbdDevices();
 if (!nbd.complete || !finalNbd.complete) errors.push('nbd_inventory_unavailable');
 if (JSON.stringify(nbd.devices) !== JSON.stringify(finalNbd.devices)) errors.push('nbd_inventory_changed');
 const sameInventory = (before: string | null | undefined, after: string | null | undefined) => validList(before) && validList(after)
  && ids(before!).sort().join('\n') === ids(after!).sort().join('\n');
 if (!sameInventory(tasks, finalTasks) || !sameInventory(containers, finalContainers))
  errors.push('containerd_inventory_changed_or_incomplete');
 return { startedAt, completedAt: new Date().toISOString(), complete: errors.length === 0,
  scope: { brokerSocket: configuration.socketPath,
   containerdAddress: configuration.containerdAddress, namespace: configuration.namespace, stateRoot: configuration.stateRoot, mountNamespace },
  tasks: tasks ?? null, containers: containers ?? null, nbdDevices: nbd.devices,
  confirmation: { tasks: finalTasks ?? null, containers: finalContainers ?? null, nbdDevices: finalNbd.devices },
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
