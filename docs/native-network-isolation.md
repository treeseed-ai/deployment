# Native virgin sandbox network qualification

Deployment owns this bounded host invariant beneath the selected native Kata provider. Agent
owns warm-pool policy and admission. Enable the additional check through the existing explicit
`runtime.policy` mode; legacy configurations retain their current behavior. No new worker option
selects namespace paths, interfaces or raw runtime flags.

Before accepting an unassigned native base, read its owned container's actual OCI specification.
Require exactly one network namespace, with an absent or empty `path`; a missing namespace would
inherit networking, while a nonempty path selects an external namespace. Reject duplicate network
entries and malformed namespace data. Independently inspect interface names inside the actual
guest and require exactly `lo`. A configured intention or caller-provided snapshot alone does not
qualify the default host.

The pinned containerd default specification includes a network namespace. Its `ctr run` builder
changes that selection through explicit `net-host` or `with-ns` options, which the bounded TreeSeed
prewarm builder does not expose. These sources support the test hypothesis; production read-back
and hosted qualification are still required:
[default Unix namespaces](https://github.com/containerd/containerd/blob/v2.4.2/pkg/oci/spec.go#L131-L148),
[explicit namespace overrides](https://github.com/containerd/containerd/blob/v2.4.2/cmd/ctr/commands/run/run_unix.go#L233-L244).

## Public owner interface

The `/sandbox` package exports `NativeNetworkProjection` and `NativeNetworkEvidence`.
`new NativeNetworkProjection().read(specification, bootDigest, interfaceText)` is a pure projection
of already observed inputs. It cannot inspect a host, create authority, activate a sandbox or
advertise readiness by itself. `interfaceText` is the bounded exact output of the host's fixed
guest command; the accepted representation is `/sys/class/net/lo` followed by one newline.
Require a canonical lowercase SHA-256 boot digest.

The immutable result contains `kind: "kata-offline-network"`, `formatVersion: 1`,
`mode: "offline"`, `namespace: "private"`, `bootDigest` and a canonical `digest` over those fields
except the digest itself. The native `KataSandboxEvidence` adds optional `network` evidence only
when policy mode is selected. It is bound to that inspection's actual boot observation. The
existing SDK wire, seven global operations and profile contracts do not change in this slice.

All invalid inputs raise fixed `KATA_NATIVE_NETWORK_INVALID` without private namespace paths,
raw command output or nested causes. Changing namespace configuration, adding any non-loopback
interface, malformed output or an invalid boot identity cannot produce accepted evidence.

## Production ordering and lifetime

Retain component/alias/private-policy custody before launch. Attest the owned native process,
validate its actual OCI namespace and inspect guest interfaces before staging the TreeSeed runner.
Every later inspection repeats the network checks while holding its native launch attestation,
then verifies the same generation and returns network evidence with the matching boot digest.
An unsuccessful creation may retain an owned intent/resource requiring bounded cleanup; it
cannot return an accepted base or silently adopt another generation.

Readiness still creates no VM. Evidence is an observation, not a reservation, complete host profile
or permanent liveness claim. The check does not establish every active runtime component or
security against a trusted privileged host. Full runtime selection, profile advertisement,
allow-list egress, pool claims/replenishment and management authority remain separate gates.
The existing scoped vsock/runner channel is not an internet-egress grant.

## Verification and recovery

Part of Deployment #1076 and the approved Task 3D architecture. Start from accepted native custody
at `a8d42f4be5d17f2a879adda5c8a5576e37b7b77b`. Commit the owner reference and plan before tests.
The built public missing-capability case must fail first. Pure cases cover absent/duplicate/host
namespace selections, malformed input, extra interfaces, output ambiguity and invalid boot digests.
The real hosted default Cordis scenario must return matching immutable network evidence on create
and fresh inspect while preserving all existing tamper, restoration, destruction and descriptor
release assertions. No fixture or accepted test deadline is weakened.

Keep permanent specifications in their behavior tiers, use strict TypeScript classes and methods
within twenty canonical body lines. Run normal checks/build, complete applicable tiers, an exact
scripts-disabled public archive consumer and both complete hosted closures. Preserve immutable
earlier archives and original work. Uncertain native state requires explicit bounded cleanup or
repair; do not restart, claim ready or create credentials automatically.

No workstation Kata/QEMU, production/legacy changes or issue closure. Real Work/models/accounting
remain Task 10. Actual Capacity Provider completion remains dependent on the full Task 3D assembly.
