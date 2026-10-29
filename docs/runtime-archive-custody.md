# Runtime archive custody

Deployment owns `RuntimeArchiveCustody` at `@treeseed-cordis/deployment/runtime-archive`.
`await RuntimeArchiveCustody.open({path, sha256, size}, signal)` admits one canonical absolute,
owner-private regular Zstandard file up to 2 GiB through descriptor-anchored no-symlink access.
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
