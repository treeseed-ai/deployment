# Runtime Component Custody Implementation Plan

> **For implementing agents:** Use actual workflow/testing tools, preserve the execution method,
> and deliver one bounded task. Checkboxes record verified results, not intentions.

**Goal:** Retain installed regular files whose exact bytes and modes match verified kit members.

**Architecture:** Deployment owns one coherent artifact-admission invariant over its existing
descriptor custody. Borrow the archive; own only installed component descriptors. Consumers use
the public `/sandbox` entry, with no cross-checkout source imports or runtime activation.

**Tech Stack:** Strict TypeScript classes, pinned Bun/Node, existing tar/Zstandard and safe files.

**Spec:** [Installed runtime component custody](../../runtime-component-custody.md).

## Global constraints

Same Deployment repository, issue #1021, fresh verified `origin/cordis` issue branch. Preserve
all issues, original dirty checkouts, legacy refs/services and exact historical archives.
Documentation → acceptance → integration → implementation → all owner/public/hosted gates.
No new dependencies, baseline entries, exceptions, credential creation or runtime effects.
At most twenty formatted body lines per changed method and ten files per candidate.

## Review focus

- A valid kit digest must not authorize unrelated installed bytes or modes.
- A symlink/replaced ancestor or component must fail rather than follow or adopt it.
- Mutable caller bindings must be snapshotted before archive inspection yields.
- A partial failure must close acquired files without closing the caller's archive.
- Proof/error output must omit installed paths and private canaries.

## Bounded delivery

Files: specification and this plan; CHANGELOG; acceptance, integration and registration-free
support program; `src/runtime-components.ts`; `/sandbox` exports in `src/kata-backend.ts`;
descriptor metadata in `src/filesystem.ts`; package candidate identity. Ten files total.

- [x] Commit the specification before executable tests or implementation.
- [x] Write built public acceptance for exact installed-member proof before implementation.
- [x] Add real file/archive boundaries for the five review risks and owned/borrowed lifetimes.
- [x] Observe the intended missing public capability failure, with valid fixtures/build first.
- [x] Wait for accepted #1046, then merge only verified `origin/cordis`; never copy its source.
- [x] Implement `RuntimeComponentCustody.open(archive, bindings, signal)`, immutable `proof`,
  `verify()` and `close()` with fixed safe `KATA_COMPONENTS_*`/cancellation failures.
- [x] Run normal owner checks/build and all applicable tiers. Record no new isolated unit
  suite honestly: this slice's behavior is the real descriptor/archive boundary.
- [x] Pack one fresh exact candidate; compare every packaged file/mode and run a source-free
  script-free public archive consumer.
- [ ] Run complete hosted gates, including actual read-only installed kit binding, and review before readiness.
- [ ] Keep full TOML/process/isolation/profile/pool readiness outstanding until separately proven.

Verified local combined closure: 18 regression, 205 integration, 70 unit and seventeen focused
real file/archive/program cases pass. Genuine .120 has 166 exact files/modes, SHA-256
`0ea968259f71ab18698e0d6c1b022a6d47d2d9e570b4b120cbd1ff078f5e73db`.
The public Node consumer passes both named contract and built filesystem programs. Six actual
installed components are exercised only in the hosted prepared-kit boundary, without execution.
