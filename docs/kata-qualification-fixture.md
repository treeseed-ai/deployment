# Public isolated Kata qualification fixture

`@treeseed-cordis/deployment/testing/kata` exports the existing `PrivateKataFixture` and its
registration-free workload support through an explicit development-only subpath. This lets Agent
and Platform assemble exact public owner archives without copying Deployment infrastructure or
importing a sibling checkout's source. It is not a production host provider or a worker capability.

Construction fails with `KATA_QUALIFICATION_REQUIRED` before creating state unless the process is
Bun on a GitHub-hosted Linux x64 runner, running as root with the expected runner environment. Do
not spoof those inputs or run the fixture on a workstation. Qualification still needs actual KVM,
the exact Kata/containerd prerequisites and Ubuntu boundary checked by the native backend; environment
labels alone do not prove those prerequisites. Missing prerequisites fail visibly.

The fixture creates a unique owner-private daemon directory/namespace. Call `start()` for the
isolated containerd daemon, then `configuration()` to obtain the exact host configuration and
fixture-owned immutable environment archives. `hash(path)` supports exact source/image/library
composition pins. `run(args)` is privileged **test-only** runtime inspection/preparation: never
expose it, the daemon endpoint, or this fixture to a worker or guest. Consumers compose the real
public `SandboxControlApplication` and clients around this configuration.

Install the accepted runtime using the owner's existing CI prerequisite recipe. Tests retain their
own exact Agent archive/image selections. Copy only declared data into private custody; execute no
Agent payload or environment setup on the host. Warm/claim/prepare/run remain production owner
operations; the fixture does not emulate a guest, live authority or an Agent root.

Consumers must explicitly destroy their known guest IDs, verify task/container/snapshot/hypervisor
absence and dispose native applications before calling `stop()`. Daemon shutdown alone is not a
destruction receipt. Uncertain state fails qualification and needs explicit repair; do not adopt or
automatically delete foreign or interrupted resources.

Delivery: committed contract/changelog → built public unqualified-construction red → fixture/export
guard → complete owner checks/build/tiers and genuine public Node/declaration consumer → full hosted
Kata/review. Preserve all previous assertions, deadlines, runtime/image pins and scripts. Keep the
fixture and its transitive support packaged explicitly; no test registrations or owner runtime move.
All issues remain open, and real Work/model execution remains Task 10.
