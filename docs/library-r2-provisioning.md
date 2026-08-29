# Library R2 provisioning

TreeSeed provisions each team's private library bucket and runtime credentials through the host manager. The operator supplies the deployment bootstrap token once through a masked prompt. It is retained only in manager-owned credential custody so later reconciliation, rotation, and additional project setup do not require it again. It is never installed into an application component.

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

1. Creates `treeseed-team-<team-id-prefix>-library` if absent.
2. Fails if its `r2.dev` domain or any custom domain is public.
3. Creates an account-read-only privacy-verifier token.
4. Creates an object-read/write publisher token scoped to that bucket only.
5. Derives the publisher's S3 credentials according to Cloudflare's R2 token contract.
6. Installs the bootstrap authority into isolated manager custody and the child credentials into runtime secret custody.
7. Reconciles the generated host-configuration generation automatically.

Use `trsd host storage status` for local custody status, `trsd host storage reconcile` for an idempotent repair, and `trsd host storage rotate cloudflare-r2` to roll both child credentials. None of these commands requires a team UUID because the CLI uses the active team.
