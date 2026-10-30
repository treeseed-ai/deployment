# Native Filesystem Binding Implementation Plan

> **For implementing agents:** Use the actual available workflow/testing tools, preserve the user's execution method, and deliver one bounded task at a time. Checkboxes record verified results, not intentions. Retain child-repository setup pauses.

**Goal:** Qualify the active retained virtiofs serving process and socket for each owned native VM.

**Architecture:** A coherent read-only filesystem admission internally owns the existing genuine
runtime admission and observes actual process/socket state. Deployment owns host observation;
Agent owns pool/kernel policy, while native Cordis retains provider selection and lifecycle.

**Tech Stack:** Existing strict TypeScript classes, Node Linux process/filesystem inspection,
SDK canonical JSON, pinned Kata 4.1.0 and virtiofsd 1.14.0.

**Spec:** [Owner reference](../../native-filesystem-binding.md).

## Global Constraints

- Part of #1080 / approved Task 3D. Branch from verified `fdac6105307a8cc3bdf7e4126004f63e04dcb068`,
  then fast-forward only accepted `origin/cordis` at `486c6aa39630a1a6843f5e85da2f4f0f89862c9c`.
- Preserve previous launch/runtime contracts, SDK wire/global operations and unconfigured mode.
- No VM in ready/doctor/plan, profile advertisement, service cache or extra provider registry.
- At most ten changed files/twenty canonical body lines; no new dependency/baseline/exception.
- Retain all assertions, timeouts, fifteen-minute jobs, exact prior archives and original drafts.
- Real Kata only on hosted Ubuntu; no workstation runtime, legacy/production mutation or issue closure.
- Complete pool/setup/egress/enrollment/seeds/CLI/assembly remain Task 3D; Work/models remain Task 10.

## Review Focus

- Foreign/duplicate/alternate selectors must fail: bounded pure vectors and safe-error canaries.
- Daemon and serving child differ: validate both actual generations/ancestry and retained executable.
- Selected socket path alone is insufficient: bind the serving descriptor to connected kernel state.
- Cancellation/close must leave borrowed policy/VM intact: genuine built lifecycle checks.
- Returned evidence is historical: inspect freshly and reject destruction or changed custody.

## Ordered tasks

1. Commit reference, plan, README link and issue-linked changelog before specifications/source.
2. Extend the existing built public native fixture to require filesystem capability and actual
   create/inspect evidence. Run and record the intended missing-capability failure before source.
3. Add pure argument/state vectors under `tests/unit`; actual process/socket integration is covered
   by the hosted built default-root scenario. Preserve all existing lower tiers.
4. Implement cohesive projection/process/socket/admission classes in `src/native-filesystem.ts`.
   Add `NativePolicyCustody.filesystemLaunch` and default backend ordering/evidence. Preserve old APIs.
5. Run normal checks/build, built interface, focused and complete lower tiers. Freeze a new exact
   package; compare all contents/modes and run an independent strict public Node consumer.
6. Push a bounded draft targeting `cordis`; read both full current-head hosted closures and review
   exact source/lifetime/threads before any authorized merge and verified branch cleanup.

## File responsibilities

Reference/plan/README/changelog document behavior and provenance. Package metadata identifies the
new artifact. Native filesystem classes own bounded read-only observation. Existing native policy
retains descriptors; backend owns admission ordering. Existing built native program support and
`tests/unit/native-filesystem.test.ts` own physical default construction and pure boundary coverage.
No cross-checkout source imports, SDK ownership transfer or new runtime options.
