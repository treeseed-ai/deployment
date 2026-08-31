# Library R2 provisioning

TreeSeed provisions one private library bucket per control-plane environment and runtime credentials through the host manager. Production uses `treeseed-library`; development integration uses `treeseed-dev-library`. The operator supplies the deployment bootstrap token once through a masked prompt. It is retained only in manager-owned credential custody so later reconciliation, rotation, and destructive reset do not require it again. It is never installed into an application component.

The bootstrap token needs these account permissions for the target Cloudflare account:

- `Account API Tokens Write`
- `Workers R2 Storage Write`

Select the team normally, then connect the host:

```sh
trsd teams use <team>
trsd host storage connect cloudflare-r2
```

If the bootstrap token reaches multiple Cloudflare accounts, add `--account-id <cloudflare-account-id>`. The token is entered only when prompted and must never be placed in shell history.

The operation deterministically:

1. Creates `treeseed-library` for production or `treeseed-dev-library` for development integration if absent.
2. Fails if its `r2.dev` domain or any custom domain is public.
3. Creates an account-read-only privacy-verifier token.
4. Creates an object-read/write publisher token scoped to that bucket only.
5. Derives the publisher's S3 credentials according to Cloudflare's R2 token contract.
6. Installs the bootstrap authority into isolated manager custody and the child credentials into runtime secret custody.
7. Reconciles the generated host-configuration generation automatically.

TreeDX content is mirrored as current files, not archives or version history:

```text
teams/<team-id>/projects/<project-id>/<repository-relative-path>
```

Only a canonical `main` production commit or `staging` development-integration commit may update a mirror. Changed files are overwritten in place, new files are added, deleted repository files are deleted, and unchanged objects are retained. Git and TreeDX remain the only version-history systems. Internal current-state manifests live outside the content tree at `_treeseed/mirrors/teams/<team-id>/projects/<project-id>/manifest.json`; they contain paths and digests for incremental synchronization and verification, not duplicate content.

Use `trsd host storage status` for local custody status, `trsd host storage reconcile` for an idempotent repair, and `trsd host storage rotate cloudflare-r2` to roll both child credentials. A contaminated bucket can be destructively emptied, deleted, and recreated with:

```sh
trsd host storage reset cloudflare-r2 --environment staging
trsd host storage reset cloudflare-r2 --environment production
```

Reset requires destructive confirmation and derives the two permitted bucket names internally. None of these commands requires a team UUID because the CLI uses the active team.
