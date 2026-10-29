# Private guest readiness for an Agent worker

Deployment owns the existing service-scoped private sandbox socket. Extend that same bounded
transport with the SDK .39 `SandboxRunnerSchemas` message family and export
`SandboxRunnerSocketClient` from `@treeseed-cordis/deployment/sandbox-control`. No raw Docker,
containerd, arbitrary process, host path or command is exposed to the worker.

The selected installation's owner-private authority record retains `{credential, grant}` and may
add `runnerGrant`, the SDK `treeseed.sandbox-runner-grant/v1` grant. Both grants must have exactly
the same host/service/provider/service-generation scope. The runner grant also binds the exact
capacity scope and expiration. The opaque 64-hex credential and private socket remain governed by
the existing descriptor-anchored custody, ownership, mode, byte limit and identity checks. Omitting
the optional grant preserves the existing six-operation control protocol and denies runner traffic.

`new SandboxRunnerSocketClient({endpointDirectory, authorityFile, scope, timeoutMs?})` implements
the public SDK `SandboxRunnerClient.exchange(request, signal)` contract. A request wraps the
portable runner frame, exact sandbox ID, outer request ID and host scope. Inner and outer request
IDs must match. Validate authentication, both scopes, operation permission, expiration and expected
generation before acceptance; reread unchanged authority and socket identity before returning.

This slice admits only `ready`. A ready request freshly inspects the exact owned sandbox through
the native `KataSandboxHost`, which asks its actual live Agent root for readiness. Bind the caller's
frame to that actual root's capacity scope, process/composition generation and role, then project a
strict SDK guest response into the outer SDK runner envelope. Never synthesize readiness from a
container label, prior sample, configured generation, shell marker or transport availability.
Missing native readiness blocks. Even a grant listing `run` or `cancel` cannot activate those
operations in this slice; they return operation-denied without assignment, script or guest effects.

Keep one request per connection, 64 KiB framing and existing deadline/concurrency bounds. Reject
duplicate keys, extra frames, malformed/foreign responses, changed/revoked/expired grants, wrong
credential, unowned/symlinked state and cancellation. Failures expose only SDK safe codes. There is
no service-instance cache or second dependency container: the existing process-local native root
retains the same Kata provider, and the new branch is typed physical transport/projection only.

## Verification and delivery

Adopt Deployment #1021. Commit this contract/changelog before outside-in tests. Add a built public
client missing-export red and a genuine hosted-Ubuntu default socket/native-Kata/Agent archive
scenario. Retain all prior lifecycle, environment, privilege, read-back and destruction assertions
and timeouts. Exercise unchanged control traffic plus scoped runner readiness, stable generation,
wrong generation/scope, revoked/changed/expired grant and unsupported operations. Local transport
fixtures are explicitly protocol controls and do not qualify real Kata or installed service grants.

Run all owner checks/build/tiers and genuine script-free archive consumers, then current-head hosted
and review gates. Select only the accepted real-guest baseline from #1037 before implementation;
that candidate's immutable accepted Agent fixture remains explicit. Do not import sibling checkout
source. Keep the PR within ten files and all executable methods within twenty canonical body lines.

Current socket qualification is root/same-UID only. Named installed host-capability grants,
service-UID/read-only mounts, trusted assignment publication, actual worker pool/program, environment
permissions, egress, live enrollment, seeds/CLI and final assembly remain required. No manager root
runs inside Deployment's worker. Real Work/model execution remains Task 10. All issues stay open.
