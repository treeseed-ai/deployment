# Installed runtime alias custody

Deployment owns runtime archive, component and alias custody. Agent consumes the public bounded
sandbox provider; it does not receive arbitrary host paths or raw daemon access. Descriptor custody
is one coherent host invariant beneath that provider, not an additional dependency container.

`@treeseed-cordis/deployment/sandbox` exports `RuntimeAliasCustody` and its immutable proof type.
`await RuntimeAliasCustody.open(components, installationRoot, signal)` borrows a real open
`RuntimeComponentCustody`. That component custody exposes its original, frozen `bindings`: the
role, requested kit member and installed terminal path it actually verified. The alias capability
owns its root/parent directories and symlink descriptors. `verify()` checks the borrowed custody
and every retained/link identity; `close()` releases only owned descriptors. Close failure remains
sticky. Close aliases before closing components and their archive.

The canonical absolute installation root identifies where the trusted `opt/kata/...` member tree
was installed. `/` selects the normal host installation. Each captured component binding must equal
that root joined with its resolved archive member path. All declared links must be present as actual
symlinks under that tree, have root/current-owner identity, and normalize to their declared archive
targets. Regular files, undeclared targets, foreign owners and unsafe parents fail. The capability
never follows arbitrary aliases to acquire a terminal file; component custody already retained and
hashed the terminal descriptor. No generic no-follow policy is relaxed.

Use Linux `O_PATH | O_NOFOLLOW | O_CLOEXEC` to retain each symlink node itself. Parent traversal stays
descriptor anchored and rejects symlink ancestors. Compare retained `fstat` identity with anchored
`lstat` before/after `readlink`, then compare normalized targets. Parent/root identities and captured directory metadata, ownership,
permissions, component custody and link metadata are rechecked throughout lifetime. Hold the symlink
descriptor to prevent deletion/recreation from reusing the original live inode. Root and direct
alias parents must not be group/world writable, including sticky shared parents. Normal trusted
administrator power is outside this process boundary; native Cordis contexts are not a security
sandbox. A qualified runtime still needs actual launch/read-back checks before pool admission.

The proof has kind `kata-installed-aliases`, formatVersion `1`, the exact archive identity,
installation root, original component bindings and sorted absolute `{path, target}` aliases.
Its canonical SHA-256 excludes only its `digest` field. It describes verified paths/targets and
artifact identities; it does not reserve resources or prove VM isolation. Objects/arrays are frozen.
Verification continues to use retained descriptor identities, not a caller-supplied proof.

Opening snapshots all trusted input before awaiting capture, bounds work by the existing sixteen
components/sixteen links per member, checks cancellation between links and yields during capture.
Interrupted or replaced paths are rejected without repair/adoption. Errors contain only fixed
`KATA_RUNTIME_ALIASES_INVALID`, `KATA_RUNTIME_ALIASES_CHANGED`, `KATA_RUNTIME_ALIASES_CLOSED`,
`KATA_RUNTIME_ALIASES_CLOSE_FAILED` or `KATA_CANCELLED` codes; no private paths or nested exceptions.
Opening/verification performs no writes, extraction, imports, scripts, runtime activation or Kata
execution. This alone cannot advertise a host profile or admit a warm sandbox.

Linux documents retained symlink descriptors and their permitted metadata operations in
[open(2)](https://man7.org/linux/man-pages/man2/open.2.html). Node accepts numeric open flags in
[the pinned Node 24.19 API](https://nodejs.org/download/release/v24.19.0/docs/api/fs.html#fsopensyncpath-flags-mode).
The Linux x64 UAPI flag values are explicit because Node does not expose `O_PATH`. A Node24.22.1
Linux data-only probe retained a symlink descriptor through replacement; hosted Node24.19 remains
the required owner qualification. No inference about other operating systems is made.

Under #1061, deliver in this order: contract documentation; built public small-kit and hosted
upstream/foreign-owner acceptance; real filesystem/race/disposal integration cases; immutable
component binding capture and alias custody implementation; checks/build/all tiers, independent
exact-archive TypeScript/Node consumption and hosted qualification. Existing unit/regression tiers
remain intact. Alias behavior crosses a filesystem boundary; do not add redundant isolated tests
or label ordinary negative boundary cases as regressions.

Keep all methods within twenty formatted body lines. Keep package boundaries, immutable historical
artifacts, all seven platform operation IDs, existing assertions/timeouts and release policy. All
issues remain open. Full configuration policy, actual kernel/launch and VM-budget binding, native
profile advertisement, warm pools and installed Agent services remain subsequent Task3D work;
productive Work/model execution remains Task10.

Final custody review also pins direct directory metadata so a moved-and-restored parent is not
silently accepted. Qualification must cover missing links and retained-descriptor replacement;
failed close must not close an unrelated file that reused a withdrawn descriptor number.
