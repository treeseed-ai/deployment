# Deployment owner test boundaries

Tests that construct `ComposeDeploymentHost` and call `plan` use the real Docker/host boundary,
even when their final assertions inspect frozen data. They belong to the integration tier and
need an explicit bounded budget for cold engine/fixture preparation. The accepted-observation
metadata test uses a 60-second budget; missing prerequisites and the production command timeouts
still fail visibly. It must finish before its fixture cleanup, rather than outliving Bun's
five-second default and deleting state underneath a pending host inspection.

The complete serial Docker gate now includes a compiled retained-transition scene and cold
module-entry probes. Measured local predecessor smoke was 472 seconds and the new compiled
scene 144 seconds, before CI setup. The job budget is 15 minutes; individual protocol/test
deadlines and missing-prerequisite failures remain enforced, with no skipped positive cases.

Scoped restart fixtures retain five genuine service containers, all owned volumes and credential
slots, and two explicit public-CA owners (instances 0 and 2). Other instances use the ordinary
protocol probe. The full authority/cross-grant suite continues to qualify all authority owners;
the scoped programme concentrates repeated observation on its unchanged CA owner and replaced
CA-bearing service. Preserve all resource/private-byte assertions, actual HTTP output, immutable
reversion history, exact scopes and default compiled worker. This bounds repeated authority
inspection within the existing 15-minute serial CI budget without weakening runtime audits.

The malformed/incomplete journal test invokes real `ComposeDeploymentHost.plan`, including
read-only host/engine inspection. Classify it as integration with a 60-second cold-host
budget. CI reproduced 5.443 seconds against the previous implicit five-second unit budget.
The same assertions and production command deadlines remain unchanged.

## Complete smoke partition gate

CI retains the existing 15-minute deadline and Ubuntu 26.04 prerequisite gate. Every test file
belongs to exactly one of four nonempty jobs: `foundation`, `transitions`, `sources`, `runtime`.
`transitions` owns explicit restart/retained-plan tests; `sources` owns NPM/Git/build tests;
`runtime` owns native application/authority tests and `*-install.test.ts` programmes. Other new
files remain in `foundation`. Each file's complete smoke selection runs in its assigned job.
No suite is skipped, duplicated or made optional to fit the budget.

`bun scripts/verification.ts smoke <partition>` runs the exact sorted set. `inventory` reports
all four sets for read-back. Validation requires known suites, disjoint/exhaustive membership,
valid paths, nonempty groups and a workflow matrix matching the inventory. Unknown partitions
fail with exit 2 before execution. The existing aggregate `verify` gate requires checks and the
complete smoke matrix to succeed. This change affects development verification only.

The packed plugin-fixture consumer uses an empty dedicated Bun cache. Its build-time package
installation may resolve exact declared dependencies from the registry, with lifecycle scripts
and dotenv loading disabled. Root lockfile installation does not imply cached registry manifests
for another project. Runtime source-free retry is tested separately against accepted private
artifacts and helpers; the consumer setup must not claim offline capability from a warm cache.

Listener-retention checks use Linux TCP socket inodes attributed to the fixture owner and its
actual descendants. Unrelated sibling process restarts on a shared developer host are outside
that observation scope. Genuine parent/child listener tests establish attribution and a new
listener is a failing delta. Docker host publications are checked separately against the accepted
service ports (private additions have none). Original container/resource identities, private
credential bytes, direct protocol and TLS authority remain exact retention assertions. No port
ignore list or bypass flag is allowed. Issue #995 records the prior host-wide false failures.
