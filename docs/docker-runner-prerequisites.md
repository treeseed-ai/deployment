# Hosted Docker prerequisites

Hosted verification needs a responsive default Docker context before scenario execution.
The CI-only DockerPrerequisite program performs one preparation observation with a 30-second
budget, then requires the same default-context docker info command within the unchanged
five-second production observation bound. This prepares and qualifies an external prerequisite;
it does not retry tests, extend owner command deadlines, start containers or waive missing Docker.
Failure aborts verification with a fixed code before scenarios. Raw output and environment are
never logged. All existing tests, partitions, assertions and timeouts remain required.

The intermittent engine response delay in #1029 remains causally undiagnosed. This gate does
not claim its root cause is fixed. It makes readiness an explicit checked precondition and
retains missing/unresponsive prerequisite failures visibly. Both exact-head complete hosted
runs remain required. Ordinary development/test commands retain their original behavior.

Four built real-process cases use an explicit external command peer: immediate readiness,
six-second preparation followed by a responsive observation, initial nonzero exit, and an
observation exceeding the five-second bound. They require one or two exact calls, no hidden
retries and no private-output canaries. No workstation Docker daemon is invoked by this proof.

The maintainer accepted this separate process proposal under AGENTS.md.
Deliver on a verified issue branch: commit documentation, outside-in cases, helper/CI wiring,
run owner checks/build/all applicable tiers and full hosted verification, review and integrate.
All issues remain open; legacy services and production channels are untouched.
