# Native shared-filesystem binding

Deployment owns bounded native runtime observation below its selected Kata host provider.
Agent owns pool, worker and kernel policy; native Cordis owns provider resolution/lifecycle.
This qualification connects the active QEMU filesystem selection to retained virtiofs bytes,
the actual serving process generation and its connected kernel socket. It creates no profile,
pool admission, reservation, credential or managed service during diagnostics/planning.

## Public contracts

The `/sandbox` entry exports `NativeFilesystemProjection`, `NativeFilesystemAttestation` and
`NativeFilesystemProof`. Projection `parse(qemuArgs, daemonArgs, sandboxName)` accepts only the
bounded pinned native filesystem selection. Require one `vhost-user-fs-pci` device using
`virtiofsd-chardev` and tag `kataShared`, one matching client `socket` chardev, and matching daemon
`--socket-path`/`--shared-dir` selectors. Bind paths to the owned native sandbox, never caller
paths. Reject duplicates, aliases, unsupported device/options, malformed/oversized arguments and
foreign values. Pure syntax carries no authority; other process bytes remain command-digest bound.
Support the pinned template's exact daemon argument order, cache `auto`, thread-pool size 1 and
`-o announce_submounts`; the device's queue size is 1024. Different runtime policy requires separate
qualification rather than silently widening this admission.
The frozen projection is `{ socketPath, sharedDirectory }`. Pure
`connection(unixTable, descriptorTargets, socketPath)` projects bounded Linux Unix-table text and
descriptor-link strings into the frozen socket record below. Require exactly one connected stream
row at the owned path and its inode in the serving process's descriptor targets; listening-only,
foreign, missing, duplicate or malformed matches fail. Supplied text never proves a live process.

`await NativeFilesystemAttestation.open(policy, sandboxName, signal)` requires genuine retained
`EffectiveRuntimePolicy`, native root `/`, and internally constructs `NativeRuntimeAttestation`.
Callers supply neither process observer nor accepted snapshot. Preserve previous launch/runtime
interfaces. The new admission exposes original launch `proof`, original shim `runtime`, and a
separate deeply immutable filesystem `binding`.

Require the actual selected virtiofs executable path, device/inode, size and SHA-256 for both the
shim's daemon child and its serving child. Require live root-owned stable generations, exact
parent relationships and command digests. The serving child's root must match the owned shared
directory by device/inode. Observe its actual socket descriptors and the shim network namespace's
Unix socket table; require one connected stream endpoint at the exact selected socket path.
Bind that endpoint inode and a digest of the path. This is correlation inside the trusted pinned
runtime, not a claim of security against privileged host root or an arbitrary peer-authentication API.

`NativeFilesystemProof` has kind `kata-filesystem-binding`, formatVersion 1, policyDigest,
runtimeDigest, bootDigest, immutable daemon/server `SandboxProcessIdentity`, socket
`{ inode, pathDigest, state: 'connected' }`, shared-directory `{ device, inode }` and a canonical
digest over that content. Raw argv and private paths are absent from the proof and errors.

Freshly recheck retained policy, runtime/boot/shim, process relationships, executable identity,
selected arguments, shared root and socket before/after observation and asynchronous cancellation.
`verify()` rejects changed state and destruction. Idempotent `close()` ends only this admission and
its internally owned runtime admission; it never closes borrowed custody or destroys the VM.
Fixed errors: `KATA_FILESYSTEM_INVALID`, `KATA_FILESYSTEM_CHANGED`, `KATA_FILESYSTEM_CLOSED`,
`KATA_CANCELLED`, and pure `KATA_FILESYSTEM_ARGUMENTS_INVALID`, without nested causes/private output.

## Default composition and source boundary

Add `NativePolicyCustody.filesystemLaunch`; policy-enabled default creation and inspection hold
that admission across existing observations. Owner evidence retains its existing `runtime` and
adds optional `filesystem`; its inspection digest binds both. Unconfigured mode, SDK wire and seven
global operations stay compatible. Readiness creates no VM. Every inspection is fresh; a returned
proof records an observation, not continuing liveness.

Pinned [Kata filesystem startup](https://github.com/kata-containers/kata-containers/blob/4.1.0/src/runtime-rs/crates/resource/src/share_fs/share_virtio_fs_standalone.rs)
constructs the daemon's socket/shared-directory arguments. Its
[QEMU generator](https://github.com/kata-containers/kata-containers/blob/4.1.0/src/runtime-rs/crates/hypervisor/src/qemu/cmdline_generator.rs)
connects the matching client chardev and filesystem device. Kata 4.1.0 pins virtiofsd 1.14.0.
That daemon [creates its socket before entering isolation](https://gitlab.com/virtio-fs/virtiofsd/-/blob/v1.14.0/src/main.rs)
and [forks a separate serving child](https://gitlab.com/virtio-fs/virtiofsd/-/blob/v1.14.0/src/sandbox.rs).
These support a qualification hypothesis; actual hosted default construction must prove it.

## Verification and recovery

Part of #1080 / approved Task 3D. Commit reference/plan before built missing-capability expectations,
then pure vectors, implementation and full verification. Extend the existing genuine hosted native
Cordis fixture; preserve every assertion and timeout. Require create/inspect proof, independent
genuine admission lifetime, cancellation/wrong-resource refusal, repeated/closed checks, destruction
invalidation and exact descriptor cleanup. No injected process fakes count as physical qualification.

Run checks/build/all applicable tiers, a frozen exact public archive and independent scripts-disabled
strict TypeScript + Node consumer, and both complete hosted Ubuntu 26.04 closures. Keep at most ten
files and twenty canonical method body lines, with no new dependencies/baselines/exceptions. Uncertain
owned creation/disposal requires bounded cleanup or explicit repair, never a successful capacity claim.

No workstation Kata, legacy/production change, issue closure or cutover. Complete native profile,
real pool/setup/egress, live manager/enrollment, seeds, CLI and final assembly remain Task 3D.
Productive Work/models/accounting remain Task 10; every issue stays open.
