# Scoped Kata sandbox backend

Deployment owns `KataSandboxBackend`, the bounded host implementation beneath Agent's sandbox
adapter. Agent owns admission, exclusive assignment, warming/replenishment, profiles, handlers and
environment selection and setup orchestration. This backend never embeds an Agent root or supplies team authority.
SDK portable protocols remain the cross-process boundary; a process-local Context is not isolation.

The host-only public package entry is `@treeseed-cordis/deployment/sandbox`. Ordinary consumers of
the Deployment root do not load its privileged backend. The .81 successor selects the
accepted SDK .35 closure for environment/pool/service protocol integration. The .82 candidate
adds the offline guest-entrypoint mechanism specified below; service-scoped control remains
a subsequent boundary. Earlier archives and hosted qualification evidence remain immutable.
New schemas alone establish no runtime or authority proof.

## Interface and custody

The backend accepts a trusted host configuration for an already prepared private containerd
endpoint, its process identity, a pinned Kata runtime and one digest-pinned native linux/amd64
image. It exposes `create`, `inspect`, `assign`, `execute` and `destroy` for caller-named owned sandbox identities.
The first privileged backend requires a root-owned private runtime hierarchy with trusted
root-owned ancestors. The hosted fixture uses `/run`; it must not weaken ownership checks to
traverse the unprivileged runner's home. Final installation custody and named service grants
remain a separate integration boundary.
There is no arbitrary command, host path, image pull or raw-socket operation in that interface.
Native host composition supplies the backend; the eventual service-scoped socket grants only its
bounded operations and is distinct from the read-only observer socket.

`KataSandboxPlugin` provides the typed `KataSandboxToken` in the privileged Deployment host
composition. Its native declaration, configuration schema and package export come from the same
class. It owns the backend resource through Cordis disposal; `ready()` validates and opens that
resource, and methods use that same lifetime. Restart is required for replacement. Registering the
plugin does not start a VM or make a healthy-capacity claim; only successful sandbox inspection
supplies that evidence. Agent worker scopes receive the bounded client, not this host configuration.

`create` records intent before allocating an owned container and starts a fixed harmless sleeper
using `io.containerd.kata.v2`. A successful read-back must find the exact expected runtime, image,
labels and running task and execute the fixed guest-kernel inspection inside that guest. Its kernel
must match the qualified runtime's expected guest kernel and differ from the host. Unexpected
guest output is rejected rather than included in an inspection receipt. No inspection or warm flag can turn an ordinary container into a Kata
base. Used guest admission and assignment remain Agent/host-control policy above this layer.

The runtime namespace and physical resource name derive from trusted installation/service/provider
scope plus the logical sandbox ID. Caller strings never become paths or select arbitrary runtime
resources. Private durable intent and completion records bind the exact configuration and resource
identity. Unknown, mismatched or partially initialized state requires explicit repair rather than
adoption. Failed creation retains enough exact owned identity for bounded cleanup; it cannot grant
permission to delete foreign containers. A destruction success requires task, container and active
snapshot absence, followed by durable read-back. Image content may remain shared within the private
prepared runtime. Assigned guests are destroyed, never returned to the virgin pool.

