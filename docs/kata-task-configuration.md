# Native Kata configuration selection

Deployment owns configuration selection beneath `KataSandboxPlugin` and its bounded host interface.
Worker plugins receive scoped operations, never configuration paths, daemon sockets or raw options.
Selection creates no process by itself; explicit sandbox creation remains the activating operation.

The public `/sandbox` configuration adds `runtime.configurationMode`:

| Mode | Daemon prerequisite | Owned task creation | Read-back |
| --- | --- | --- | --- |
| `environment` (default) | Exactly the selected `KATA_CONF_FILE` binding | Existing fixed runtime arguments | No runtime-option override |
| `task-options` | `KATA_CONF_FILE` must be absent | Fixed `--runtime-config-path` plus the selected pinned path | Exact `runtimeoptions.v1.Options` containing only that configuration path |

An empty or different environment binding still masks task options and must fail. Reject unknown
modes. Keep selected-file ownership, executable identity, daemon/socket identity and configuration
hash checks. Recheck the environment before each operation. Inspect persisted container runtime
options on every resource read-back; reject missing, foreign, extra, malformed or changed values.
Use fixed safe errors without including private paths, environment or configuration bytes.

The task option is a trusted host-operator interface. It is never derived from pod annotations,
worker requests or plugin-supplied command arguments. The pinned Kata loader deliberately restricts
the environment variable to shipped paths; retain that restriction. Do not rewrite installed kit
files, global configuration or daemon environment in place. Provision a dedicated owner daemon
without the environment override before selecting task-options mode.

The selection helper binds a pinned file and the containerd selection edge. It does not replace
complete `EffectiveRuntimePolicy`, component/alias custody or actual launch attestation. The host
must retain that custody before its owned launch. Native profile/pool admission remains a separate
integration gate; a schema or stored option alone proves no VM health or workload authority.

## Verification boundary

Begin with built public mode/default/invalid-input checks, then a hosted Ubuntu 26.04 fixture that
holds the actual installed kit, aliases and complete private effective policy before creation.
Start only its dedicated daemon with the environment override absent. The actual default backend
must create one harmless sandbox, read back the exact task option and observe three vCPUs,
1056 MiB startup RAM and 1312 MiB maximum address space for the selected workload. Inspect a second
time, then verify destruction and retain no assigned sandbox. A masked-mode attempt must fail
before resource creation. Successful output follows all cleanup; cleanup failure cannot pass.

Local tests inspect inert data and build/program boundaries only. No local QEMU/Kata invocation or
spoofed hosted qualification. Preserve all existing environment-mode cases, deadlines and assertions.
Permanent specifications remain in the four test tiers. Keep every issue open; Work/models and
productive handlers/accounting remain Task 10. This slice does not publish a native profile,
activate an Agent pool or complete seeds, live enrollment or final assembly.

## Upstream contracts

- [Pinned Kata loader](https://github.com/kata-containers/kata-containers/blob/ddcb1ad8d23cbb4323f86c209f132b89592902df/src/runtime-rs/crates/runtimes/src/manager.rs): environment precedence, shipped-path admission and trusted task options.
- [Kata containerd guide](https://github.com/kata-containers/kata-containers/blob/ddcb1ad8d23cbb4323f86c209f132b89592902df/docs/how-to/containerd-kata.md): explicit `ctr --runtime-config-path` usage.
- [containerd 2.4.2 runtime options](https://github.com/containerd/containerd/blob/v2.4.2/cmd/ctr/commands/commands_unix.go): `ConfigPath` construction.
- [Option wire contract](https://github.com/containerd/containerd/blob/v2.4.2/api/types/runtimeoptions/v1/api.proto): configuration path is protobuf field 2; type and body remain unset.
- [Container metadata read-back](https://github.com/containerd/containerd/blob/v2.4.2/cmd/ctr/commands/containers/containers.go): persisted runtime information accompanies the decoded OCI specification.
