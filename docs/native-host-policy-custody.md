# Native policy custody in the selected Kata host

Deployment owns this integration beneath `KataSandboxPlugin` and `KataSandboxBackend`.
The backend holds the real installed runtime artifacts and exact private policy before its own
launch, then binds every inspected sandbox to actual process evidence. Agent still owns pool
policy, manager/worker/guest roots and assignment admission. Native Cordis owns selection and
provider disposal; these descriptor owners are private collaborators, not another service registry.

## Trusted host configuration

`runtime.policy` is optional and contains `components`, using the existing
`RuntimeComponentCustody.Config` selections: role, immutable archive member and installed path.
Enable it only with an exact `runtime.archive`, explicit workload `resources` and
`runtime.configurationMode: "task-options"`. The installation root is always `/`.
Selections contain exactly the six policy roles: configuration, hypervisor, kernel, rootfs, shim
and virtiofs. The selected shim and hypervisor must agree with the backend's configured files.
Missing prerequisites, duplicate/incomplete roles or mismatched selections fail configuration
admission before host effects. The complete existing policy interpreter remains authoritative for
the pinned template, aliases, root-image address allowance and permitted finite configuration.

These paths are supplied by the trusted host operator. Worker requests cannot select files,
configuration modes, raw containerd options or borrowed policy objects. Existing configurations
without `runtime.policy` retain their previous behavior and acquire no qualified profile by
omission. An optional compatibility mode is never enough for later pool admission.

## Lifetime and effects

After endpoint qualification, borrow its retained immutable archive, capture the selected
installed components and aliases, and open the private effective policy using the configured
workload resources. Keep that custody for the backend's entire active lifetime. Construction
failure releases newly owned descriptors before the endpoint/archive; uncertainty cannot return
a live backend. Verify custody before activating operations and after actual observation.

For each owned sandbox inspection, open the real `KataLaunchAttestation` against the retained
policy and returned runtime resource name. Its production observer freshly binds process
generation, command, executable, kernel, root image and finite VM bounds. Reject mismatches;
never accept a caller's boot snapshot or saved proof as current liveness. Close each temporary
attestation without closing its borrowed policy or the sandbox. An unsuccessful create may leave
an owned intent/resource requiring bounded cleanup; it cannot return an accepted sandbox.
Attest the newly created base before staging the TreeSeed guest runner or issuing guest inspection
commands. Readiness freshly verifies retained custody without creating a sandbox. Restoring the
bytes of a changed private policy does not re-admit its previously retained file identity.

Keep resources and retained descriptors alive through verified destruction. Backend disposal
first verifies its namespace is empty, then releases private policy, alias and component custody
before its borrowed archive/endpoint. A failed release cannot report successful disposal.
Partial construction unwinds owned descriptors. Do not automatically delete or adopt uncertain
installation state, restart a provider, or use a read-only observer socket for sandbox control.

Ready/doctor/plan never create a qualification VM. This slice publishes no resource profile or
pool readiness. Later profile advertisement must bind exact selected artifacts, generations,
isolation/network policy and freshly qualified owned launches. Used sandboxes remain disposable.

## Delivery and verification

Part of Deployment #1073 and the approved seed-driven Task 3D architecture. Reconcile launch
attestation #1069/#1070 only after its accepted `origin/cordis` commit; do not merge its unaccepted
feature branch into this candidate. Keep earlier immutable archives intact.

1. Commit this contract before acceptance, integration/unit cases and implementation.
2. Start with a built public program that detects the optional schema and rejects incomplete
   policy selection before host effects. Keep the existing compatible construction cases.
3. Exercise the real default native Cordis provider on hosted Ubuntu 26.04: backend-owned custody
   precedes launch; actual finite kernel/image/process read-back agrees; destruction precedes
   native disposal. Reject changed policy and mismatched selected runtime files without success.
4. Cover pure selection validation separately, then implement cohesive descriptor ownership and
   backend orchestration. Keep changed methods within twenty canonical body lines.
5. Run owner checks/build, all four applicable tiers, exact public archive/declaration consumer
   and both complete hosted closures. Preserve accepted assertions, registration discovery,
   production deadlines and the existing fifteen-minute job limit; split delivery if necessary.

Local tests inspect inert artifacts and program boundaries. No workstation Kata/QEMU, privileged
runtime installation, spoofed hosted qualification or production/legacy mutation is authorized.
Keep every issue, including Platform #678, open. Actual pool/setup/egress, live enrollment, seed
coordination, CLI and final assembly remain Task 3D. Productive Work/models/accounting remain
Task 10; general replacement qualification remains Task 4.

Owner references: [retained components](runtime-component-custody.md),
[aliases](runtime-alias-custody.md), [effective policy](runtime-policy-custody.md),
[supported configuration selection](kata-task-configuration.md) and
[native launch attestation](kata-launch-binding.md) once its dependency is accepted.
