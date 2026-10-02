# Deployment workspace guidance

## CRITICAL: complete automated test coverage

Every behavior, contract, state transition, failure path, and edge case must have automated unit, integration, and scene/guarantee-based acceptance coverage. This is mandatory for all projects, especially the capacity-provider and agent system. A behavior without all three layers is an unresolved delivery gap, not completed work.

- Unit tests must prove exact outputs, validation, invariants, and boundary conditions. Cover valid and invalid inputs, missing/empty/malformed values, authorization denial, stale or moved refs, and every named prohibited field.
- Integration tests must exercise the real owning components and their public boundaries: handlers, provider/kernel execution, APIs, persistence, tools, and downstream consumers. Mocks, string assertions, compilation, or call-order checks alone are not integration proof.
- Coded scenes and guarantees must prove production-shaped end-to-end outcomes: exact governed artifacts and read-back, independent verification, actual usage, exactly-once settlement, and durable teardown. Use the project's existing native acceptance harness and respect package ownership; do not put TreeSeed-specific policy into product-neutral packages.
- Cover duplicate and concurrent execution, idempotency, partial failure, interruption, retry, resume, cancellation, expiry, provider/tool/subprocess errors, unsafe commands, and cleanup without residue. Preserve failed observations; do not fabricate dispositions, usage, citations, receipts, or passing replays.
- For every defect, first add a focused regression that reproduces the failure, then add or strengthen the corresponding integration and scene/guarantee cases. Fix the earliest owning contract. Retain previously covered behavior and all historical failed evidence.
- Never weaken assertions, remove negative cases, narrow acceptance criteria, disable type checks, extend deadlines, increase allowances, or relabel failures as passes to get green results. An unexpected agent timeout is a fatal architecture defect: agents must check authoritative remaining time frequently, reserve verification/closeout time, and produce authorized continuation proposals for unfinished work before the original deadline.
- Delivery requires passing evidence at all three layers on the exact candidate. Missing environments, credentials, skipped tests, or blocked layers remain explicitly unproven. Component passes, suite totals, line coverage, and process completion never substitute for full semantic acceptance.
- Keep the behavior-to-unit/integration/scene mapping and exact command, commit, run, and artifact evidence in the existing Issue body and Actions artifacts. Reproduce failures with cheap focused tests before another expensive activation or full campaign; batch known fixes, inspect failed jobs, and reuse only unchanged immutable evidence. No duplicate campaigns or new coverage side channels.

## Agent configuration and handler ownership

When this project defines or consumes agents, agent identity, task instructions, prompts, capabilities, permissions, parameters, and activity profiles must be governed YAML configuration. Adding or renaming an agent using existing handlers must not require provider, guest, kernel, or scheduler code changes. Do not hardcode named-role configuration in shared runtime code; shared rules must apply to any configured agent.

Task-specific executable code belongs in the configured handler. Reuse existing class-based handlers and exact profile bindings; new coded functionality may require a pinned handler, but not a parallel dispatch path or duplicated policy. Test arbitrary YAML-defined agents, renamed identities, handler selection, changed prompts/parameters, denied permissions, and unknown/duplicate handlers through unit, real integration, and coded acceptance cases.

TreeSeed Deployment is an Apache-2.0 repository. Human and agent changes use
the same durable pull-request record and exact-head verification, review,
staging, and release gates.

Preserve independent package builds and exact component-release custody. Keep
the privileged supervisor limited to fixed operations, keep project source out
of automatic host updates, and never add Market or Market API custody or a
hosted Market dependency. Production services consume immutable published
artifacts; the manager must not build downloaded project source.

## Branch and deployment boundary

`main` is the only production branch and maps only to the `production` deployment environment. `staging` is the only development-integration branch and maps only to the `staging` deployment environment. Short-lived pull-request branches may validate without deploying, but they must never define another deployment environment. Do not create or use `development`, `preview`, `stable`, or any other GitHub deployment environment; preview deployments are prohibited. Release tags may promote an exact reviewed `staging` commit to `production` without creating another branch or environment. Artifact channel names must never become GitHub deployment environments.

## Project library

Use `trsd library show deployment` and `status` before querying `treeseed-ai/deployment-library`. Read root-level paths with `trsd library read deployment <path> --ref <exact-commit>` and use `search`, `query`, or `context` for discovery. Author only through `trsd library workspace` and governed reviews. Never recreate `src/content` or edit `.treeseed/data` directly.
