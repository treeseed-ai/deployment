# Runtime archive custody

Deployment owns `RuntimeArchiveCustody` at `@treeseed-cordis/deployment/sandbox`.
`await RuntimeArchiveCustody.open({path, sha256, size}, signal)` admits one canonical absolute,
owner-private regular file with Zstandard frame magic, up to 2 GiB, through descriptor-anchored
no-symlink access.
It streams SHA-256 in 1 MiB chunks, verifies exact declared size and the Zstandard frame magic,
and retains the verified file and directory descriptors. It never extracts, imports or executes
archive contents, opens a daemon, or creates installation records.

`proof` returns only immutable `{sha256, size}` data. `verify()` rechecks the retained descriptor,
current directory ancestry and named entry: device/inode, size, links, owner, permissions and
modification/change times must remain identical. It does not rehash a gigabyte for every host
operation. File replacement (even with identical bytes), in-place changes, chmod, hardlinks,
symlink substitution and directory replacement fail safely. `close()` releases both descriptors;
subsequent verification fails. Cancellation is checked before and after hashing and before return.
The common `SafeDirectory.hash` uses the same verified-descriptor hashing implementation so OCI
and runtime verification do not diverge. Preserve its existing error contracts and all callers.

Errors carry fixed KATA_RUNTIME_ARCHIVE_INVALID, KATA_RUNTIME_ARCHIVE_CHANGED,
KATA_RUNTIME_ARCHIVE_CLOSED or KATA_CANCELLED codes, with no path, archive bytes or provider text.
Successful hashing verifies artifact identity/custody only. It does not validate tar contents,
prove runtime compatibility, associate binaries with that kit, advertise a SandboxResourceProfile
or admit a pool base. The following native-backend slice must retain this custody for the actual
pinned Kata kit and qualify its lifetime on hosted Ubuntu/KVM. Component/configuration and policy
bindings remain separate required evidence; no digest of metadata substitutes for archive bytes.

Implementation plan for #1021: documentation commit; missing built public-module acceptance;
real file-boundary cases; shared descriptor and archive wrapper; full owner checks/build/tier
suites, genuine public archive consumer and current-head hosted qualification. The small genuine
Zstandard frame in tests is explicitly an artifact-identity fixture, not a Kata runtime. No VM or
daemon runs on the workstation; no test relaxes the preceding physical resource gates.
Work/models remain Task 10 and every issue stays open.

## Native Kata backend lifetime

The trusted `KataSandboxPlugin.Config.runtime` may additionally contain
`archive: {path, sha256, size}`. When selected, `KataSandboxBackend.open` admits that exact
archive before daemon qualification or host-store publication. The endpoint retains custody
for its whole lifetime and verifies the file/directory identities before and after runtime
commands, sandbox admission and read-back. The archive hashes once at construction; subsequent
operations use retained identity checks. A changed archive fences further host operations.

Failed construction releases archive and directory descriptors without publishing store state.
Successful disposal first verifies the empty runtime namespace, then closes retained custody.
Uncertain cleanup remains a failure requiring explicit repair; archive tampering cannot become
successful activation or cleanup. The complete configured archive identity also participates in
the existing configuration digest. Omitting this optional field preserves historical behavior.

This is exact artifact custody alongside independently pinned shim, hypervisor and configuration
hashes. It does not yet prove those components were extracted from the kit, bind kernel/rootfs
and policy into a complete profile, or advertise pool readiness. No metadata hash substitutes
for actual kit bytes. Those remaining associations are required before profile admission.

Hosted positive qualification must use the real 969565384-byte Kata 4.1.0 amd64 Zstandard kit,
SHA-256 `3dc6b69c4acb787b967b04b64599a20d02a8beb1a8eaab3084110df9d0b08c96`.
Copy the runner-owned download into the root fixture's private directory, set mode 0600 and let
the backend hash it. Do not weaken ownership or pretend the runner checkout is root-private.
Every preceding actual Kata/setup/guest/resource/teardown gate remains enabled. Built public
configuration acceptance runs without a VM; real native lifetime qualification runs only on
trusted exact-head hosted Ubuntu/KVM. Delivery follows documentation, outside-in tests,
implementation, owner/public-archive gates and full hosted review. All issues stay open.
