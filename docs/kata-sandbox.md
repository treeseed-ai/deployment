# Scoped Kata sandbox backend

Deployment owns `KataSandboxBackend`, the bounded host implementation beneath Agent's sandbox
adapter. Agent owns admission, exclusive assignment, warming/replenishment, profiles, handlers and
guest environment execution. This backend never embeds an Agent root or supplies team authority.
SDK portable protocols remain the cross-process boundary; a process-local Context is not isolation.

The host-only public package entry is `@treeseed-cordis/deployment/sandbox`. Ordinary consumers of
the Deployment root do not need to load its privileged backend. Review candidate `.80` keeps the
existing SDK `.16` baseline; the separate `.79` compatibility PR adopts SDK `.19`. Their eventual
assembled successor must record a new exact archive rather than overwriting either candidate.

## Interface and custody

The backend accepts a trusted host configuration for an already prepared private containerd
endpoint, its process identity, a pinned Kata runtime and one digest-pinned native linux/amd64
image. It exposes `create`, `inspect` and `destroy` for caller-named owned sandbox identities.
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
private endpoint/process and resource identities. Lifecycle scripts, environment setup and handlers
are never run by this host backend. Setup will use the separate qualified guest-runner boundary.

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
