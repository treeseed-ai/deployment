# Native Sandbox Profile Implementation Plan

> **For implementing agents:** Use the actual available workflow/testing tools, preserve the user's execution method, and deliver one bounded task at a time. Checkboxes record verified results, not intentions. Retain child-repository setup pauses.

**Goal:** Expose a generation-bound SDK profile only after explicit real native sandbox qualification.

**Architecture:** The selected native host retains a private qualification witness below its existing
Cordis provider. SDK owns portable profile/revision semantics; Agent owns actual pool admission.
Profile queries recheck prerequisites without creating VMs or caching service instances.

**Tech Stack:** Existing strict TypeScript classes, native Cordis, SDK .44, pinned Kata 4.1.0 and
containerd 2.4.2 read-only image metadata.

**Spec:** [Owner reference](../../native-sandbox-profile.md).

## Global Constraints

- Part of #1083 / approved Task 3D. Initial verified `origin/cordis`:
  `486c6aa39630a1a6843f5e85da2f4f0f89862c9c`.
- #1080 must physically qualify and merge before implementation consumes its source. Sync only
  accepted `origin/cordis`; never copy or merge another feature's unaccepted implementation.
- Optional host profile preserves providers without it. No SDK wire/global-operation change.
- ready/profile/doctor/plan create no VM. No unqualified egress or pool-readiness claim.
- At most ten files/twenty canonical method lines; no new dependencies/baselines/exceptions.
- Preserve every assertion/deadline, exact prior artifact and original draft. Use safe per-command
  local modes; do not change production custody rules or implement pending process proposals.
- Real Kata only on hosted Ubuntu. All issues remain open; Work/models/accounting stay Task 10.

## Review Focus

- A selected content blob does not prove the image-name target: verify actual pinned CLI metadata.
- Pure profile creation is not authority: only explicit genuine native default construction qualifies.
- Caller mutation and asynchronous hashing must not alter retained metadata or its generation.
- VM destruction is not capability loss; stale/closed attestation must not be used as live authority.
- Missing/tampered/restarted custody must refuse read-back, without silent adoption or hidden warmup.

## Ordered tasks

1. Commit reference/plan, README link and issue-linked changelog. Wait for accepted #1080 source.
2. Sync verified accepted `origin/cordis`. Extend the existing genuine built native scenario with
   absent-before-create, actual-after-create and repeat/cleanup/tamper profile expectations. Record
   the intended missing-capability failure before implementation.
3. Add pure image-target/profile transformation boundary vectors under `tests/unit`. Preserve all
   existing applicable tiers; hosted built construction covers the physical integration boundary.
4. Add a cohesive native profile module. Extend existing native policy proof read-back and host
   qualification ordering; verify actual image target before launch/read-back. Keep optional host
   interface compatibility and all genuine runtime attestation/custody ownership intact.
5. Run full checks/build/tiers. Freeze a fresh exact artifact, validate safe modes and all contents,
   then run an independent strict public TypeScript/Node consumer with scripts disabled.
6. Open a bounded `cordis` candidate; read both complete current-head hosted closures and review
   source/lifetime/threads. Perform only authorized merge and verified exact task-branch cleanup.
7. Deliver private SDK availability projection separately, followed by real Agent pool bootstrap
   and compatibility admission through exact public artifacts. Do not count this owner slice alone
   as installed capacity or complete Task 3D.

## File responsibilities

Reference/plan/README/changelog document the contract. Package metadata identifies the artifact.
New native-profile classes own pure image syntax and coherent owner metadata qualification. Existing
native policy owns descriptors and exposes verified immutable proof only. Backend owns actual image
selection/qualification lifecycle. Existing native program support and unit specifications retain
default production coverage. Private control forwarding remains a separate slice if ten files fill.
