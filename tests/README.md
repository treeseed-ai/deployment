# Owner testing strategy


All permanent executable test specifications MUST live in the owning repository under exactly
these tier directories, named for the capability or behavior being verified:

- `tests/acceptance/`: user-observable flows, end-to-end/browser coverage and smoke tests of built programs.
- `tests/regression/`: cases that pin an identified prior defect and prevent recurrence.
- `tests/integration/`: real collaborator, provider, package, filesystem and service boundaries.
- `tests/unit/`: isolated contracts, computations and transformations.

Write tests outside-in in that order, after committing documentation and before implementation.
Split mixed-tier suites. A negative case is classified by its purpose and boundary; it is not
automatically a regression. Permanent test files MUST NOT be flat under `tests/`, colocated with
source, or named after a migration/task/phase number. Do not disguise test suites as helpers.
Shared fixture classes, fixture programs and data may use `tests/support/`, with no test
registrations there. Historical migration evidence, exact composition pins and immutable archives
retain provenance outside executable test suites; durable coverage moves into the proper tier.

Every reorganization preserves assertions, inputs, timeouts, negative cases and discovery/count
parity. Update imports, fixture/build entrypoints, public test-helper exports, package scripts,
partition inventories, CI and current docs together. Verify all four tiers are discovered; an
empty tier must be recorded honestly rather than filled with redundant tests or silently skipped.
Include an executable layout/discovery check in the normal owner verification and CI gates;
exercise rejection of misplaced tests, phase-based names and hidden helper registrations.
For a setup-only repository, install that check with its first implementation, without adding
application scaffolding or dependencies during initialization.

Every injectable seam still needs default production construction coverage, and every user
program needs a built-program acceptance test. Completion requires applicable tier suites,
checks, build, CI and assembled-artifact smoke evidence. Report missing prerequisites or gates
explicitly. A green unit suite or policy prose alone is never sufficient.


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
belongs to exactly one of seven nonempty jobs: `foundation`, `transitions`, `sources`, `runtime`,
`git-installed`, `registered` and `build-registered`.
`transitions` owns explicit restart/retained-plan tests; `sources` owns NPM/Git/build tests;
`runtime` owns native application/authority tests and `*-install.test.ts` programmes. Other new
files remain in `foundation`. Each file's complete smoke selection runs in its assigned job.
No suite is skipped, duplicated or made optional to fit the budget.

`bun scripts/verification.ts smoke <partition>` runs the exact sorted set. `inventory` reports
all seven sets for read-back. Validation requires known suites, disjoint/exhaustive membership,
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

The genuine installed-Git suite (fresh owner, retained two-instance installation and approved
source build) has its own required `git-installed` smoke partition. Its observed local duration
exceeds ten minutes; sharing that work with native host and registered-selection programmes
would exhaust the existing fifteen-minute job budget. All other installed-provider suites remain
in `runtime`; both groups and every source/transition/foundation group are mandatory. No case is
skipped and the deadline is unchanged.

Registered-selection closure qualification runs the same source-stopped seven-service programme
against genuine NPM, committed Git and approved source-only Git. Each transition must reuse
accepted provenance, build the current complete offline lock and preserve every prior resource.
The NPM/plain-Git cases have a required `registered` smoke job; approved-build reuse has a
required `build-registered` job. These are disjoint exhaustive file groups alongside the existing
five groups, with the same fifteen-minute budget and all-success aggregate. No case is skipped.

Assertion-bearing reusable acceptance contracts live in `tests/acceptance/`; shared support
contains fixture setup and program inputs. Moving a case must also move its shared behavioral
assertions, rather than hiding the scenario in a support base class.

Complete tier commands use `bun test ./tests/<tier>` with only non-filtering timeout or
empty-tier reporting options. Individual-file selectors and shell wrappers do not prove
complete discovery. Name-filtered CI matrices must cover each registered case exactly once
and every partition must be nonempty; the shared layout guard verifies that inventory.
