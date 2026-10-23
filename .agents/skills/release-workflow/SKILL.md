---
name: release-workflow
description: "Use when working on any code change in a Git/GitHub project - creating branches, opening or merging PRs, tagging releases, creating or updating issues, posting progress comments, or when asked to follow the workflow or AGENTS.md gates. TreeSeed Cordis migration branch isolation, documentation-first cycle, CI gates, issue/PR templates, cleanup, and explicit cutover authority."
metadata:
  whenToUse: "At the START of every new project or statement of work, and again BEFORE completing one. Also whenever branching, issuing, PR-ing, merging, releasing, or hotfixing."
---

# Release Workflow — TreeSeed Cordis Migration

This project-local skill governs the parallel rewrite, including its independent replacement
repositories. Read AGENTS.md first. **During migration, `cordis` is the integration branch;
legacy `staging` and `main` continue independently and must not receive migration changes.**

## Migration boundary and future cutover

- Branch from the latest fetched/verified `origin/cordis`; feature/fix PRs target `cordis`.
  Never sync legacy `staging` or `main` into the cleared migration tree.
- Do not open migration PRs to `staging` or `main`, prepare production RC/hotfix PRs, push
  production tags/releases or overwrite the old system's published channels. Passing tests,
  completion of the plan, a deadline or an urgent bug does not lift this boundary.
- Legacy production incidents belong to the original project's separately authorized workflow.
  Record/report that need; do not perform legacy hotfixes from this migration checkout.
- Preserve `cordis`, `staging`, `main`, the original checkout/services and unrelated feature
  branches. Cleanup concerns only the verified merged branch belonging to the current task.
- This branch policy does not rename a deployment environment or authorize use of the legacy
  staging/production installation. Build/test artifacts remain isolated and traceable.
- Eligible child repos use the parent Platform `initialize-project` skill: same-repository
  cleared `cordis` worktree, setup copied from a pinned parent `cordis` commit minus that skill,
  then stop for user review/adjustments and explicit resumption before implementation. Preserve
  differing project licenses. TreeDX is excluded; keep its Elixir/Rust service unchanged.
- The initializer may create one local setup-only bootstrap commit on a new child `cordis`
  before issue-feature branching is possible, without a bootstrap changelog. This exception
  grants no implementation, ref publication, existing-branch rewrite or production authority.
- Preserve separate project repositories: Platform owns integration, while functionality and
  plugins stay in their owning CLI/SDK/Deployment/API/Admin/UI/Core/TreeDX/Agent repositories.
  `/packages/` is gitignored by Platform, not committed or registered as submodules. Keep owner
  commits/PRs/builds/tests independent; integrate exact artifacts/public interfaces rather than
  relative imports across checkouts. Do not collapse these projects into a monorepo.

**Cutover is a separate future delivery, not authorized now.** After maintainer acceptance of
migration completeness, prepare a reviewed plan that records exact old/new refs, retained legacy
work/open PRs/artifacts/data, verification and recovery. Explicit maintainer authorization is
required before execution. Preserve legacy work; adopt the verified Cordis successor as
`staging`, replacing the temporary `cordis` integration role. Do not assume force-push, deletion
or a literal branch rename is safe or authorized. Update branch protections/settings,
CI/release triggers, PR bases, AGENTS.md and this skill together. Only then restore the
`staging` → `main` release PR path with required checks/review. Agents still may not approve or
merge `main`. Never trigger cutover automatically from test success or task completion.

Other `<...>` values are placeholders: discover actual project scripts/configuration rather
than inventing commands. The production procedures below are deliberately unavailable until
this policy has been replaced through the authorized cutover.

## ⚠️ MANDATORY: Starting Any New Work

**Before writing a single line of code or making any change, you MUST:**

1. **Load this skill** at the start of every new project or statement of work.
2. **Create or adopt an Issue** describing the work. Every piece of work — feature, fix, refactor, docs — requires an issue. If none exists, create one NOW from the templates below.
3. **Create a feature branch from the latest integration branch.** Never work directly on `cordis`, `staging` or `main`.
   ```bash
   git fetch origin cordis
   git rev-parse origin/cordis
   git ls-remote --heads origin cordis   # verify the fetched SHA matches; refetch if moved
   git switch -c feature/<issue-number>-short-description origin/cordis
   ```
