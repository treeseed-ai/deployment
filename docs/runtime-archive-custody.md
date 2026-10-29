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

## Read-only runtime kit member proof

`await custody.inspect(paths, signal)` resolves at most sixteen unique canonical `opt/kata/…`
member paths in the retained archive and returns immutable, sorted owner data:
`{formatVersion:1, archive:{sha256,size}, members:[{requestedPath,path,size,mode,sha256,links}]}`.
Each link is `{path,target}` and the terminal path must be a regular file. This is an owner
artifact inspection contract; SDK resource profiles and cross-process messages remain SDK-owned.

The complete Zstandard tar stream is inspected without extraction, imports, scripts or runtime
execution. All regular bytes are hashed while streaming, including targets occurring before
selected symlinks. Bound the archive to 4096 entries, 8 GiB of declared and observed regular data,
64 KiB extended metadata, 9 GiB of total decoded tar bytes and a 64:1 decompression ratio.
Require complete compressed-byte consumption; ignored bytes after a Zstandard frame fail. Entries may be ordinary files,
directories or canonical relative symbolic links without parent segments beneath `opt/kata`; only directory ancestors `.` and
`opt` are additionally allowed. Reject duplicate/unsafe names, special entries, hardlinks,
unsafe permissions, malformed/truncated streams and paths beneath a file/symlink ancestor.
Never expose archive member bytes, caller paths or parser diagnostics in errors.

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
