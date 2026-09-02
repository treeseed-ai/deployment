# Hosted infrastructure reconciliation

Deployment is the sole implementation owner for TreeSeed system, packaging,
and hosted infrastructure behavior. The SDK defines portable plans and
approval/receipt schemas. API authorizes and schedules operations. Platform
declares topology. Neither API nor Platform implements a provider client.

The hosted runner uses OpenTofu 1.12.6 with exact provider locks:

- Cloudflare `cloudflare/cloudflare` 5.24.0 from the OpenTofu registry.
- Railway `jamesprnich/railway` 0.11.5, executed by OpenTofu. It is a community
  provider and therefore remains behind Deployment
  contract and disposable-project acceptance tests.

Provider credentials, state-backend sessions, and state-encryption keys resolve only through the TreeSeed
service credential vault. Each vault request binds the exact team connection,
deployment, stack, backend digest, credential profile, capability set,
authority version, purpose, and `staging` or `production` environment. Raw caller-supplied process environments are not an
executor interface. Deployment alone maps validated in-memory material into a
minimal, short-lived OpenTofu process environment. Cloudflare runtime and DNS
tokens use separate provider aliases, so their least-privilege profiles need
not share a token. Credentials are not rendered into configuration,
workspaces, plan summaries, logs, or receipts.
State uses an encrypted remote S3-compatible backend with a key derived by the
SDK, never accepted from a caller:

```text
teams/<teamId>/opentofu/v1/deployments/<deploymentId>/environments/<environment>/stacks/<stackId>/terraform.tfstate
```

The backend receives a separately scoped session token valid for no more than
one hour. OpenTofu native S3 locking is mandatory. A separate short-lived vault
authority supplies the 32-byte client-side encryption key; both state and plan
encryption are enforced. Local state and OpenTofu workspace-based tenant
isolation are not accepted modes.

Every execution uses the following closure:

1. Discover existing resources through Deployment-owned read-only provider
   adapters, validate the SDK plan, and resolve only declared non-secret inputs.
2. Render a deterministic workspace and bind it to an exact bundle digest.
3. Download immutable artifacts and verify their SHA-256 digests.
4. Initialize with the checked-in provider lock, import reviewed existing
   resources, validate, and save a binary OpenTofu plan.
5. Record the binary plan digest alongside the SDK and bundle digests.
6. Bind the plan to the versioned vault authorities, apply only that unchanged
   binary plan after exact environment approval, and delete it after use.
7. Perform authoritative provider read-back through the Deployment runner and
   issue the SDK known-good receipt only when all desired digests match.
8. Repeat planning and require no changes.

All managed resources prohibit replacement. Rollback is a separately approved
operation restoring the prior known-good state lineage; it is not an implicit
destroy.
