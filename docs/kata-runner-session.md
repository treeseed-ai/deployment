# Native guest readiness inside Kata

Deployment extends its existing KataSandboxPlugin/backend with optional `guestRuntime`:
`{scope, artifact}`, where scope is the portable SDK capacity scope and artifact is the exact
GuestRuntimeArchive configuration. Installation identity must match the host scope. Omitting it
preserves the qualified environment-only backend. It is trusted host configuration; a worker
cannot supply raw runtime executables, image names, paths or arbitrary commands through a request.

An admitted archive is read before any sandbox is created. Its artifact and complete configuration
bind custody/generation as usual. Create warms one owned Kata sandbox using the configured immutable
GNU image, stages verified guest bytes at `/opt/treeseed-runner/guest` and a credential-free
configuration under `/run/treeseed-runner`, and launches the actual guest as UID/GID 65532. Private directories/configuration
are 0700/0600 and owned by that guest identity. Hosted acceptance must inspect the actual
runner process: all four UID values 65532, no effective Linux capabilities, and NoNewPrivs=1. The guest gets a bounded explicit environment, with no
host options, credentials or engine socket. No Agent module or executable runs on the host.

A retained process session sends only SDK runner readiness frames in this slice. Validate strict,
duplicate-free bounded JSON, scope, request identity, role and actual process/composition generation.
Keep stdin open; a fresh inspection asks the same live root again, rather than replaying an old ready
sample. Root failure, unexpected stderr/output, malformed/foreign frames, cancellation and deadlines
fail safely. EOF requests orderly native disposal; no shell marker may substitute for SDK readiness.
The session controller manages physical process I/O, never native provider instances or another DI
container. Agent keeps its process-local root; Deployment's worker never embeds it.

Native backend evidence adds the verified guest readiness, or null without configured runtime. The
current sandbox-control wire projection remains unchanged; this evidence alone does not qualify the
installed worker runner bridge. No assignment credential is put in a virgin guest. Dispatch, trusted
assignment publication, environment permissions and allowlisted egress must be qualified separately.
This slice does not claim real pool admission/replenishment or live identity authority.

Every assigned or failed guest still needs explicit destruction and verified container/task/snapshot/
hypervisor absence. Killing a host-side ctr client is insufficient. Uncertain session/creation state
retains the existing intent and repair boundary; never adopt/recycle it or report cleanup optimistically.
The caller retains the known logical ID for explicit cleanup after a failed create.

## Exact qualification fixture

The genuine accepted Agent .22 NPM archive is development-only immutable fixture data, excluded from
Deployment's published package and never imported/installed/executed on the host. Producer
`8397da51c5048abdf9b0ee5d158fe32e2d12c5c5`, accepted by Agent #549, archive SHA-256
`3ebf0257ae72ce921672d016e5bc7530515069a2994ce77660f2c27751f8b0aa`.
The original archive retains complete package and payload provenance; no fake runner replaces it.

Use the official Ubuntu 26.04 linux/amd64 image selected through the registry index
`sha256:0e73b71479e7bc5f006bca872e25c3cd680dc052a0116f90d63ae363537db0dd`:
`docker.io/library/ubuntu@sha256:157dc3d6e4a3e4f2c68d12df9df9ed6e808b59af6d4c3757b432b4f519916725`.
Its configuration is `sha256:febc1a2eec1fdaad5db7e542ce1fefaee9656b6e3a177f0c703d616e77b86a62`.
The manifest/config bytes and native architecture were independently read/hash-verified from Docker's
[official registry](https://registry-1.docker.io/v2/library/ubuntu/manifests/sha256:157dc3d6e4a3e4f2c68d12df9df9ed6e808b59af6d4c3757b432b4f519916725).
Actual hosted Kata execution, not the image label, qualifies the recorded GNU libraries.

## Implementation and verification

1. Commit this contract and changelog before executable specifications.
2. Add built public configuration rejection and actual hosted Kata acceptance, with the exact owner
   archive fixture. Observe missing readiness fail before implementation; retain every previous test.
3. Add the bounded class session, guest-only staging and native backend wiring. Keep methods within
   twenty canonical body lines, no baseline/exemption additions, and no source imports across owners.
4. Exercise local process-boundary negative controls without pretending they qualify Kata. Run complete
   owner lower tiers/checks/build and genuine public archive smoke; full hosted foundation must prove
   the actual guest root remains alive, has a stable generation, contains no assignment and is physically
   destroyed. Other partitions and original assertions/timeouts stay mandatory.
5. Record exact producer/archive/image identities and current-head evidence in the cordis candidate.
   All issues stay open; Work/models remain Task 10. Final Task 3D assembly remains incomplete.

Containerd's [exec implementation](https://github.com/containerd/containerd/blob/v2.2.0/cmd/ctr/commands/tasks/exec.go)
uses attached stdin/stdout and waits for the guest process; its normal completion deletes the exec
record. Cancellation/disposal still requires owner resource read-back and physical VM destruction.
EOF or a client exit alone is never a successful sandbox-destruction receipt.

Qualification failures retain both the primary warm/inspect failure and any destruction failure;
cleanup must never replace the original cause. Fixed stage codes distinguish binary/configuration
staging from readiness and physical removal, without printing commands, output, paths or secrets.
The first .98 hosted run failed with generic KATA_COMMAND_FAILED; retain that immutable run/archive
as evidence and use a new candidate for additional stage evidence. No timeout or assertion is removed.


The .99 run narrowed the real failure to binary staging and verified physical destruction. Next
qualification separates fixed directory preparation, byte transfer and permission finalization,
and requires guest-side size/SHA-256 read-back before launch. A local genuine-payload Node receiver
isolates the host pipe without executing the payload. Upstream reports about [CRI stdin teardown](https://github.com/containerd/containerd/issues/13934)
and [Bun closed-stdin reporting](https://github.com/oven-sh/bun/issues/45882) are hypotheses to test,
not evidence that this ctr/Kata configuration has those defects. Keep original deadlines and avoid
retries or timing sleeps. Retain the failed .98/.99 archives and hosted runs.

The .100 failure is specifically TRANSFER, after successful directory preparation. Before physical
cleanup, qualification reads only the known guest payload's byte count and its filesystem's type,
block size and available blocks. The fixed read-only probe has a ten-second bound and a 1 KiB output
limit; only validated numeric/type fields enter the diagnostic. Probe failure cannot mask the
original failure or skip destruction. The [uutils stat contract](https://uutils.org/coreutils/docs/utils/stat.html)
defines these filesystem fields. This separates an exhausted guest mount from a failed stdin
transport without exposing files or executing the payload on the host.

Preparation, payload transfer and finalization share one absolute monotonic 120-second staging
deadline. A phase also keeps its smaller local limit; spending time in an earlier phase cannot
reset the shared budget. Reject an already expired budget before spawning, and recheck it when
the process closes. The separate configuration write retains its original ten-second bound.

The .101 hosted read-back proved that `/run` is a 64 MiB tmpfs: the incomplete payload was exactly
67,108,864 bytes and zero blocks remained. Preserve that failed head/run. Stage the executable in
a distinct fixed 0700 directory on the guest root filesystem, rejecting symlink parents and existing
entries. Small configuration and future assignment records remain under `/run`; both directories
belong to UID/GID 65532 after verified size/hash read-back. This changes no runtime mount, host path,
image identity, test timeout or application authority. No Agent payload executes on the host.
