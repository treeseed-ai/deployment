# Bounded effective Kata runtime policy

Deployment owns this read-only custody invariant beneath its selectable native Kata host provider.
Agent receives bounded sandbox contracts, never runtime paths or raw daemon access. Native Cordis
owns provider resolution/lifecycle; descriptor custody is not another dependency container.

`@treeseed-cordis/deployment/sandbox` exports `EffectiveRuntimePolicy` and its immutable proof type.
`await EffectiveRuntimePolicy.open(input, components, aliases, signal)` borrows real open component
and alias custody. Input contains an exact `{path, sha256}` owner-prepared configuration plus
`resources` using the SDK workload resource shape. The capability owns only the effective file and
its parent descriptor. It never writes configuration, extracts archives, imports plugins, runs
scripts, starts processes or advertises a host profile. `verify()` checks all retained inputs;
`close()` releases only owned descriptors, drains failures and remains failed after bad disposal.

The selected component role `configuration` is the exact upstream template retained from the kit.
Read it through its original retained binding, verify its member digest and bounded bytes, and
compare its entire parsed document with the effective configuration. The default policy qualifies
the official Kata4.1.0 x64 kit, SHA256
`3dc6b69c4acb787b967b04b64599a20d02a8beb1a8eaab3084110df9d0b08c96`, size969565384,
and its runtime-rs QEMU template SHA256
`870f8157d298a51784d3617854456edf16820bbc1e743b15467e441b63c43673`.
Alternative runtime policies require an explicitly selected provider and their own qualification;
changing a caller-supplied digest cannot relabel an unqualified kit as the default policy.

Only these effective `hypervisor.qemu` fields may differ from that template:

- `default_vcpus` and `default_maxvcpus`: the same finite integer ceiling of requested workload
  vCPUs plus the template's declared CPU overhead.
- `default_memory` and `default_maxmemory`: the same finite workload MiB plus declared overhead.
- `memory_slots`: one; no unbounded zero sentinel or additional hotplug capacity.
- `enable_annotations`: empty; callers cannot override runtime policy through annotations.

All other fields, nested tables, lists and scalar types must agree semantically with the complete
accepted template. Unknown/duplicate keys, added/removed values, unsupported TOML values, changed
paths/hooks/network/debug/security settings or arbitrary environment configuration fail. Require
static resource management and positive finite exact workload/VM bounds. Scratch size remains the
existing workload policy's bounded tmpfs contract; this proof alone does not verify a mounted tmpfs.
The complete effective byte digest remains part of the proof even when comments/formatting differ.

The immutable proof records kind `kata-effective-runtime-policy`, formatVersion1, kit and template
identities, effective configuration digest/size, installation root, component and alias identities,
workload resources and finite VM startup/max resources, plus its canonical digest. Freeze nested
objects/arrays. No timestamps, live resource reservations or caller mutable objects participate.
Safe errors use fixed `KATA_RUNTIME_POLICY_INVALID`, `KATA_RUNTIME_POLICY_CHANGED`,
`KATA_RUNTIME_POLICY_CLOSED`, `KATA_RUNTIME_POLICY_CLOSE_FAILED` or `KATA_CANCELLED`, never private
paths, TOML values or nested exceptions. Private effective files must be current-owner0600,
regular/single-link, descriptor anchored and no-follow; retain file/parent identities through
lifetime. Cancellation or uncertain paths fail without repair/adoption or filesystem mutation.

Require real component/alias custody, one consistent kit identity, canonical bounded paths and
plain bounded input before asynchronous work. Snapshot trusted selections before yielding. Every
verification rechecks borrowed custody and the effective descriptor. A withdrawn/reused owned
file descriptor must not cause unrelated descriptors to be closed. Close policy before aliases,
components and their archive. Relocated inert fixtures remain interpretation/custody evidence;
production launch qualification additionally requires the actual configuration paths to resolve to
those exact retained installed members. This document does not qualify arbitrary relocations.

The upstream runtime-rs sizing rules provide the expected test hypothesis, not an observation of
a running VM: [Kata4.1 sizing](https://github.com/kata-containers/kata-containers/blob/4.1.0/docs/how-to/how-to-size-sandbox-overhead-runtime-rs.md)
and [the exact template](https://github.com/kata-containers/kata-containers/blob/4.1.0/src/runtime-rs/config/configuration-qemu-runtime-rs.toml.in).
Actual QEMU executable/kernel/rootfs arguments, process generation and finite startup/max resources
must be independently bound and read back before the native host advertises an SDK profile or
admits a warm sandbox. Workload cgroups and configuration defaults do not establish that result.

Under #1063: contract documentation; accepted #1062 parent sync; outside-in built/default-custody
and real filesystem/semantic-negative tests; concise class implementation; owner checks/build/all
tiers, independent exact archive consumer and hosted qualification. Split later actual-launch,
profile-advertisement and Agent-pool integration into their own bounded owner slices. No baseline
or exception additions, legacy changes or production publication. All issues remain open. Real
Work/model execution remains Task10.
