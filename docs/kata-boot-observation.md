# Generation-bound Kata boot observation

Deployment owns the real QEMU process observer beneath its native selectable Kata host provider.
Agent receives bounded sandbox evidence; it receives no raw process or runtime control. This is
an observational invariant, not another plugin registry, admission policy or resource reservation.

The public `/sandbox` exports `QemuBootProjection`, `SandboxProcessObserver`, `SandboxBootInputs`
and `SandboxBootObservation`. `QemuBootProjection.parse(args)` interprets bounded QEMU command
arguments. `observer.boot(expected)` reads the actual generation-bound Linux process command,
verifies executable hash/owner/path, process start identity and command hash before/after parsing,
and returns a deeply immutable observation with kind `kata-boot-observation`, formatVersion1,
process identity, boot inputs and canonical digest. It creates no files or processes.

Boot inputs contain a canonical absolute kernel path, one read-only image path with byte size,
its explicit NVDIMM backend/device linkage, and finite observed startup/max CPU and memory.
The supported default Kata4.1 x64 form is one `-kernel`, no initrd/firmware boot alternative,
one `memory-backend-file` object linked by its unique id to one `nvdimm` device, `readonly=on`,
`share=off`, `prealloc=off` and `unarmed=on`. Other runtime forms require their own provider
qualification. Reject missing/duplicate kernel or root device, duplicate object fields/identities,
ambiguous linkage, mutable root image, noncanonical paths and malformed/oversized argument lists.
Unrelated runtime-generated devices and flags are retained by the complete process command digest;
interpreting selected fields does not claim that every remaining command option is safe.

`KataSandboxBackend.inspect/create` include this observation in their local evidence and inspection
digest. The existing SDK sandbox evidence remains unchanged. Every real backend inspection must
read the real process; caller-supplied command text or a fixture cannot satisfy that boundary.
Fixed errors `SANDBOX_BOOT_UNVERIFIED` and `SANDBOX_BOOT_OBSERVATION_UNVERIFIED` expose no paths,
arguments or nested exceptions. Returned values are snapshots; stale/ended/replaced process
identities fail. The existing startup-shape result remains available for compatibility.

This observation alone does not prove a retained kernel/image was used: admission must additionally
bind these paths and sizes to actual installed component/alias custody, the effective policy and
observed startup/max resources. Configured defaults and workload cgroups do not establish VM
limits. There is no host profile advertisement or warm-pool admission in this slice.

Tests first exercise a built public program using an explicitly identified harmless Node process
fixture, genuine process identity/hash/staleness boundaries, and pure argument parsing negatives.
The harmless fixture is process-observer evidence, never a Kata VM qualification. Existing hosted
Ubuntu26.04 physical acceptance exercises the real default backend and therefore this parser on
actual QEMU arguments. No workstation Kata/KVM execution, production/legacy change, CI timeout
relaxation, baseline addition or exception is authorized. All issues remain open; productive
Work/model execution remains Task10.

Pinned source reference: [Kata4.1 QEMU command generation](https://github.com/kata-containers/kata-containers/blob/ddcb1ad8d23cbb4323f86c209f132b89592902df/src/runtime-rs/crates/hypervisor/src/qemu/cmdline_generator.rs).
The source guides supported syntax; actual hosted read-back remains required evidence.
