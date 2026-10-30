# Retained policy and native Kata launch binding

Deployment owns this read-only invariant beneath its selected native Kata host provider. Native
Cordis still owns provider selection and lifecycle; Agent receives bounded sandbox records, never
raw runtime paths, process access or daemon sockets. This helper is not another registry or a
security boundary against trusted code/root in its own host process.

The public `/sandbox` exports `KataLaunchAttestation` and `KataLaunchProof`.
`await KataLaunchAttestation.open(policy, sandboxName, signal)` borrows a genuine open
`EffectiveRuntimePolicy`, requires its native installation root `/`, and internally constructs the
production process observer from its retained hypervisor binding. It observes the actual named
process rather than accepting a caller's boot snapshot. The host owner must retain policy and
component/alias custody before launching its owned sandbox; the helper cannot retroactively prove
what a caller allowed before taking custody. The production integration and its tests must obey
that ordering.
Use the backend's `sandbox-<UUID>` record ID for creation/destruction. Pass the distinct returned
runtime `resourceName` to attestation; the backend derives it from scope and record identity.

Require the actual executable's canonical `/proc/<pid>/exe` path and device/inode to match the
retained installed hypervisor; the observer verifies its owner/hash, start identity and complete
command digest. Bind the observed kernel/root-image arguments to the exact retained terminal or
declared alias paths; require the image byte size to agree. Validate the actual unique QEMU
`-machine` selection as q35 with KVM and NVDIMM enabled, rejecting alternate/duplicate machine or
accelerator switches. The admitted native command uses canonical single-hyphen options; reject
double-hyphen aliases anywhere in its argument vector so a second machine, accelerator or boot
selection cannot evade the bounded projections. QEMU's
[option lookup](https://github.com/qemu/qemu/blob/v10.2.0/system/vl.c#L1545-L1579)
accepts both spellings, so checking only literal single-hyphen duplicates is insufficient.
Require observed CPU/startup/max memory to equal the complete image-aware
policy. The image-backed allowance is separate from ordinary RAM. This qualifies selected native
boot inputs, not arbitrary extra command options or a hostile privileged host.

Recheck policy and the same process generation before/after interpretation and after an async
cancellation boundary. The proof is deeply immutable: kind `kata-launch-binding`, formatVersion1,
policy digest, actual boot observation, native machine/accelerator and a canonical digest. Timestamps
and resource reservations are absent. `verify()` freshly rechecks borrowed custody, executable and
boot/process identity; destruction, changed policy, ended/reused process or uncertain inspection
fails. `close()` is idempotent and closes only the attestation's admission, never borrowed custody
or the running sandbox. It remains possible to close after destruction. Dispose attestations before
policy/aliases/components/archive.

Use fixed `KATA_LAUNCH_INVALID`, `KATA_LAUNCH_CHANGED`, `KATA_LAUNCH_CLOSED` or `KATA_CANCELLED`
errors without private paths, raw arguments or nested causes. Invalid/cancelled inputs create no
files, processes, credentials or store state. An attestation never starts/stops a sandbox and never
advertises a native profile or claims an ended VM healthy.

Outside-in verification begins with built public capability detection and malformed admission,
then real retained relocated-kit/closed/cancelled policy boundaries. Relocated inert fixtures must
not qualify native launch. Hosted Ubuntu26.04 tests retain the genuine installed kit, derive a
private exact effective configuration, then use the real default backend to start one harmless
sandbox. Read back retained executable/kernel/image, three finite vCPUs,1056MiB ordinary RAM and
1312MiB maximum address space. Repeated proof agrees, cancellation refuses admission and verified
destruction invalidates read-back. Local tests never run QEMU/Kata or spoof qualification flags.
Also construct a second genuine native policy with different finite RAM bounds and require it to
reject the same running process. Validate its distinct policy identity before the attempt, so
relocated, forged or otherwise invalid custody cannot mask a missing resource comparison.
The pinned Kata loader refuses private configuration paths selected through `KATA_CONF_FILE`.
[The accepted task-option selection](https://github.com/treeseed-ai/deployment/pull/1072)
provides its supported operator boundary at `400e5339e447d28944ea6ee70ef98979326a7ccd`.
The launch candidate consumes that accepted baseline; its own fresh finite launch must still
qualify. A rejected configuration is not evidence about VM resource limits.

The native launch fixture uses that owner's shared installed-policy fixture and explicitly selects
`task-options` on its dedicated daemon. Its `KATA_CONF_FILE` override must be absent; retain the
selected private file and all installed component/alias descriptors before creating the task.
Do not duplicate the policy constructor or reintroduce temporary daemon/command tracing. Keep
the independent configuration-selection scenario and every attestation assertion: repeated proof,
alternate genuine policy rejection, cancellation, close semantics and invalidation on destruction.
Only fresh hosted execution of the reconciled owner head can qualify this launch path.

Actual provider/profile publication, pool ownership/claims/refill, setup/egress, live authority,
seed coordination, CLI and final assembled admission remain subsequent Task3D gates. Real
Work/model execution remains Task10. Keep all issues open and retain immutable prior artifacts.

References: [exact Kata QEMU generation](https://github.com/kata-containers/kata-containers/blob/ddcb1ad8d23cbb4323f86c209f132b89592902df/src/runtime-rs/crates/hypervisor/src/qemu/cmdline_generator.rs),
[QEMU NVDIMM address space](https://gitlab.com/qemu-project/qemu/-/blob/v10.2.0/docs/nvdimm.txt),
[effective policy](runtime-policy-custody.md) and [boot observation](kata-boot-observation.md).
