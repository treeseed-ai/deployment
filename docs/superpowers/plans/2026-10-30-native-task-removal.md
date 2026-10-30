# Native Task Removal Correction Plan

**Goal:** Use containerd's bounded wait-and-force-delete contract while retaining all physical proof.

**Issue:** #1086 / approved Task3D. Verified HTTPS `origin/cordis`
`366709a04a994a1825c878376acb369089bd5a0f`; branch `fix/1086-native-task-removal`.

**Architecture:** One internal cohesive removal capability below the existing selected sandbox
provider and verified client. Existing owner admission and final physical/journal verification remain
authoritative. No new provider framework, runtime option, public global operation or activation.

**Reference:** [Owner contract](../../native-task-removal.md).

1. Commit reference/plan, README and issue-linked changelog. Preserve profile/transport branches and
   original drafts; do not consume unaccepted profile source.
2. Record the actual default-host destruction failure from #1085. Add focused regression cases
   requiring upstream force-delete ordering and proving failed stop cannot fall through. Run red
   before implementation. Unit cases separately cover ownership, missing tasks and cancellation.
3. Implement internal typed-command removal with fixed operation context and safe existing errors.
   Wire the default backend after its existing resource check; retain all final read-back assertions.
4. Run checks/build/all tiers and genuine existing built-program/default-host acceptance. Freeze a
   new exact safe-mode archive and strict fresh-cache public consumer; prior artifacts remain frozen.
5. Open a bounded `cordis` candidate. Require both complete current-head hosted closures, source/
   lifetime/thread review and every criterion before authorized merge and verified branch cleanup.
6. Sync only fresh accepted `origin/cordis` into the blocked profile branch, then independently
   requalify that expanded lifecycle and artifact. Do not treat this fix alone as complete capacity.

Keep methods within twenty canonical lines and at most ten files. No tests/assertions/deadlines,
dependency locks, workflows, baselines or exceptions are relaxed. No workstation Kata. Every issue
stays open and productive Work/models/accounting remain Task10; production/legacy changes and
cutover remain unauthorized.
