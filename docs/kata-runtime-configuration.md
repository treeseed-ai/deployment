# Kata configuration reference proof

Deployment owns configuration interpretation beneath its native sandbox provider. After
installed-component custody, `KataRuntimeConfiguration.inspect(file, components, signal)` will
bind the exact configuration bytes to their verified kit member and project the references
and resource defaults needed by later runtime-policy qualification. `file` is the existing
`{path, sha256}` trusted file selection; `components` is retained `RuntimeComponentCustody`.
The same Deployment capability previously owned runtime configuration and artifact inspection;
no functionality moves into Agent, SDK, API or Platform.

Require the unique `configuration`, `hypervisor`, `kernel`, `rootfs` and `virtiofs` roles.
Open configuration bytes through checked no-symlink directory/file descriptors, at most one
MiB, with their exact proof hash. Verify borrowed component custody before and after reading.
The file hash must equal the configuration component's proof. Neither alternate same-looking
metadata nor a caller-supplied parsed object substitutes for those bytes.

Parse with exact `smol-toml@1.9.1`, maximum inline depth 32, integer-as-BigInt mode and unsafe
key rejection. The pinned runtime document contains a valid signed 64-bit integer beyond the
safe JavaScript integer range; do not silently round it. Convert only interpreted integer
fields after explicit safe-integer/range checks. Reject malformed/duplicate keys, non-finite
numbers, invalid UTF-8, missing/ambiguous tables, invalid required fields and cancellation.
The pinned package's `ParseOptions` declarations are the source for these parser options.

The supported reference projection requires one `hypervisor.qemu`, `runtime.hypervisor_name`
equal to `qemu`, `runtime.agent_name` equal to `kata` and an `agent.kata` table. QEMU `path`,
`kernel`, `image` and `virtio_fs_daemon` must select the exact respective verified kit member
or its verified archive alias. No unbound absolute path or alternate hypervisor is accepted.
The projection returns archive/member identities and safe normalized defaults, never raw TOML,
host-installed paths, unknown settings or exception messages.

`KataRuntimeReferences` is immutable data with `kind: kata-runtime-references`, format version 1,
archive identity, configuration member proof, role-to-member references and these resource
defaults: default/maximum vCPUs, default/maximum memory MiB, vCPU/memory overhead, memory slots
and static sandbox resource-management selection. Zero maximums retain their declared sentinel
meaning; they are not inferred host measurements. Positive default dimensions, nonnegative
safe maxima/overhead and finite CPU overhead are required. Bind the full original configuration
digest even though this projection interprets only a subset of its fields.

This proves configuration-to-kit references only. It does not validate every runtime option,
host symlink aliases, QEMU's actual kernel/rootfs selection, egress/isolation safety, VM budget,
SDK sandbox-profile readiness or warm-pool admission. Those remain mandatory following gates.
Do not activate a runtime or advertise a profile from this data alone. Process-local Cordis
composition and typed provider selection remain at the sandbox seam; this pure parser/reader
is a coherent admission invariant, with no second service container.

Delivery follows documentation → built public missing-capability test → real file/archive
boundaries → isolated projection tests → implementation → complete owner/public/hosted gates.
Use genuine TOML/kit/file fixtures, and the actual pinned installed configuration on hosted
Ubuntu. Preserve all prior assertions, timeouts, artifacts and twenty-line method enforcement.
All issues remain open; Work/model execution remains Task 10.

Implementation inventory: this contract, CHANGELOG, package/lock, one configuration module,
the `/sandbox` export and acceptance/integration/unit/support files. Ten files maximum; no
shared policy changes. Wait for accepted component custody #1050 before runtime implementation.