Runtime-object absence is not sufficient proof of VM teardown. Qualification must additionally bind
the exact owned QEMU process to the pinned hypervisor executable and stable Linux process start
identity, and verify that process is gone before publishing destruction. The observer matches only
the runtime's exact sandbox name; it never kills a PID discovered by a broad search. Normal removal
continues through the bounded runtime operation. Unexpected or still-running processes require
failure and explicit recovery. Kata's pinned
[QEMU command construction](https://github.com/kata-containers/kata-containers/blob/4.1.0/src/runtime-rs/crates/hypervisor/src/qemu/cmdline_generator.rs)
supplies the sandbox-name binding; the actual process/cleanup check still needs executable proof.

Subprocesses use argument arrays, a pinned client executable, bounded time/output and cancellation.
Unknown command errors and guest output do not become public blockers. Every operation revalidates
private endpoint/process and resource identities. Ambient lifecycle scripts and Agent handlers
are never run by this host backend. Its optional workload configuration admits only exact
setup/verification entrypoints inside owned guests, with Agent retaining authorization and
sequence ownership. The separate guest runner remains an independent Agent process/root.

## Qualification and limits

The actual default backend must pass on trusted GitHub-hosted Ubuntu 26.04 x64 with real KVM and
Kata 4.1. The test prepares a separate daemon root/state/socket/namespace and a digest-pinned image;
it does not change the system daemon or a legacy installation. Local ordinary CI exercises rejection
and collaborator contracts and must not pretend that injected command fixtures prove virtualization.
Full Agent pool, private socket grants, installed service supervision, enrollment and seed integration
remain separate required gates. Real Work/model execution remains Task 10. All issues remain open.

Command semantics are checked against the pinned containerd sources for
[detached run](https://github.com/containerd/containerd/blob/v2.4.1/cmd/ctr/commands/run/run.go) and
[task exec](https://github.com/containerd/containerd/blob/v2.4.1/cmd/ctr/commands/tasks/exec.go).
Platform #792 records the already verified hosted venue and immutable Kata fixture. Backend
qualification must exercise its own production constructor rather than copying that fixture's
implementation into a second runtime owner.

## Bounded guest entrypoint execution

The bounded privileged execution contract adds `assign(id, assignmentId, environmentId, signal)` and
`execute(id, phase, signal)` to the host sandbox contract. Configuration selects an immutable
environment definition, a private exact NPM archive and an owner-private workload
journal beneath the same custody root. Worker callers choose only already admitted IDs and setup/verification phases; no
arbitrary host path, image, command, environment variable or raw runtime socket is accepted.

Deployment verifies package name/version/archive hash and regular entrypoint path/hash/size/
executable mode without extraction or imports. Scripts are staged only into the already-owned
Kata guest and invoked there through the pinned containerd client. Argument arrays, bounded
stdin/time/combined output and cancellation apply. Script stdout/stderr never enter public
receipts or errors. This is a TreeSeed workload sequence, not Kata guest-agent hooks. The
[pinned ctr exec source](https://github.com/containerd/containerd/blob/v2.4.1/cmd/ctr/commands/tasks/exec.go)
and [Kata hook scope](https://github.com/kata-containers/kata-containers/blob/4.1.0/docs/design/hooks-handling.md)
are mechanism references; real guest acceptance remains mandatory.

The optional `workloads` configuration contains a private archive directory and exact archive/
environment selections. Its generated positive configuration projection derives from SDK fields,
restricts network to offline, and revalidates full SDK semantics before opening host custody.
Enabled custody uses receipt format 2 and a closed `workloads` directory; existing configurations
without workloads retain format 1. Each immutable journal record binds configuration, request and
content digests, with private atomic publication and read-back. Pending intents require repair.

Assignment is one-use and durable before execution. Setup must complete before verification.
Exact repeated phase requests freshly verify runtime/artifacts and read a matching complete
receipt without rerunning scripts. An interrupted or uncertain phase requires explicit repair;
failed phases cannot advance. Never-assigned bases alone are pool eligible, and every assigned
sandbox is destroyed with the existing verified QEMU/task/container/snapshot teardown.

The first execution slice supports offline environments only and verifies a guest with only
the loopback interface before each entrypoint. Declared allow-list environments block until
the separate network enforcement contribution is qualified. This is not completion of Task
3D egress, service-grant transport, runner readiness, live authority, pool policy or assembly.
Agent retains those orchestration/authority responsibilities; this host API supplies only the
bounded guest mechanism and owned evidence. Worker replacement remains restart-only.

Acceptance must use genuine archived setup/verification fixtures in a real hosted Kata guest,
prove setup precedes verification, repeated requests do not rerun, failed/cancelled entries
cannot advance, unsafe archives and wrong image/network selections block, output/host-script
canaries stay absent, and assigned VM teardown is verified. Ordinary workstation tests may
exercise denial and pure archive/custody boundaries only; never start the venue implicitly.

## Opt-in bounded workload resource shape

The next host-only `resources` configuration selects integer `vcpus`, `memoryMiB` and
`scratchMiB` using SDK `PoolSchemas.resources`. It is positive, immutable trusted host
configuration; a worker can neither change it nor provide runtime flags or mount paths.
An absent shape preserves the preceding configuration and does not advertise pool compatibility.

The native backend translates this shape into OCI CPU quota, memory limit, a read-only image
root and fixed guest-local tmpfs mounts. `/tmp` is the declared workload scratch limit; `/run`
has a separate 64 MiB control budget and `/opt` a separate 256 MiB executable budget. The
latter accommodates the already qualified 110 MiB guest artifact. These explicit fixed control
budgets are additional to scratch and are charged against guest workload memory. They are not
unbounded disk, host bind mounts or arbitrary worker-selected paths. Default runtime-managed
mounts such as `/dev/shm` remain separately bounded by the pinned OCI runtime; this slice does
not advertise an aggregate writable-storage quota.

`vcpus` is the workload CPU quota and `memoryMiB` the workload cgroup limit, not a claim that
QEMU has exactly that many CPUs or RAM bytes: Kata's pinned runtime allocates VM overhead.
An explicit fixed read-only `cgroup` mount at `/sys/fs/cgroup` exposes the current guest
container's controller limits; it adds no host bind path or worker-selected option. Kata 4.1
mounts this as cgroup2 in unified mode. Inspection verifies its actual cgroup2 type and read-only
flags as well as both the saved OCI spec and the actual guest CPU/memory limits,
read-only root and scratch filesystem type/capacity. Wrong, missing or ambiguous evidence fails
with a fixed `KATA_RESOURCE_SHAPE_MISMATCH` error before returning a successful receipt. Guest
output is private. The exact shape joins the inspection digest and is returned as `resources`
only when configured and verified. No SDK `SandboxResourceProfile` is advertised by this slice;
full runtime provenance/isolation/generation binding remains required before pool admission.

Implementation sequence for #1021: commit this interface → built public configuration and real
hosted boundary acceptance → pure policy cases → immutable positive configuration/argument
translation and fresh read-back → checks/build/all lower tiers/public archive and complete
hosted acceptance. Preserve every existing case, deadline and archive. Real acceptance constructs
the default native provider on isolated hosted Ubuntu 26.04/KVM, observes exact limits, proves
scratch exhaustion and read-only root, then verifies physical task/container/snapshot/QEMU
teardown. Ordinary workstation verification runs only pure policy and built input rejection.

The [pinned Kata configuration template](https://github.com/kata-containers/kata-containers/blob/4.1.0/src/runtime-rs/config/configuration-qemu-runtime-rs.toml.in)
describes runtime overhead, and its [volume dispatch](https://github.com/kata-containers/kata-containers/blob/4.1.0/src/runtime-rs/crates/resource/src/volume/mod.rs)
distinguishes ordinary OCI tmpfs mounts from special Kubernetes ephemeral volumes. Those sources
inform the bounded implementation; actual guest qualification decides whether it is accepted.
Work/models remain Task 10, existing services remain untouched and every issue remains open.

The .108 hosted prototype correctly refused a guest whose scratch/root constraints matched but
whose CPU/memory files were absent. The retained read-back has membership `0::/`, expected tmpfs
sizes and read-only root. Containerd v2.4.2 [default mounts](https://github.com/containerd/containerd/blob/v2.4.2/pkg/oci/mounts.go)
include no cgroup filesystem. The corrected .109 positive policy therefore explicitly requests
the fixed read-only cgroup mount. Kata's pinned [mount handling](https://github.com/kata-containers/kata-containers/blob/4.1.0/src/agent/rustjail/src/mount.rs)
maps `cgroup` to cgroup2 in unified mode and remounts read-only when requested. This is the next
configuration to qualify, not an inference that flags alone prove enforcement. Keep .108 and
both failed hosted records immutable; no CPU/memory read-back requirement or deadline is removed.
