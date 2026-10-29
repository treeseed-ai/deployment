# Installed runtime component custody

Deployment owns installed artifact verification beneath its bounded sandbox provider. The
next component boundary binds selected regular installed files to exact members of an already
verified runtime kit. It extends the existing Deployment artifact/runtime ownership; Agent
continues to own pool admission and execution policy.

`RuntimeComponentCustody.open(archive, bindings, signal)` will borrow an open
`RuntimeArchiveCustody` and retain descriptor-anchored installed-file identities. Each binding
has a unique role, exact kit `member` and canonical absolute installed `path`. One to sixteen
unique role/member/path selections are permitted. Kit inspection resolves only the archive's
bounded links and supplies the regular member's digest, size and original mode. The installed
path must be a regular, single-link, correctly owned file through checked no-symlink ancestors;
its bytes, size and mode must equal the resolved kit member. A declared installed symlink is
rejected. Callers select the resolved regular component path explicitly; proving configuration
aliases and actual runtime references remains a later qualification boundary.

Opening snapshots input before asynchronous work, verifies the borrowed kit, hashes installed
bytes through retained descriptors, rechecks every identity and returns a deeply immutable
proof sorted by role. The proof contains archive/member identities, sizes, modes, hashes and
archive link edges; it omits installed paths and filesystem/process identities. No extraction,
imports, lifecycle scripts, execution, journal, credential or runtime resource is created.

`verify()` rechecks the borrowed archive and each retained installed identity, ownership,
permissions, link count and ancestor. Replacement, chmod, byte changes, path rebinding or
closed borrowed custody cannot silently become accepted. `close()` is idempotent and releases
only the component's own descriptors/directories. It does not close the borrowed archive.
Partial opening releases every acquired descriptor and leaves the caller's archive usable.
Cancellation and all failures expose fixed safe codes, never paths, bytes or exception text.

This coherent artifact invariant is not another dependency container or configurable security
bypass. The typed native sandbox provider remains the plugin seam. A matching component proof
alone establishes no TOML semantics, actual QEMU kernel/rootfs association, isolation policy,
SDK sandbox profile, warm-pool compatibility, guest readiness or host capacity. Those gates
remain required before admitting real pool bases. Work/model execution stays Task 10.

Outside-in verification must run the built public program using genuine Zstandard tar fixtures
and installed files. It covers exact repeat proofs, selected archive links, changed bytes/modes,
symlink ancestors/files, duplicate bindings, cancellation, borrowed/owned lifetimes and safe
failure output. The actual pinned upstream kit plus corresponding installed components remains
a hosted owner boundary; no workstation runtime or daemon may be started to simulate it.
