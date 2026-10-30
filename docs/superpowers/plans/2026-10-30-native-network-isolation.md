# Native Network Isolation Implementation Plan

> **For implementing agents:** Use the actual available workflow/testing tools, preserve the user's execution method, and deliver one bounded task at a time. Checkboxes record verified results, not intentions. Retain child-repository setup pauses.

**Goal:** Qualify offline virgin native bases from actual owned OCI and guest read-back before pool admission.

**Architecture:** Keep network qualification below Deployment's selected native host provider.
Project immutable observation data bound to the actual boot digest; Agent retains pool policy.
Native Cordis remains the provider resolver and lifecycle owner.

**Tech Stack:** Existing strict TypeScript, SDK canonical JSON, Zod, native Kata 4.1.0 and containerd 2.4.2.

**Spec:** [Owner reference](../../native-network-isolation.md).

## Global Constraints

- Part of #1076 and approved Task 3D; feature branches and PRs use `cordis` only.
- Accepted baseline `a8d42f4be5d17f2a879adda5c8a5576e37b7b77b`; preserve original drafts and frozen archives.
- Policy mode only; no new namespace/runtime flags, SDK wire operations or profile advertisement.
- At most ten changed files and twenty canonical method body lines; no new baseline/exception.
- Preserve all existing test assertions, timeouts and the fifteen-minute CI job budget.
- No local Kata/QEMU, production/legacy mutation or issue closure; Work/models remain Task 10.

## Review Focus

- Missing or duplicate network entries must refuse inheritance/ambiguity; add pure rejection cases.
- A foreign/host namespace path must not qualify; test private-path error canaries.
- Extra interfaces, whitespace and truncated/ambiguous output must refuse acceptance; test exact bytes.
- Evidence must match the actual native boot generation; assert matching create/inspect boot digests.
- Disposal or failed validation must not erase uncertainty; preserve native custody/destruction/FD checks.

## Ordered delivery

1. Commit this plan, owner reference, README link and issue-linked changelog entry.
2. Extend the existing built native custody program's public interface test and real hosted
   default-root scenario to require immutable network evidence. Preserve every earlier assertion.
   Run the built public test and record its intended failure before implementation.
3. Add pure unit cases for the namespace/output/digest projection. Regression stays the complete
   existing tier; this new requirement is not mislabeled as a historical defect. Native real
   collaborator integration is exercised by the existing hosted default-root acceptance path.
4. Implement `src/native-network.ts` as one cohesive pure projection. Wire actual OCI/guest
   reads through `src/kata-backend.ts` beneath retained custody and launch attestation. Include
   optional network evidence only in policy mode. Regenerate package metadata with a fresh identity.
5. Run checks, build, built interface, focused cases and full lower tiers. Pack a fresh immutable
   owner archive; compare bytes/modes and run an independent strict TypeScript + Node consumer.
6. Push a bounded draft to `cordis`; require both complete hosted closures. Review exact source,
   lifetime, artifact identity and review threads before any authorized merge/verified cleanup.

## File ownership

Owner reference, this plan, README and CHANGELOG hold the contract and provenance. Package metadata
records the fresh public archive identity. `native-network.ts` owns pure projection; `kata-backend.ts`
owns real reads/ordering. Existing custody acceptance/support files pin actual default construction;
`tests/unit/native-network.test.ts` pins pure input boundaries. No cross-checkout source import.
