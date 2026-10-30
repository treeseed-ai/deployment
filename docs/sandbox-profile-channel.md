# Qualified profiles over private sandbox control

Deployment owns the existing authenticated, service-scoped sandbox-control socket and selected
native host. SDK owns its versioned wire envelopes and resource-profile contract. Agent owns pool
bootstrap, compatibility admission and claims. This slice connects those existing contracts; it
introduces neither a second provider resolver nor a new global platform operation.

Part of #1083 / approved Task 3D. Initial accepted baseline is
`366709a04a994a1825c878376acb369089bd5a0f`. Host profile candidate #1085 must qualify and merge before
implementation consumes its source. This reference describes intended behavior, not delivered
private profile forwarding.

## Interface and lifecycle

The existing SDK `SandboxControlClient.ready(signal)` returns `SandboxAvailability`. Keep
`state: available`, configuration digest and capability version. If the selected host implements
optional `profile()`, invoke it after `ready()`. Omit `profile` when the method is absent or returns
null; preserve compatibility with older providers. A supplied profile must pass SDK schema and
canonical revision validation before entering the response. Invalid data fails with the existing
safe `SANDBOX_OPERATION_FAILED` transport problem; never silently omit a malformed claimed profile.

No readiness/profile request creates or assigns a VM, performs setup, opens a runner or changes
credentials. A fresh native owner returns no profile. Explicit authenticated `create` can qualify
one under the host's actual native policy. Subsequent ready calls return its current verified
profile; verified destruction retains demonstrated capability. New construction, changed owner
authority and uncertain state follow the host's qualification rules rather than adopting a journal
as authority. Forward current owner data, never a transport-owned cache.

The response remains bound to the existing installation, service, provider and service generations,
request identity, live scoped grant and authenticated private endpoint. Preserve credential expiry,
revocation, cross-scope denial, bounded framing/deadlines and disposal. A profile is not an authority
grant, active sandbox health, free-capacity sample, reservation or a ready Agent pool.

Agent's later worker integration must explicitly bootstrap a clean native base, obtain this profile
and use SDK compatibility validation before admitting it to the pool. Missing profiles block that
admission honestly. Assigned sandboxes remain single-use and require verified destruction.

## Verification and ownership

Commit this reference/plan before outside-in specifications and implementation. Extend the built
default private-control program to use genuine retained native policy, proving absent-before-create,
actual SDK-valid profile after creation, exact read-back after verified destruction, owner refusal
after tamper and socket/resource cleanup. Retain every existing authentication, grant, assignment,
setup, cancellation, denial, cleanup assertion and timeout. Fixture setup remains explicitly inert
on the workstation; real Kata executes only on actual hosted Ubuntu.

Exercise provider contracts for absent/null/valid/malformed/incorrect-revision profiles and ensure
fixed problems contain no private input. Pure and injected seam coverage cannot substitute for
default native construction through the actual socket. Use exact public archives for consumer smoke.

Run checks/build/all tiers, a safe-mode exact package and scripts-disabled strict public consumer,
both complete hosted closures and review. Stay within ten files and twenty canonical method lines;
no workflow, dependency, baseline, exception or timeout relaxation. Seven global operations and SDK
wire versions stay unchanged. Original drafts, archives, API committer policy and repository
boundaries remain intact; every issue, including platform#678, stays open. No productive Work/models,
legacy mutation, production publication or cutover. Real pool/setup/egress, live enrollment, seeds,
CLI and final assembly remain required Task 3D work; productive execution remains Task 10.
