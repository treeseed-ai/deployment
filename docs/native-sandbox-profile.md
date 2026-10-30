# Qualified native sandbox profiles

Deployment owns runtime/sandbox qualification; Agent owns pool policy and worker/kernel admission.
SDK owns `SandboxResourceProfile`, its canonical revision and compatibility validation. Native Cordis
owns selected provider resolution/lifecycle. The host profile is qualified metadata, not a service
registry, resource reservation, active VM health claim or permission to execute an assignment.

Part of #1083 / approved Task 3D. Implementation requires accepted physical filesystem qualification
from #1080. This reference describes the next contract; it does not mark that prerequisite complete.

## Owner interface and qualification

Extend `KataSandboxHost` with optional
`profile(): Promise<SandboxResourceProfile | null>`. The default `KataSandboxPlugin` implements it.
Providers without the method remain compatible and cannot satisfy profile-requiring pool admission.
An invalid supplied method is a provider-contract failure. SDK/global platform operations and existing
unconfigured native behavior remain compatible.

`ready()`, profile read-back, doctor and platform planning create no VM. A newly constructed host has
no qualified profile. An explicit owned native create qualifies only after genuine retained policy,
actual boot/shim/filesystem, exact image selection, offline network and enforced workload resources
pass. Never accept a caller's readiness, process snapshot or raw profile as qualification authority.

Retain a private metadata witness of that successful owner operation, without retaining a closed
attestation as liveness or adding another artifact/service lifecycle owner. Freshly verify current
custody, endpoint/daemon, provider generation and image prerequisites before returning the profile.
Every subsequent create/inspect still physically attests. Failed/changed authority or uncertain
cleanup cannot produce a successful qualified read-back; explicit recovery remains required.
Starting a new explicit creation clears the previous witness until qualification succeeds. Failed
destruction or disposal clears it; verified destruction retains the demonstrated capability.
Generation mismatch returns `KATA_PROFILE_CHANGED`; incomplete physical evidence returns
`KATA_PROFILE_INVALID`. Existing custody/runtime errors remain fixed and safe.

Read-back validates and returns independent SDK data, so caller mutation cannot change retained
qualification. A verified destroyed qualification VM does not erase demonstrated capability, nor
does it imply another VM exists. Reconstructing the owner starts unqualified; do not silently adopt
old uncertain state or persist fabricated qualification in its journal.

## Content and generation

Derive the SDK content from the owner's enforced selections:

- `schemaVersion: treeseed.sandbox-profile/v1`, owner-derived logical scope identity and SDK revision.
- Runtime `kata`, pinned version `4.1.0` and the genuinely retained archive digest.
- The exact selected native `linux/amd64` manifest and immutable image reference.
- Enforced workload vCPU, memory and scratch limits; these describe workload bounds, not VM overhead
  or host-resource reservations. Pool warming observes actual successful native allocations.
- Network `{ mode: offline, destinations: [] }`; do not advertise unqualified allow-list egress.
- An isolation-policy digest binding exact policy/kit and relevant owner/provider/daemon/endpoint
  generation. No timestamp, sampled free capacity, QEMU PID or one sandbox's boot/socket inode goes
  into compatibility content. Same-generation virgin bases produce the same profile revision.

The metadata witness may bind the actual qualification boot/runtime/filesystem observations for
owner verification, while the profile remains stable across same-policy bases and verified cleanup.
Changed prerequisites fence read-back; a new generation must qualify explicitly. Worker/sandbox
replacement remains restart-required until its transition is qualified.

## Image selection edge

The selected manifest's existence is insufficient if the image name points elsewhere. Verify the
actual containerd image-name-to-target edge before native creation/read-back. Public pure
`NativeImageTargetProjection.parse(table, reference)` projects the bounded pinned `ctr images list`
table to frozen `{ reference, manifestDigest, mediaType }`; it establishes no authority by itself.
Require one exact reference, a native image manifest media type and the digest embedded in that
reference. Reject missing/duplicate/foreign/mutable/unsupported records and malformed/oversized data.
Other shared image rows may remain present; they do not qualify the selected image. Admit only its
exact row, with an OCI image manifest or Docker schema-2 image manifest target. Parse the first three
stable columns; human-readable size/labels do not establish identity or architecture. Bound input
to one MiB and 16,384 rows, reject NULs and malformed headers, and return fixed
`KATA_IMAGE_TARGET_INVALID` errors without private input. Existing content/config checks establish
the native architecture. The accepted filesystem prerequisite is `cordis`
`366709a04a994a1825c878376acb369089bd5a0f`.
The projected `manifestDigest` is the SDK's 64-character hexadecimal digest, without `sha256:`;
the actual image-store column must still equal the full `sha256:<hex>` target. Test that projection
directly with SDK profile creation/read-back before hosted physical qualification.
The existing content hash and config architecture checks still apply.

Pinned [containerd list output](https://github.com/containerd/containerd/blob/v2.4.2/cmd/ctr/commands/images/images.go#L63-L148)
reads the image store and prints its actual name, target media type and target digest. Its
[inspect command](https://github.com/containerd/containerd/blob/v2.4.2/cmd/ctr/commands/images/inspect.go)
renders an image tree; do not assume an undocumented raw JSON image-record interface.

## Private transport and Agent boundary

Forward a qualified profile through the existing optional SDK `SandboxAvailability.profile` in a
subsequent bounded control-transport slice. Do not turn `state: available` on the bounded host
interface into a claim that the Agent manager/worker pool is ready. Agent explicitly warms a virgin
candidate, obtains current owner metadata, verifies exact SDK compatibility, and refuses/destroys
mismatches before pool admission. Assigned sandboxes are destroyed and never recycled.

## Verification

Commit owner documentation and outside-in built/default-host expectations before implementation.
Hosted Ubuntu 26.04 must prove null before explicit create, real qualification after create, stable
repeat/verified destruction, fresh refusal after tampering, independence from mutated returned data
and exact cleanup. Retain all previous resource/network/runtime/descriptor assertions and deadlines.
Pure image vectors are syntax coverage; they cannot substitute for actual native qualification.
The genuine fixture labels failed host operations and profile read-back with fixed stage names,
preserving their original safe causes. Successful program output stays exact; diagnostics contain
no raw command arguments, private paths or new production logging. Mixed hosted results block merge
and require operation-specific diagnosis, with no timeout or assertion relaxation.
Bounded cleanup correction #1086/#1087 is consumed only from accepted `cordis`
`2c151402cff01bde80efa5b6abf3e44065752907`. It removes the redundant preceding kill and uses
containerd's wait-and-force-delete contract, retaining every final physical read-back assertion.
The expanded profile lifecycle must qualify independently after that sync; earlier mixed results
remain recorded and do not become passing evidence retroactively.

Run checks/build/all tiers, an exact safe-mode archive and independent scripts-disabled strict public
Node consumer, both complete hosted closures and review. Keep ten-file/twenty-line gates. No local
Kata, credentials, productive Work/models, issue closure, production/legacy mutation or cutover.
Pool/setup/egress, live manager/enrollment, seeds, CLI and final assembly remain required Task 3D;
productive Work/models/accounting remain Task 10.
