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

Provider credentials enter only as process environment authority. They are not
rendered into configuration, workspaces, plan summaries, logs, or receipts.
Production state must use an encrypted remote S3-compatible backend with
credentials supplied separately to OpenTofu. Local state is not an accepted
production mode.

Every execution uses the following closure:

1. Validate the SDK plan and resolve only declared non-secret inputs.
2. Render a deterministic workspace and bind it to an exact bundle digest.
3. Download immutable artifacts and verify their SHA-256 digests.
4. Initialize with the checked-in provider lock, import reviewed existing
   resources, validate, and save a binary OpenTofu plan.
5. Record the binary plan digest alongside the SDK and bundle digests.
6. Apply only that unchanged binary plan after exact environment approval.
7. Perform authoritative provider read-back through the Deployment runner and
   issue the SDK known-good receipt only when all desired digests match.
8. Repeat planning and require no changes.

All managed resources prohibit replacement. Rollback is a separately approved
operation restoring the prior known-good state lineage; it is not an implicit
destroy.
