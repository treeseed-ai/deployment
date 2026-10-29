# Private installation record custody

API owns seed planning/reconciliation and its single seed journal. Deployment already owns
installation receipts, private filesystem identity, writers and atomic publication. Extend that
same-repository capability with public `InstallationRecords`, without moving seed meanings or
authority into Deployment. A typed API seed-journal plugin will consume this pure custody helper
beneath its native Cordis root. It is not another dependency container or a security sandbox.

## Public interface

`InstallationRecords.acquire(scope, signal)` returns an exclusive namespace custody object.
`scope` is closed data: installationId, canonical absolute installationDirectory and a bounded
namespace slot. Require an existing valid format-3 installation receipt and plans. Missing,
foreign, malformed or incompatible installation state blocks without creating it. On a fresh
seed, a verified non-activating host-composition plan establishes that receipt first; validation
blockers and read-only inspection create no record area. Never activate a managed service.

Records live under `.cordis/artifacts/records/<namespace>`. API selects `seeds`; other capability
owners may select their own scope. Bind the immutable namespace marker to the exact installation
receipt digest, installation identity/directory, namespace, owner UID and custody format version.
An existing empty/incomplete namespace is uncertain state, not something to initialize silently.

`InstallationRecords.inspect(scope, signal)` reads an existing stable namespace without
creating state. It rejects any held/stale namespace writer explicitly; it never removes one.
The acquired object exposes:
- `read(): Promise<readonly InstallationRecord[]>`: verify and return the complete immutable
  canonical chain, without reopening original release/seed bundles.
- `append(expectedHead: string | null, content: unknown): Promise<InstallationRecord>`: validate
  bounded canonical JSON, compare the current verified chain head, publish one complete record
  without overwriting any file, then read back and compare exact canonical bytes/digest/scope.
- `close(): void`: verify and release only its own namespace writer and descriptors. Refuse while
  an operation is pending; callers await that operation (including cancellation) before closing.
  Retain failed-close status; a later close cannot turn uncertain cleanup into success.

Each record carries custody formatVersion 1, scopeDigest (the namespace marker's digest),
sequence, previousDigest, content and digest. Sequence starts at one; names use eight decimal
digits, a hyphen, the record digest and `.json`. Snapshot scope/content before the first
asynchronous boundary; later caller mutation cannot change accepted bytes or their identity.
The digest includes namespace/installation receipt binding. Use canonical sequence/digest names,
maximum 4096 records and one MiB per record; reject noncanonical/duplicate/unknown envelope fields,
unsafe keys, wrong hashes, gaps, forks and extra entries. API owns content schemas, idempotency,
receipts, partial/recovery meanings and authority checks. The storage helper performs no domain
reconciliation and must never log content, credentials, paths or raw exceptions.

## Ownership, publication and recovery

Require owner-private 0700 directories and 0600 marker/record/writer files; reject symlinks,
hardlinks, foreign owners and replaced ancestors/files through retained checked descriptors.
Verify the installation receipt, namespace marker and identities before/after operations. Use
one exclusive namespace writer, separate from Deployment's live host writer; no raw runtime
socket or credential access. Concurrent acquisition fails explicitly. Never remove stale writers
or adopt interrupted initialization/publication automatically. An interrupted operation may leave
private incomplete state; return failure and require explicit repair rather than overwrite it.

Bound asynchronous chain reads with genuine event-loop turns, preserving protocol responsiveness
as record counts grow. Methods on one custody object are serialized by admission: overlapping
read/append calls fail busy. Cancellation fails safely, releases no writer prematurely and cannot
report an unpublished record as accepted. After any publication uncertainty, reject further writes
on that custody object; preserve the complete/incomplete bytes for explicit recovery/read-back.

Public failures expose only fixed `INSTALLATION_RECORDS_INVALID`, `INSTALLATION_RECORDS_BUSY`,
`INSTALLATION_RECORDS_CHANGED`, `INSTALLATION_RECORDS_CANCELLED`, `INSTALLATION_RECORDS_CLOSED`,
`INSTALLATION_RECORDS_WRITE_FAILED` or `INSTALLATION_RECORDS_CLOSE_FAILED` categories. Missing
read-only state is invalid; no path, raw error or content is included in the exception message.

## Verification and delivery

Documentation precedes a genuine built public program, real filesystem/installation boundaries,
format computations and implementation. Cover clean plan-only construction and read-back after
bundle removal, modes, duplicate/concurrent/stale writers, expected-head conflict, interrupted
initialization/publication, symlink/ownership/mutation/replacement, cancelled/overlapping operations,
canonical hash/sequence/scope validation, secret-output canaries and failed disposal.

Keep new/changed methods at most twenty formatted body lines, tests in behavior-named tiers and
owner builds independent. Inventory: this document, CHANGELOG, one custody module/public export,
package identity, acceptance/integration/unit/support specifications (at most ten files). Full
owner/public archive/hosted/review gates precede acceptance; API integration remains a separate
owner slice. No legacy/production change or Work/model execution. Every issue remains open.