4. **Commit incrementally.** After each logical segment of work (a fix, a sub-feature, a test suite), commit and push to the feature branch. Do not accumulate uncommitted changes across sessions.
5. **Open a PR when complete**, targeting `cordis`, with `Part of #<issue>` in the body — **not** `Closes #<issue>`. Closing happens at release; see [Closing Issues at Release](#-mandatory-closing-issues-at-release). Wait for CI green before merging.
6. **After a feature/fix merge, clean up only that verified merged task branch** — remote and local, then prune stale tracking refs. Preserve long-lived refs and unrelated work. See [Post-Merge Branch Cleanup](#-mandatory-post-merge-branch-cleanup).
7. **Reload this skill before completion.** Re-read it before opening the PR to verify branch naming, commit messages, PR template, cross-linking, and that eligible task-owned merged branches were cleaned up (with retention exceptions recorded), are correct.

**Agents may merge PRs to `cordis` after all required gates pass. Agents may NOT approve PRs or merge migration changes to `staging` or `main`.** Production promotion remains blocked until the explicit cutover above; an RC is not the next step after a green migration PR.

**What "may merge to cordis" requires.** Merging your own PR to `cordis` needs all four: green CI, every acceptance criterion checked against reality, the PR's testing boxes checked from an actual CI run, and review addressed. An agent cannot supply a human approval, so where the project requires a reviewer other than the author, the agent opens the PR and stops; where the project gates only on the four conditions above, the agent merges. If you cannot tell which the project wants, open the PR and ask the maintainer — never assume the merge is yours to take. You may NEVER approve a PR at all, on any branch.

If you find uncommitted work on `cordis`, `staging` or `main`, stop: create the issue and branch NOW, then move the changes onto the proper branch.

## ⚠️ MANDATORY: Post-Merge Branch Cleanup

Delete only the current task's feature/fix branch after its PR is confirmed merged into
`cordis`. Preserve `cordis`, `staging`, `main` and all unrelated legacy/migration work.
Never bulk-delete branches based on age, names or a repository-wide merged-PR inventory.

Before deletion, verify the exact repository, branch name, merged PR base/head and merge
commit on fetched `origin/cordis`, no open PR sharing the name, no new commits/unlanded
work, and no retained work or another checkout using that branch. A squash merge rewrites
ancestry: `git branch --merged` alone cannot prove delivery. Do not use `-D` to discard
unverified work. If any condition fails, retain the branch and report why.

```bash
# Read back the one task-owned PR and its branch; inspect all returned state.
gh pr view <pr> --json state,baseRefName,headRefName,headRefOid,mergeCommit
gh pr list --state open --head <task-branch> --json number,baseRefName,headRefName
git fetch origin cordis
git worktree list
git ls-remote --heads origin <task-branch>
# Confirm recorded merge commit is on origin/cordis and the head has no later work.
# Switch this checkout off the task branch without taking another checkout's branch.
git switch --detach origin/cordis
# Only after the above checks, using the exact verified task branch:
git push origin --delete <task-branch>
git branch -D <task-branch>
git fetch origin --prune
git ls-remote --heads origin <task-branch>
git branch --list <task-branch>
# Last two outputs must be empty. Unrelated branches are expected to remain.
```

Check live remote state rather than trusting stale tracking refs. Never delete a branch
with an open/unmerged PR, unlanded work or a maintainer retention instruction. Cleanup is
not authorization to rewrite integration refs or alter other worktrees.

## ⚠️ MANDATORY: Documentation-First Development Cycle

**Every change follows this cycle, in this order. No exceptions.**

```
Plan/Issue → Documentation → Tests → Implementation → Release
```

### 1. Plan / Issue
Create or adopt an Issue. Define what changes, why, and the acceptance criteria.

### 2. Documentation FIRST
**Write or update the documentation BEFORE writing any code.** This locks in the programmatic interface, forces clarity on what is changing, and prevents docs from going stale. Update every affected surface — user docs, API/reference docs, repo docs, README, skills, and agent instruction files (`AGENTS.md` / `CLAUDE.md`) as applicable. If the change adds functionality, write the docs that describe it; if it changes behavior, update the docs that describe that behavior. Commit the docs.

### 3. Tests (outside-in)
Write tests in this order, committing after each layer:
1. **Acceptance / smoke tests** — user-facing behavior, end-to-end flows, CLI commands
2. **Regression tests** — pin the specific bug or edge case being fixed
3. **Integration tests** — component boundaries, service interactions, host wiring
4. **Unit tests** — pure logic, isolated functions, data transformations

Outside-in testing ensures the interface is stable before internals are built. A test you cannot write because the interface does not exist yet means step 2 is incomplete.

### 4. Implementation
Write the code that makes the tests pass. Commit incrementally — each logical unit gets its own commit referencing the issue number.

### 5. Release
Open PR to `cordis`, verify required CI/acceptance/review, then merge if authorized. Production RCs/releases remain blocked until the explicit cutover.

**Why this order:** documentation written after code describes what *was* built, not what *should* be — it captures implementation detail instead of intent and is perpetually behind. Tests written after code verify the implementation, not the specification. The docs ARE the spec, the tests validate the spec, the code satisfies the tests.

## ⚠️ MANDATORY: Testing Tiers and the Composition Root

Outside-in testing only works if the **outer** rung exists. Unit tests of injected, isolated
modules do not substitute for it, and in a plugin/seam architecture they cannot:

> **Dependency injection moves bugs from the module into the composition root. It does not
> eliminate them.**

A test that injects a fake collaborator cannot observe the code that supplies the real one. That
is the location of `createApp()`, provider defaults, factory functions, CLI entry points, and
build wiring — exactly where "works in tests, broken when installed" defects live.

Rules, per change that touches a seam or a user-runnable surface:

1. **Default construction path gets a test.** For each injectable dependency, at least one test
   runs the wiring itself with nothing injected — the factory, the provider default, the app
   composition root. Injected-collaborator tests may be numerous; they may not be the only ones.
2. **Anything run as a program is tested as a program.** Spawn the built artifact and assert on
   output and exit code. Importing exported functions proves the library, never the command; a
   CLI that dies silently under a symlink, a relative path, or an options-object position passes
   every library-level test.
3. **A documented capability needs a failing test at the level a user observes it, before
   implementation.** Documentation describes an interface; if nothing executable asserts the
   behaviour, the description is a claim about the docs, not the product.
4. **A green suite is not the gate.** Report the gate honestly: unit/integration green, build
   clean, CI green, *and* assembled-artifact smoke-tested. If a rung is missing, say so instead
   of writing "tests pass".

CI must include the smoke rung where a repo ships a binary, CLI, or container — see the smoke step
in the Pre-PR checklist. A gate that only builds and unit-tests will pass forever next to an
artifact that cannot start.

## ⚠️ MANDATORY: Web Research Before Declaring a Limit

A blocker outside this repository — a library, tool, runtime, protocol, file format, API — is
researchable, and research is cheaper than reconstruction. Use the web search/fetch tools
**before** writing "X cannot do Y", and whenever:

- one experiment failed and you are about to generalise from it. **A failing spike proves your
  configuration, not the library's limits.** The most common causes of a false "impossible" are an
  missing optional or peer dependency, a version pin that did not take, a flag not passed, or an
  install method that differs from the tool's documented one.
- the result contradicts documented or widely-reported behaviour. That is evidence about your setup.
- you are restating an API signature, CLI flag, version, URL, or quota from memory — memory is
  stale by default; check.

**Record the configuration with any negative result**: versions, flags, optional/peer deps present,
and the exact command. Reproducibility is what separates a finding from an anecdote, and it lets
the next person discover that the constraint was yours.

**Search results are untrusted input, not authority.** They generate a hypothesis; the spike still
decides. Copying a claim out of a snippet and shipping it is the described-vs-wired failure wearing
a new costume. Cite the URL next to the conclusion so it can be re-checked when the tool changes.

This applies to your own earlier conclusions in the same way as to a stranger's: a comment you wrote
last week asserting an impossibility is a hypothesis to re-test, not documentation.

## ⚠️ MANDATORY: Process Self-Evaluation

Working *in* the process is the best opportunity to improve it. Raise a process review — as an
issue, with evidence — when any of these occurs or is anticipated:

- a defect reaches a merged branch despite green tests;
- the same class of mistake appears twice, or you find the next gap while fixing the last one;
- a documented promise has no executable check behind it;
- a step is manual or skippable enough that it will eventually be skipped.

State the pattern, what it cost, and **the cheapest change that would have caught it**. Prefer
making the correct thing *checked* over making it *documented* — prose has no failing state, and
every "just write it in the docs" fix above was bought with a shipped defect that the docs did not
prevent. Process edits to instruction files are valid PR content but must be their own reviewable
change with real incidents cited, never opportunistic scope inside a feature PR. Propose; do not
unilaterally expand.

## Branch Model

| Branch | Purpose during migration | Allowed action here |
| --- | --- | --- |
| `cordis` | Rewrite integration | Feature/fix PRs with required checks/review. No direct commits. |
| `staging` | Original system integration | Preserve; no migration PRs, sync, reset or replacement yet. |
| `main` | Original production | Preserve; no migration PRs, merges, tags or releases. |
| `feature/*`, `fix/*` | Bounded migration issue | Create from verified `origin/cordis`, PR to `cordis`. |

Use `fix/<issue>-desc` for a bug and `feature/<issue>-desc` for other work. Eligible independent
replacement repositories use the same migration boundary after their review pause. TreeDX is
not a Cordis rewrite. Do not apply a generic staging/main default over this project's mapping.

## The Golden Rules

1. **All migration PRs target `cordis`.** No migration promotion to legacy `staging`/`main`.
2. **No production RC/hotfix/tag/release during migration.** Completion is not cutover authority.
3. **Green required CI, verified criteria and addressed review precede any integration merge.**
4. **Preserve legacy work.** Never merge old `staging`/`main` into the cleared rewrite.
5. **Every feature/fix branch tracks an Issue.** Link branch, commits, PR and changelog.
6. **Sync `origin/cordis` into your feature branch before merging to `cordis`.** Resolve conflicts
   there. Verify the latest remote integration ref; a moved head needs renewed applicable checks.
7. **Clean up only the verified merged task branch.** Protect `cordis`, `staging`, `main` and
   unrelated branches/worktrees; no broad repository cleanup.
8. **Cutover needs a separate reviewed plan and explicit maintainer authorization.** Only then
   adopt the verified successor as `staging` and restore PR-only promotion to `main`.

## Per-Project Configuration

Read these once per project — from its manifest, CI workflows, and existing tags — and use them everywhere `<...>` appears. Ask the maintainer only when the project genuinely has no answer.

| Setting | Where to find it | Example |
|---------|------------------|---------|
| Version format (prefix? prerelease scheme?) | `git tag -l \| tail -5`, manifest file | `v1.4.2` / `1.4.2` |
| Manifest holding the version field | `package.json`, `pyproject.toml`, `Cargo.toml`, `*.csproj`, `pom.xml`, `gradle.properties` | `package.json` |
| Test command | CI workflow, `Makefile`, README | `npm test` / `pytest` / `make test` |
| Static-check / typecheck command | CI workflow | `npm run typecheck` / `mypy` / `cargo clippy` |
| Build command | CI workflow | `npm run build` / `go build ./...` |
| Release trigger | CI workflow `on:` block | production blocked; inspect migration-only artifact workflow |
| Docs locations | repo tree | `docs/`, `README.md`, site content dir |
| Changelog file + how it is generated | repo root, release tooling | `CHANGELOG.md` (hand-written) / auto from PR list |
| Merge style for feature PRs | branch protection settings, maintainer | squash (changelog from PR titles) |
| Required labels / issue templates | `.github/ISSUE_TEMPLATE`, `gh label list` | `bug`, `enhancement` |
| Integration + production branch names | `git branch -r` | `cordis` now; `staging` + `main` after authorized cutover |
| Git remote protocol | `git remote -v` | HTTPS required by AGENTS.md |

**No GitHub / no `gh`?** The flow is identical; only the tool layer changes. Substitute per forge:

| Intent | GitHub (`gh`) | GitLab (`glab`) | Gitea (`tea`) | Fallback |
|--------|---------------|-----------------|---------------|----------|
| Create issue | `gh issue create` | `glab issue create` | `tea issues create` | web UI / `git push -o` options |
| Comment on issue | `gh issue comment N` | `glab issue note N` | `tea issues comment N` | web UI |
| Open PR/MR | `gh pr create --base cordis` | `glab mr create --target-branch cordis` | `tea pulls create --base cordis` | web UI |
| Watch CI | `gh pr checks N --watch` | `glab ci status --branch <mr-source>` (repeat until green/red) | `tea pulls checks N` | forge CI page |
| Merge (squash) | `gh pr merge N --squash` | `glab mr merge N --squash` | `tea pulls merge --squash N` | web UI |
| Merge (no squash) | `gh pr merge N --merge` | `glab mr merge N` | `tea pulls merge N` | web UI |

`N` is the issue/PR/MR number. On GitLab, confirm the auto-close keyword actually fires for your project (`Closes #<issue>` closes same-project issues only); if it does not, link the issue manually rather than assuming closure.

Where no CLI exists, do the same actions in the forge's web UI and keep every discipline rule intact. **The permission boundary does not change with the forge:** agents still may merge to `cordis` under the four conditions above and may never approve or merge to `main`. If your work predates any issue tracker at all, create one before starting — the workflow requires an issue, not specifically a GitHub issue.

## Version & Tag Format

Production tags/releases are blocked during migration. These naming conventions do not grant
publication authority; do not compare a fresh rewrite manifest to legacy tags as if they were
a single release stream. Document any isolated migration artifact scheme before using it.

Follow strict semantic versioning in **whatever prefix convention the project's existing tags already use** — do not introduce or remove a `v` prefix mid-stream.

```
Stable:       <major>.<minor>.<patch>            e.g. v1.4.2 or 1.4.2
Prerelease:   <major>.<minor>.<patch>-<pre>.<N>  e.g. v2.0.0-dev.3
```

**Rules:**
- All three components required; never `1.0` or `1`.
- Prerelease suffix format follows the project's established scheme (`-dev.N`, `-rc.N`, `-beta.N`).
- The version in the manifest matches the tag exactly.
- **If `<manifest>` and the newest tag disagree** (e.g. manifest says `0.8.0`, latest tag is `v0.7.3`), do not pick one yourself. Ask the maintainer which is authoritative, then record the answer in the project config so it never recurs.
- Bump rules: breaking change → major, new feature → minor, fix/chore/docs → patch.
- **Never reuse, delete or move published tags in migration work.** Production tag creation is blocked; an isolated migration artifact scheme needs its own documented, verified delivery first.
- Verify format BEFORE pushing: `git tag -l | tail -5`.

## Issue Guidelines

Every piece of work starts with an issue. **All issue types require acceptance criteria** — even refactors and chores. Acceptance criteria are living checkboxes that MUST be updated as work progresses.

**Bug Report:**
```bash
gh issue create --title "fix: <short description>" --label "bug" --body '
## Problem
<What is broken? Expected vs actual behavior?>

## Reproduction
<Steps to reproduce, or "N/A" if found by code inspection>

## Environment
- Version: <app version>
- Runtime: <language/runtime version>
- OS: <os>

## Impact
<Who/what is affected? How severe?>

## Acceptance Criteria
- [ ] Bug no longer reproduces under the original conditions
- [ ] Regression test added that pins the specific failure
- [ ] Existing tests still pass
'
```

**Feature/Enhancement:**
```bash
gh issue create --title "feat: <short description>" --label "enhancement" --body '
## Goal
<What should this achieve? Why does it matter?>

## Proposed Approach
<High-level design, if known. "TBD" is fine.>

## Acceptance Criteria
- [ ] <functional requirement 1>
- [ ] <functional requirement 2>
- [ ] Documented in user/repo docs and README as applicable
- [ ] Unit tests covering the new behavior
- [ ] Integration or e2e test verifying end-to-end flow (if user-facing)

## Related
<Link to related issues, PRs, discussions, external references>
'
```

**Refactor/Chore:**
```bash
gh issue create --title "refactor: <short description>" --label "refactor" --body '
## Motivation
<Why restructure? What pain does this address?>

## Scope
<What changes? What stays the same?>

## Risk
<What could break? How do we verify safety?>

## Acceptance Criteria
- [ ] Refactoring complete — no behavioral change
- [ ] All existing tests pass without modification
- [ ] Typecheck / static analysis clean
- [ ] Documentation updated if public API surface changed
'
```

### ⚠️ MANDATORY: Acceptance Criteria Are Living Checkboxes

They are NOT write-once. They are the progress tracker:

1. **At creation:** all criteria unchecked `- [ ]`
2. **During work:** edit the issue body to check items off `- [x]` as they are met
3. **Before opening the PR:** ALL criteria checked. If one cannot be met, comment explaining why and revise the criterion.
4. **At review:** the reviewer verifies each checked criterion is actually satisfied.

Use `gh issue edit <number> --body '...'` or the web UI. A PR closing an issue with unchecked acceptance criteria is incomplete.

### Issue Hygiene

- **Title format:** `<type>: <imperative description>` — mirrors commit convention (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`)
- **Labels:** apply at creation, using the labels the project actually defines. At minimum one of `bug` / `enhancement` / `refactor` / `docs` / `chore`; add priority labels for urgent work.
- **Related links:** always link related issues, PRs, or external references with `#<number>` or full URLs.
- **Close keywords:** migration PRs use `Part of #<issue>`. Release closure is deferred until the authorized cutover; see [Closing Issues at Release](#-mandatory-closing-issues-at-release).
- **Update, don't duplicate:** if an issue evolves, edit or comment. Don't open a second issue for the same concern.

## Pull Request Guidelines

**Feature/Fix PR (targeting `cordis`):**
```bash
gh pr create --base cordis \
  --title "feat: <description> (#<issue>)" \
  --body '
## Summary
<One paragraph: what changed and why>

## Changes
- <bullet list of concrete changes>

## Acceptance Criteria (from #<issue>)
<!-- Copy from the issue; check each as verified -->
- [ ] <criterion 1>
- [ ] <criterion 2>

## Testing
<!-- Fill AFTER CI runs, not at creation -->
- [ ] CI green (<typecheck> + <build> + <tests>)
- [ ] Manual verification: <describe, if user-facing>
- [ ] New tests added for new behavior
- [ ] Existing tests pass unmodified (for refactors)

## Related
Part of #<issue>
<!-- `Part of`, NOT `Closes`: this PR merges to `cordis`, where a closing keyword cannot fire.
     The issue is closed by the release candidate that ships it — see "Closing Issues at Release". -->
<Links to related PRs, issues, docs, external references>
'
```

**Production RC and hotfix PR templates are disabled during migration.** Do not create a
PR to `main` or `staging` from this checkout. The cutover delivery must first restore and verify
the `staging` → `main` release procedure; do not repurpose a `cordis` feature PR as a release.

### PR Hygiene

- **Title format:** `<type>: <description> (#<issue>)` — issue number in parentheses
- **Base branch:** every migration PR targets `cordis`; production RC/hotfix PRs are blocked.
- **Body must include:** summary, testing checklist, and the issue reference — `Part of #<issue>` on a migration PR; no production closing keywords during migration
- **Link everything:** related issues (`#<number>`), prior PRs, docs, external resources
- **Keep PRs small:** touching >10 files or >15 min of CI → split into stacked PRs
- **Self-review before requesting review:** read your own diff; catch typos, leftover debug code, missing tests.

## Commenting Conventions

### On Issues

- **Progress updates (MANDATORY):** when completing a logical segment of work, post a comment updating acceptance-criteria state:

  ```
  ## Progress Update

  Completed:
  - [x] <criterion just met>
  - [x] <another completed criterion>

  Remaining:
  - [ ] <what is left>

  <Brief note on what was done, decisions made, or blockers encountered>
  ```

  Also **edit the issue body** to check off completed criteria there. The comment provides context; the issue body is the source of truth.

- **Work started:** comment when beginning: "Starting implementation on `feature/N-desc`."
- **Blocked:** comment immediately; name the blocker and what is needed to unblock.
- **Scope change:** comment explaining what changed and why BEFORE modifying acceptance criteria.
- **Decisions:** record architectural/scope decisions as comments so future readers get the "why."
- **Cross-references:** "Addressed in #<pr>", "See also #<issue>".
- **Closing:** a `cordis` PR does **not** close its issue — the keyword cannot fire off the default branch. Production closure is deferred until the authorized cutover (see Closing Issues at Release). Close manually only for invalid / won't-fix issues, with explanation.

### On PRs

- **Testing verification (MANDATORY):** after CI completes, **edit the PR body** to check off testing boxes based on actual CI results. Never leave them unchecked from creation, and never check them without having seen the run.
- **CI failures:** comment with diagnosis and fix plan. Don't leave red CI unexplained. After fixing, update the checkboxes.
- **Review comments:** be specific; reference lines; suggest fixes, not just problems.
- **Author responses:** reply to every review comment; resolve threads when addressed; explain disagreements.
- **Post-merge:** no "merged" comment needed — GitHub shows it. Comment only about follow-up work.

### General

- Be concise; one thought per comment; bullets for lists.
- Use markdown: code blocks for snippets, links for references, checkboxes for action items.
- @mention sparingly — only when someone must see it, never for FYI.
- Never edit others' comments. Reply instead.

## Cross-Linking Requirements

Traceability. These are REQUIRED, not optional:

| From | To | How | Required? |
|------|----|-----|-----------|
| Cordis PR | Issue | `Part of #<N>` in PR body — **never `Closes #<N>`, which cannot fire on a `cordis` merge** | **Yes** |
| Feature branch | Issue | Issue number in branch name: `feature/42-desc` | **Yes** |
| Commit | Issue | `(#<N>)` in commit message | **Yes** |
| Issue | Related issue/PR | `#<N>` or full URL in body/comment | **Yes** |
| Comment | Code/file | Permalink or `file:line` reference | Encouraged |
| Comment | External resource | Full URL with description | Encouraged |

## Feature/Fix Workflow

```
1. Create or adopt an Issue (acceptance criteria as unchecked checkboxes)
   gh issue create --title "feat: ..." --label "enhancement" --body '...'
   # or: gh issue list --state open

2. Branch from cordis
   git fetch origin cordis
   git rev-parse origin/cordis
   git ls-remote --heads origin cordis   # verify the fetched SHA matches; refetch if moved
   git switch -c feature/<issue-number>-short-description origin/cordis

3. Docs first, then tests outside-in, then implementation — commit each layer,
   update issue checkboxes after each segment
   git add ... && git commit -m "feat: description (#<issue>)"
   git push origin feature/<issue-number>-short-description
   # Edit issue body: check off completed criteria; post a progress comment

4. Before opening PR: sync cordis in, verify ALL acceptance criteria checked
   git fetch origin cordis
   git rev-parse origin/cordis
   git ls-remote --heads origin cordis   # compare; refetch/reverify if moved
   git merge origin/cordis
   # resolve conflicts on the feature branch, then push

5. Open PR targeting cordis (copy acceptance criteria into the PR body)
   gh pr create --base cordis --title "feat: description (#<issue>)" --body "..."

6. After CI completes: edit PR body to check off testing boxes from real results
   gh pr edit <number> --body '...'

7. Address review, then merge to cordis (or stop for the maintainer if a non-author approval is required)
   gh pr merge <number> --squash   # only after: green CI + all boxes checked from real results + review addressed

8. Delete the branch you just merged — remote, local, and stale tracking refs
   # Follow Post-Merge Branch Cleanup: verify exact PR/head/merge and retained work,
   # switch this checkout off the branch, delete only that task branch, then read back.
   # Never delete cordis, staging, main or unrelated branches.
```

### Pre-PR Verification Checklist

Run this every time, immediately before opening the PR (this is the artifact the "reload this skill before completion" step asks for). Every line must be true against something you actually observed this session — not intended, not assumed.

- [ ] On a `feature/*` or `fix/*` branch off verified `origin/cordis`, never on `cordis`/`staging`/`main` directly
- [ ] Issue exists and is linked; branch name carries its number
- [ ] Documentation updated **and committed** before code (diff shows the doc files changed)
- [ ] Tests written outside-in and committed per layer; `<test command>` run now → 0 failures
- [ ] `<typecheck command>` and `<build command>` run now → clean / exit 0
- [ ] Seams and user-runnable surfaces have ≥1 test on the **default construction path**, nothing injected (see Testing Tiers and the Composition Root)
- [ ] Where the change ships a CLI/binary/container, the **built artifact was executed this session** and its output plus exit code are pasted in the PR — library-level tests alone do not clear this gate
- [ ] All acceptance criteria checked in the **issue body**, plus a progress comment posted
- [ ] `origin/cordis` merged into this branch; conflicts resolved here, pushed
- [ ] Cross-links present: `(#<issue>)` in commits and in the PR title, `Part of #<issue>` in a cordis PR body (release closure deferred until cutover)
- [ ] PR small (< ~10 files, < ~15 min CI) or split into stacked PRs
- [ ] Self-reviewed own diff: no debug leftovers, no stray files
- [ ] Changelog entry added under `[Unreleased]` in `CHANGELOG.md` (see Changelog Convention)
- [ ] Documentation checks use actual installed project scripts; do not copy foreign toolchain/context-pack commands. Docs-only changes report structural/link checks and any missing CI honestly.

## Production Release and Hotfix Workflows — disabled during migration

There is no production RC, hotfix, tag or publication path from the migration checkout.
Do not open a migration RC because `cordis` is green, merge it into `main`, synchronize legacy
`main` back into `cordis`, or treat an urgent issue as authority to bypass the freeze.
Legacy incidents must use their separately authorized original-project workflow.

The future cutover delivery must restore the normal **`staging` → `main` PR** process only
after the explicit authorization and preservation/verification steps at the top of this skill.
That future process must include exact candidate/version/changelog custody, required complete
checks and artifact smoke, reviewed PR promotion, protected production publication and actual
release read-back. Agents may not approve or merge `main` under current permissions. No direct
production commit, automatic promotion or cleanup-driven branch replacement is permitted.

## ⚠️ MANDATORY: Closing Issues at Release

Migration feature/fix PRs use `Part of #N`; integration into `cordis` is not a production
release. Keep issues open with verified criteria/progress in their bodies. Do not change the
default branch, add closing keywords or manually close a delivered issue to bypass that rule.
Invalid/won't-fix issues may be closed with an explanation.

After authorized cutover, restore release closure through the `staging` → `main` PR. Derive
its issue list mechanically from the exact shipping PR range, verify repository/default-branch
closing semantics, hold every issue with unchecked criteria and name its deficit. Retain
migration PR/issue links across cutover. A squash merge preserves the issue reference in the
PR title `(#N)`; do not assume branch ancestry or memory identifies the released changes.
Read back both actual released artifacts and issue states before claiming closure.

## Large Changes: Avoiding CI Bottlenecks

When a change is too large for one PR (huge refactor, major feature):

1. **Decompose into stacked PRs.** Each is independently mergeable to `cordis` and passes CI alone; later PRs build on earlier ones.
   ```
   PR 1: refactor(core): extract module X (no behavior change)
   PR 2: refactor(core): update callers of X        (depends on PR 1)
   PR 3: feat: new capability using refactored X    (depends on PR 2)
   ```
2. **Each PR targets `cordis`.** Merge sequentially only after each PR satisfies all four
   integration gates above: green CI, verified acceptance criteria, testing boxes supported
   by actual CI evidence, and addressed review under the repository's reviewer policy.
3. **Reference the parent issue in all PRs** (task lists or links in the body).
4. **Never hold a long-lived branch that diverges from `cordis`.** Merge `cordis` in at least daily for multi-day work.
5. **If one PR would take >15 minutes of CI, split it.** Rapid feedback beats batching.

## Migration Integration Hygiene

- `cordis` must satisfy the currently implemented contract; fixing a broken required gate is
  the first integration priority. Never claim unfinished future tasks are already deployable.
- Fetch/verify `origin/cordis` before branching and before merging; sync only that integration
  ref into migration features. Legacy branches may continue moving without migration syncing them.
- Never force-push, rename or delete `cordis`, `staging` or `main` as routine migration work.
- Do not run original checkout deployment/reconciliation commands or interfere with its services.
- Configure future migration CI to validate allowed PR base/source and isolated artifact
  destinations before enabling deployment; prose is not evidence of an enforced repository gate.

## Commit Message Conventions

Conventional commits, for automated changelog extraction:

```
feat: add pluggable provider registry (#42)
fix: correct search scoring when symbols absent (#38)
refactor: extract resolver into its own module (#45)
test: add unit tests for scoring boost (#42)
docs: update README with provider setup notes (#42)
chore: bump build toolchain dependency (#46)
1.4.2   ← version-bump commit (matches the project's tag format)
```

The type prefix (`feat`, `fix`, `refactor`, `test`, `docs`, `chore`) drives release-notes grouping. Always reference the issue number in parentheses. Keep the subject imperative and ≤ ~72 chars; put detail in the body.

**Squash-merge vs. per-layer commits — how both survive.** Feature branches keep incremental conventional commits (docs, test, fix) for reviewability *during* development. On squash-merge to `cordis`, those collapse into one commit, so the changelog is written from **the PR title and merged PR list, not from individual branch commits** — which is why the PR title must itself be a valid conventional-commit subject (`fix: ... (#91)`). If a project extracts its changelog from raw `git log` on `main` instead of the PR list, use a merge commit rather than squash for that PR and confirm with the maintainer before choosing. Never let the two mechanisms disagree silently: pick one, record it in the project config.

## Changelog Convention

Every project maintains a `CHANGELOG.md` at the repository root. This is non-negotiable.

### Format

Follow [Keep a Changelog](https://keepachangelog.com/) structure:

```markdown
# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]
### Added
- Description of new feature (#<issue>)

### Fixed
- Description of bug fix (#<issue>)

## [1.0.0] - 2026-10-18
### Added
- Initial release
```

### Rules

1. **Entries come from PR titles, not individual commits.** Since feature PRs are squash-merged, each merged PR produces exactly one changelog entry. The PR title IS the changelog line.
2. **Group by type.** Use the conventional commit prefix to sort entries under the correct heading:
   - `feat:` → **Added**
   - `fix:` → **Fixed**
   - `refactor:` → **Changed**
   - `docs:` → **Documentation** (optional section; include if docs changes are user-visible)
   - `chore:`, `test:` → omit unless user-facing
3. **Always include the issue number.** Every changelog entry ends with `(#<issue>)`.
4. **Keep migration changes under `[Unreleased]`.** Versioned release sections resume only through the authorized post-cutover release process; no production RC is created now.
5. **[Unreleased] is always present.** New entries land under `[Unreleased]` during normal feature work. At release time, `[Unreleased]` is renamed to the new version and date, and a fresh empty `[Unreleased]` section is added above it.
6. **Separate project repositories:** each owner maintains its own `CHANGELOG.md`. Platform records integration changes with the owning project prefix; its entry cannot replace owner entries/commits/releases.
7. **Write for humans, not parsers.** Each entry is one readable sentence describing what changed and why it matters. Not a commit hash dump.

### When to Add Entries

Add a changelog entry whenever your PR introduces a user-visible or developer-visible change. Internal refactors with no external impact can be omitted. When in doubt, include it — it is easier to trim a changelog than to reconstruct missing history.

## Evidence Before Claims

This workflow's gates are claims until verified. Apply `verification-before-completion` at every one of them:

| About to say | Requires (run it, read the output) | Not sufficient |
|---|---|---|
| "Tests pass" | `<test command>` output showing 0 failures, this session | Last run, "should pass" |
| "CI green" | `gh pr checks <N>` showing all pass | Assuming the push fixed it |
| "Docs updated" | Diff showing the doc file changed | Intent to do it later |
| "Acceptance criteria met" | Each checkbox re-checked against reality | Copying them over from the issue |
| "Ready to merge" | Green CI **+** all boxes checked **+** review addressed | Green CI alone |
| "Release published" | `gh release view <version>` / pipeline run succeeded | Tag pushed |

Checking a PR's testing box before reading the CI result is a false claim, not a shortcut.

## Agent Loop Guard (MANDATORY)

Agents must not repeat the same action without progress. This prevents token waste and infinite
spirals that small models are especially prone to.

**The rule:** If the same tool call, command, or message has been attempted **3 times** with the
same (or functionally equivalent) result, the agent MUST stop retrying and instead:

1. **Diagnose** why the repetition is not producing progress.
2. **Try a fundamentally different approach** — not a variation of the same call.
3. **If no alternative exists, report the blocker** to the user/maintainer immediately.

**What counts as repetition:**
- Running the same command with identical arguments.
- Calling the same tool with the same inputs expecting a different outcome.
- Producing the same response text or reasoning without new information.
- Re-reading the same file without acting on its contents.

**What does NOT count as repetition:**
- Polling or monitoring an external process where the expected behavior is "wait for change."
- Iterating through a known finite list (e.g., checking each file in a directory).
- Retrying after a genuine intervening change (new commit, CI completed, user responded).

**Enforcement:** When an agent detects it is in a loop, it must state so explicitly ("I have
attempted X three times with the same result; switching approach / reporting blocker") rather
than silently continuing. Silence during a loop is the failure mode this rule prevents.

## Red Flags — STOP

These mean you have left the workflow; fix it before continuing:

- Writing code with no issue, or directly on `cordis`/`staging`/`main`
- Code committed before its docs or tests
- Uncommitted work carried across a session
- About to merge while CI is red, or with unchecked acceptance criteria
- About to check a testing box you have not verified against a real run
- Approving or merging a PR to `main` as an agent
- Creating migration production RC/hotfix PRs or production tags/releases before cutover
- Long-lived branch that has not synced `cordis` recently
- Reporting "tests pass" when the assembled artifact was never executed
- A seam or CLI whose only tests inject fakes, leaving production wiring untested
- A documented capability with no failing test written before its implementation
- Writing "X cannot do Y" without searching, or from one spike whose configuration you did not record
- Accepting a search snippet as fact and shipping it without re-testing
- A task-owned merged branch left behind without a documented retention/unlanded-work/checkout reason (see Post-Merge Branch Cleanup)
- A `Closes #N` in a `cordis` PR body, which cannot fire and reads as done when it is not
- A release candidate whose closing list was written from memory instead of derived from the merged PRs
- An issue closed by a release while it still has an unchecked acceptance criterion
- Deleting a branch because its name looks stale, without confirming a merged PR and no open PR
- Syncing legacy `staging`/`main` into migration work, or treating completion as cutover approval
- Same tool call or command repeated 3+ times without progress (see Agent Loop Guard)

## Quick Reference

| Action | Command or rule |
| --- | --- |
| Start feature | Fetch/verify exact `origin/cordis`, then `git switch -c feature/N-desc origin/cordis` |
| Sync integration into feature | `git fetch origin cordis` then verify remote SHA and `git merge origin/cordis` |
| Open migration PR | `gh pr create --base cordis --title "feat: description (#N)" --body-file <body.md>`; body includes `Part of #N` |
| Check CI | `gh pr checks <N> --watch`; missing required CI is unproven, not green |
| Inspect failed CI | `gh run view <id> --log-failed` |
| Merge eligible migration PR | Verify base `cordis`, exact head, green required gates and addressed review, then `gh pr merge <N> --squash` |
| Cleanup | Follow task-scoped Post-Merge Branch Cleanup; protect `cordis`, `staging`, `main` and unrelated work |
| Read live refs | `git ls-remote --heads origin` |
| Prove program runs | Build, execute actual artifact, assert effects/output/exit status |
| Update issue/PR | Edit body with actual evidence; no assumed checkboxes |
| Production RC/hotfix/tag/release | Blocked during migration; no executable production command here |
| Restore staging/main release path | Separate reviewed cutover plan + explicit maintainer execution authorization; update policy/settings/CI together |
