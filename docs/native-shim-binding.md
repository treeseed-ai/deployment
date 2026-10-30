# Active native Kata shim binding

Deployment owns this process invariant below the selected native host provider. Agent retains
pool/kernel policy; native Cordis retains provider resolution and lifecycle. The retained runtime
kit and policy prove selected bytes. Before a complete profile is advertised, the active native
process chain must also agree with those selected bytes.

The pinned [Kata QEMU implementation](https://github.com/kata-containers/kata-containers/blob/4.1.0/src/runtime-rs/crates/hypervisor/src/qemu/inner.rs#L377-L424)
spawns the configured hypervisor as a child. Its
[shim argument parser](https://github.com/kata-containers/kata-containers/blob/4.1.0/src/runtime-rs/crates/shim/src/bin/main.rs#L44-L61)
binds `id` and `namespace` using Go-compatible flags. This supports the implementation hypothesis;
the actual parent relationship still requires hosted default-construction qualification.

## Owner interfaces

The public `/sandbox` exports `NativeShimProjection`, `NativeRuntimeAttestation` and
`NativeRuntimeProof`. The pure projection's `parse(args, sandboxName)` requires the bounded pinned
single-hyphen, separate-value `-id` and `-namespace` selectors exactly once. The sandbox name is
the host-owned `cordis-sandbox-<24 hex scope>-<24 hex record>` name; its namespace is the prefix
without the last record segment. Reject foreign values, duplicate selectors, equals/double-hyphen
aliases, option terminators, malformed/oversized arguments and invalid names. Other argument bytes
remain bound by the observed complete command digest. Syntax projection alone creates no authority.

`await NativeRuntimeAttestation.open(policy, sandboxName, signal)` requires genuine live retained
`EffectiveRuntimePolicy` and internally constructs the real `KataLaunchAttestation` and shim
observer. Callers cannot supply a fake process observer or boot snapshot. Require native root `/`.

Read the actual attested QEMU's parent PID and start identity. Require a live root-owned parent,
stable parent/child identities, parent start no later than child start, and exact retained shim
executable canonical path, device/inode, size and SHA-256. Validate the parent command's sandbox
and namespace against the owned resource name. Recheck policy, QEMU, shim and parent relationship
before/after interpretation and across the asynchronous cancellation boundary.

`proof` remains the original deeply immutable `KataLaunchProof`. `binding` is a separate immutable
record with kind `kata-runtime-binding`, formatVersion 1, policyDigest, bootDigest, sandboxName,
namespace, the observed shim `SandboxProcessIdentity` and a canonical digest over that content.
Every nested shim identity is frozen. `verify()` freshly rechecks both generations and custody;
destruction, parent death/reuse/reparenting or changed executable/arguments/policy fails.

`close()` is idempotent and closes only this admission and its internally owned launch attestation.
It never closes borrowed policy, component/alias/archive custody or the VM. Fixed errors are
`KATA_RUNTIME_INVALID`, `KATA_RUNTIME_CHANGED`, `KATA_RUNTIME_CLOSED`, `KATA_CANCELLED` and pure
`KATA_SHIM_ARGUMENTS_INVALID`, without private paths, raw command arguments or nested causes.

## Default host integration

Preserve existing `KataLaunchAttestation` and `NativePolicyCustody.launch`. Add
`NativePolicyCustody.runtimeLaunch` to borrow its private real policy for the composite admission.
Policy-enabled default creation and inspection use that path. Keep the composite open through
network qualification and observation, then freshly verify before accepting evidence or staging
the runner. Native `KataSandboxEvidence` adds optional owner `runtime` binding only in policy mode;
its inspection digest includes that binding. Existing unconfigured mode and SDK wire stay unchanged.

Readiness creates no VM. This proof qualifies the active shim edge, not the virtiofs process/socket
edge, a full resource profile, resource reservation or security against trusted host root. Full
runtime/profile qualification and actual pool admission remain separate requirements.

## Verification and recovery

Part of #1078 and the approved Task 3D architecture, based on accepted network/custody commit
`fdac6105307a8cc3bdf7e4126004f63e04dcb068`. Owner docs/plan precede outside-in tests and implementation.
The built public missing-capability case must fail first. Pure argv cases cover missing, duplicate,
foreign and alternate selectors, invalid names/bytes and private-output canaries.

Hosted Ubuntu 26.04 uses the real default native Cordis host. Require matching active retained shim
evidence on create/inspect. A standalone genuine attestation must freshly verify, reject cancellation
and a different resource name, close without affecting borrowed policy or the VM, and refuse verify
after close. Preserve every existing network/resource/custody/tamper/restoration/destruction/FD check.

Run normal checks/build, all applicable tiers, an independent strict exact public archive consumer
and both complete hosted closures. Keep changed methods within twenty canonical lines and at most
ten files; retain existing assertions/timeouts and immutable prior artifacts. Uncertain creation or
disposal cannot report success; bounded cleanup/explicit repair remains required.

No workstation Kata/QEMU, production/legacy changes, new identity authority, issue closure or cutover.
Actual pool/setup/egress, live manager/enrollment, seeds, CLI and final assembly remain Task 3D;
productive Work/models/accounting remain Task 10.
