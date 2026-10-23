---
name: gh-cli
description: Use when a GitHub operation requires CLI fallback or the user asks about gh commands.
metadata:
  whenToUse: When a connected GitHub tool lacks the required operation or an existing repository script requires gh.
---

# GitHub CLI (gh)

Use connected GitHub tools first; use these CLI examples when the required operation is
unavailable there or an existing repository script requires `gh`. Read AGENTS.md and
[release-workflow](../release-workflow/SKILL.md) before mutations. Command availability
does not grant authority. Never print authentication tokens.

Migration PRs target `cordis` from issue branches off verified `origin/cordis`. Never approve
a PR, promote migration changes to `staging`/`main`, or publish production releases/tags.
Check CI, acceptance evidence and addressed review before any eligible `cordis` merge;
green CI alone is insufficient. Preserve integrated issues until the authorized release;
invalid/won't-fix closure requires a recorded reason. Do not close issues because of age.

**Prerequisites:** `gh` must be installed and authenticated (`gh auth status` to verify).

## Authentication

```bash
gh auth status                    # Check current auth
gh auth login                     # Interactive login
gh auth switch                    # Switch between accounts
```

## Repositories

```bash
gh repo view [<repo>]             # View repo details
gh repo clone <repo>              # Clone a repository
gh repo create [<name>]           # Create new repo
gh repo fork <repo>               # Fork a repository
gh repo list [<owner>]            # List repos
gh repo set-default <repo>        # Set default repo for commands
gh repo rename <new-name>         # Rename repository
gh repo archive [<repo>]          # Archive a repository
gh repo delete [<repo>]           # Delete (requires --yes)
```

## Issues

```bash
gh issue list                     # List open issues
gh issue view <number>            # View issue details
gh issue create                   # Create new issue (interactive)
gh issue create --title "..." --body "..." --label "bug"  # Non-interactive
gh issue edit <number>            # Edit issue metadata
gh issue comment <number> --body "..."  # Add comment
gh issue reopen <number>          # Reopen an issue
gh issue pin <number>             # Pin an issue
gh issue transfer <number> <dest-repo>  # Transfer to another repo
gh issue search "query"           # Search issues (--state, --label, --assignee)
gh issue status                   # Issues assigned to you or mentioning you
```

## Pull Requests

```bash
gh pr list                        # List open PRs
gh pr view <number>               # View PR details + diff summary
gh pr create --base cordis --title "fix: description (#N)" --body-file <body.md>
gh pr checkout <number>           # Check out a PR branch locally
gh pr merge <number>              # Merge a PR (--merge, --squash, --rebase)
gh pr review <number> --comment --body-file <review.md> # Only if review posting is authorized
gh pr diff <number>               # Full diff of a PR
gh pr checks <number>             # View CI status for a PR
gh pr ready <number>              # Mark as ready for review
gh pr edit <number>               # Edit PR metadata (--title, --body, --add-label, etc.)
gh pr close <number>              # Close without merging
gh pr status                      # PRs relevant to you
```

## Actions & Workflows

```bash
gh run list                       # Recent workflow runs
gh run view <run-id>              # View run details
gh run view <run-id> --log        # Full logs
gh run view <run-id> --log-failed # Only failed step logs
gh run watch <run-id>             # Watch a run live
gh run rerun <run-id>             # Rerun a failed workflow
gh run cancel <run-id>            # Cancel a running workflow
gh workflow list                  # List workflows
gh workflow run <workflow>        # Trigger a workflow manually
gh workflow enable/disable <wf>   # Enable or disable a workflow
```

## Releases

```bash
gh release list                   # List releases
gh release view <tag>             # View release details
gh release download <tag>         # Download release assets
```

## Projects (v2)

```bash
gh project list                   # List projects
gh project view <number>          # View project details
gh project item-list <number>     # List items in a project
gh project item-add <number>      # Add issue/PR to project
gh project item-edit              # Edit item fields
```

## API (Advanced)

```bash
gh api <endpoint>                 # Direct REST API call
gh api repos/{owner}/{repo}       # Example: get repo info
gh api graphql -f query='...'     # GraphQL queries
gh api repos/{owner}/{repo}/commits --paginate  # Paginated results
```

## Output Formatting

```bash
gh <command> --json field1,field2 # JSON output (select fields)
gh <command> --jq '.[].name'      # jq filter on JSON output
gh <command> --template '{{range .}}{{.name}}{{"\n"}}{{end}}'  # Go template
gh <command> --limit N            # Limit result count
```

## Common Patterns

### Check CI before merging

These commands inspect readiness. Merge only under release-workflow's full gates; never
approve. PR bodies use `Part of #N`, with actual testing evidence and acceptance criteria.

```bash
gh pr checks <number> --watch     # Wait for CI to finish
gh pr view <number> --json baseRefName,headRefOid,reviewDecision,statusCheckRollup
```

### Bulk operations
```bash
gh issue list --json number,title --jq '.[] | "\(.number): \(.title)"'
```

### Create issue from context
```bash
gh issue create --title "fix: description" --body-file <description.md> --label bug
```

### Sync fork
```bash
gh repo sync <fork>               # Sync fork with upstream
```

## Tips

- Use `--json` + `--jq` for scriptable output instead of parsing text.
- Most commands accept `<owner>/<repo>` or use the default repo (`gh repo set-default`).
- Always pass `--base cordis`; do not rely on the repository's legacy default branch.
- Supply multiline issue/PR/comment text with `--body-file`; preserve issue references.
- Release commands here are read-only; future cutover/publication uses a separately reviewed workflow.
- `gh run view --log-failed` is the fastest way to diagnose CI failures.
- For paginated results, add `--paginate` to `gh api` calls.
- `gh search issues/prs/repos/code` searches across all of GitHub, not just one repo.
