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
CI stages one root-owned mode-0600 copy at
`/opt/kata/kata-static-4.1.0-amd64.tar.zst` after checking the download hash/size. Each backend
independently hashes that exact disk file. Keep this large shared artifact out of the per-case
`/run` directories; repeated gigabyte copies could exhaust tmpfs. Let the backend enforce custody. Do not weaken ownership or pretend the runner checkout is root-private.
Every preceding actual Kata/setup/guest/resource/teardown gate remains enabled. Built public
configuration acceptance runs without a VM; real native lifetime qualification runs only on
trusted exact-head hosted Ubuntu/KVM. Delivery follows documentation, outside-in tests,
implementation, owner/public-archive gates and full hosted review. All issues stay open.

## Read-only runtime kit member proof

`await custody.inspect(paths, signal)` resolves at most sixteen unique canonical `opt/kata/…`
member paths in the retained archive and returns immutable, sorted owner data:
`{formatVersion:1, archive:{sha256,size}, members:[{requestedPath,path,size,mode,sha256,links}]}`.
Each link is `{path,target}` and the terminal path must be a regular file. The same public sandbox entry exports `RuntimeKitMember` and `RuntimeKitMembers` types.
This is an owner artifact inspection contract; SDK resource profiles and cross-process messages remain SDK-owned.

The complete Zstandard tar stream is inspected without extraction, imports, scripts or runtime
execution. All regular bytes are hashed while streaming, including targets occurring before
selected symlinks. Bound the archive to 4096 entries, 8 GiB of declared and observed regular data,
9 GiB of total decoded tar bytes and a 64:1 decompression ratio.
Require complete compressed-byte consumption; ignored bytes after a Zstandard frame fail. Ordinary file, directory and symbolic-link entries plus bounded GNU next-path/next-link controls
are supported. Each GNU control contains one canonical ASCII value and exactly one terminal NUL,
fits 4097 bytes, occurs at most once per kind before its target, and must be consumed by an ordinary
entry. Reject PAX, unknown, empty, oversized, duplicate or dangling metadata controls. Count raw headers
and validate complete body framing and two zero footer blocks before accepting the proof.
Bytes after the tar footer must be zero padding. Entries use canonical relative symbolic links without parent segments beneath `opt/kata`; only directory ancestors `.` and
`opt` are additionally allowed. Reject duplicate/unsafe names, special entries, hardlinks,
unsafe permissions, malformed/truncated streams and paths beneath a file/symlink ancestor.
Never expose archive member bytes, caller paths or parser diagnostics in errors.
Paths use slash-separated ASCII letters/digits, dots, underscores, plus or hyphen; at most
4096 characters and 64 segments, with no empty, dot or parent components. The structural
parser/hash/link checks form one coherent artifact-admission invariant that providers cannot
bypass. Native runtime selection remains the typed Kata sandbox provider seam.

Selection resolves symbolic links only inside the archive's namespace, never the host filesystem.
Reject missing targets, selected directories, duplicate/empty/noncanonical selections and cycles;
limit resolution to sixteen links. Unselected dangling links may be retained as metadata because
nothing is extracted or followed. Only requested paths and their resolved exact file identities
are returned; unrelated inventory remains private. Freeze all returned objects and arrays.

Snapshot paths before asynchronous work, verify retained file/directory identities before and
after streaming, honor cancellation and fence closed/tampered custody. Use fixed safe codes
`KATA_RUNTIME_KIT_INVALID`, `KATA_RUNTIME_ARCHIVE_CHANGED`, `KATA_RUNTIME_ARCHIVE_CLOSED` and
`KATA_CANCELLED`. Failed inspection publishes no state and leaves custody available for explicit
close. The read stream owns a duplicate descriptor; it cannot close the retained primary.

Delivery: documentation → built public inspection acceptance → real archive/file-boundary cases
→ bounded implementation → full owner checks/build, all tiers, genuine archive consumer and
current-head hosted gates. Genuine small tar/Zstandard fixtures are explicitly test artifacts;
the pinned upstream Kata kit also receives read-only Node and Bun inspection, with exact member
hash/size/mode and link-edge read-back. No daemon or VM is needed for these inspection cases.
This adds member provenance only; matching installed components, TOML configuration, kernel/rootfs,
firmware/isolation and complete SDK profile admission remain required before pool readiness.

Decoder qualification: [Bun documents rejectGarbageAfterEnd](https://bun.com/reference/node/zlib/createZstdDecompress),
but exact Node 24.22.1 and Bun 1.4.4 probes differ: with one complete sixteen-byte compressed
frame plus seven trailer bytes, Node rejects with that option while Bun accepts. Both report
only sixteen consumed bytes through `bytesWritten`. Inspection therefore verifies consumed bytes
against the pinned archive size instead of relying on the option. The permanent genuine trailer
case must pass in the actual Node program and Bun integration suite. No stream size option is
mistaken for a streaming expansion bound; the reader counts all decoded and regular bytes.

The pinned upstream kit contains 171 ordinary entries and two GNU long-path controls for the
NVIDIA SNP/TDX configuration filenames. A strict read-only tar@7.5.22 / Node 24.22.1 probe
records both controls and no ignored entries. Preserve these real required forms; rejecting
all metadata would incorrectly reject the exact qualified kit. A shared-header framing guard
counts ordinary and control entries, checks complete 512-byte framing and footer padding, and
only then feeds the same upstream tar parser. GNU controls cannot override payload sizes.
