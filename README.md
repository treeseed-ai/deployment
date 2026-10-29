# Cordis diagnostics and non-activating planning

Actual process boot-input observation is specified in [the owner reference](docs/kata-boot-observation.md).
It remains separate from complete installed policy/profile admission.

Installed runtime path/alias custody is specified in [the owner reference](docs/runtime-alias-custody.md).
It extends read-only artifact proof; complete host profile admission remains required.

## Host runner contract selection

Deployment selects SDK .44 from accepted source `00be028b92998f8d7039a3906e784c6b8598e730`,
archive SHA-256 `d95c54cf6081c7634498dfb4f3235d42d65b8664a5d62cc87c4dd4e85381f0f3`.
This .127 dependency-only closure includes the SDK provider availability contracts and public TLS
client while retaining the accepted .126 private journal custody and bounded archive publication.
A built acceptance gate checks peer, installed version, archive hash, existing manager channel
and all seven operation IDs before owner checks. Runtime source and the frozen Agent guest archive
remain unchanged; actual Agent availability orchestration is a later owner integration.
Peer, vendor archive, lock, installed identity and built public Node consumer must agree.
The preceding .113 dependency closure supplies SDK #506 manager ready-only service envelopes (channel
1.1.0-cordis.1) through one exact peer/vendor/lock selection. Existing worker/runner roles and
all seven platform operations remain intact. It adds no manager runtime, host capability or
activation. The separate #1029 CI prerequisite proposal remains independent.

SDK #505 integrated the corrected awaited sandbox-profile binding; the retained .40 candidate
must not be selected because it admitted compatibility mutation during hashing.

This dependency update preserves the native Kata guest session, scoped private control/runner
socket, non-activating planning, qualified workload CPU/memory/read-only/scratch limits from .109
and retained runtime archive identity from .110. Complete component/configuration/isolation
profile binding and pool admission remain required. This .115 candidate additionally retains
the exact runtime kit through native backend lifetime (#1044), under the documented optional
trusted archive configuration. Component association and complete profile readiness are not claimed.
Keep all preceding tests, limits and timeouts unchanged.

Deployment's retained real-runner fixture selects the accepted Agent .22 archive. Agent's own
hosted #555 acceptance additionally qualifies its exact .28 guest and separate default worker
root against Deployment's public .106 qualification fixture. Those are runtime-boundary proofs,
not manager/worker service, pool, assignment/setup, allowlisted egress or live-enrollment completion.
No worker-supplied commands, host paths, raw daemon sockets or invented readiness are authorized.
Work/models remain Task 10; every issue stays open.

## Standalone worker bootstrap admission

Issue #1020 requires the standalone worker to read its exact immutable published plan before
waiting for parent handoff. It must not inspect mutable writer/journal state while the parent
still owns the bootstrap transition. After the nonce, PID and executable-bound permit is ready,
the native host acquires authority and performs the existing full state/ownership validation.
An immutable plan is an input binding, never proof of active state or permission to mutate.

The regression spawns the genuine compiled worker, holds an incomplete writer transition before
handoff, restores the exact owner record and then completes the real protocol. It starts no
service containers. Foreign/malformed grants and journals remain failures after handoff. Keep
all issues open; no production or legacy service changes are authorized.


## Historical capacity and service-scoped sandbox SDK closure

Issue #1021 selects the accepted SDK `0.0.0-cordis.37`, source
`dce3108e061ecaf0cfa2915c03698f0e3170a67b`, archive SHA-256
`886a9f359148a1aee49997de7e0604c65c87bf16c693d23781c5732f41990384`.
The next private Deployment successor is `.83`. Peer pin, archive bytes, local lock SRI and
installed identity must agree. SDK #498 adds bounded scoped sandbox control; SDK #500 adds
separate worker/guest message bindings to the activity/environment/lease/pool/protocol closure.
Prior exact archives remain immutable.

This selection adds no transport or host power. The real Kata backend retains its own runtime
qualification; the private service channel is a separate implementation. Agent owns manager,
worker and guest roots, live authority, pool policy and setup orchestration. Deployment owns
artifact custody and bounded host operations. Keep all historical lower-tier and smoke checks,
real hosted Kata qualification, Keycloak boundaries and open issues. Work/models stay Task 10.

`DeploymentHost.diagnose(configuration?) → Promise<DiagnosticReport>` is the public typed
contract. `ComposeDeploymentHost` supplies the real default Docker CLI, host/filesystem and
loopback port probes. The CLI consumes this package unchanged. Planning adds `DeploymentHost.plan(configuration) → Promise<DeploymentPlan>` and private plan-only state. No apply, Compose up, container lifecycle or credential creation is implemented.

Configuration accepts `context?`, absolute `installationDirectory?`, and `port?` (default8443).
The default directory is `$HOME/.local/share/treeseed-cordis`. Diagnostics require Ubuntu26.04
x64, local Unix Docker context, Linux amd64 server, at least2CPUs/2GiB memory and1GiB free
storage. Every unmet prerequisite is an explicit blocked check; unavailable fields are null.
Checks cover host, context, engine, Compose, resources, storage and loopback port availability.
The socket endpoint and command errors are sanitized; raw Docker stderr is never returned.
Command timeout is5seconds and output bound1MiB.

Use `docker --context NAME` for read-only info/Compose queries, and context show/inspect for
selection. Never run context use or persist context changes. Reject ssh/tcp/HTTP endpoints
before engine contact, including a remote DOCKER_HOST; explicit context does not silently
change the selected authority. See [context inspection](https://docs.docker.com/reference/cli/docker/context/inspect/)
and [selection](https://docs.docker.com/reference/cli/docker/context/use/).

Storage inspection rejects symlinks in any component, foreign destinations, wrong
ownership and unwritable/unsearchable ancestors. It uses stat/statfs/access only and creates
nothing. Valid owner-private Task 2 plan-only state is recognized. Doctor’s port probe temporarily binds and
closes127.0.0.1; it reserves nothing after return and promises no future availability.
Probe failures produce stable codes, never guessed readiness. Tests use fixture-owned paths,
ports and Docker configuration, without touching existing installations or containers.

Legacy ownership: manager/doctor, configuration-preflight and supervisor/compose-diagnostics
remain Deployment capabilities. Lifecycle/supervision and application installation are deferred.

## Development and candidate delivery

Use Bun 1.4.4, TypeScript 5.9.3, Zod 4.6.7 and Node 24.19.0 for portability qualification.
Run `bun install --frozen-lockfile`, `bun run check`, `bun run build`, then
`bun run test:unit`, `bun run test:integration`, `bun run test:smoke`.
`bun run verify` runs all of these in order. No empty suites or skipped targets count as qualification.
The first executable target is Ubuntu 26.04 x64 with a local Linux/amd64 Docker engine.
Other operating systems/architectures remain unqualified. Cordis upstream candidate:
`35fdc969e4b6c48c48ed44717c7a018324e4dd88`; this slice does not mount a Cordis host.

The SDK's `SourcePolicy` development export checks the actual TypeScript AST and strict
compiler diagnostics before every build. Handwritten JavaScript, standalone functions,
function expressions/arrows, object method bags and source imports escaping the owner
are rejected. Class methods, interfaces and declarative data/schemas are supported.
Inherited `.agents` upstream resources and generated `dist`/`vendor` archives are excluded.
See [TypeScript compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API).

Private `0.0.0-cordis.1` candidates are packed without lifecycle scripts. Consumer `vendor/`
archives contain the exact generated package bytes, with source commit and SHA256 in
`package.json` and installation integrity in `bun.lock`. Consumers use public package exports,
never sibling source. These are review candidates, with no registry publication or production
release. Migration PRs target `cordis`; issues remain open until authorized release.

Docker executable resolution uses the current PATH explicitly and passes the current environment.
Observed on Bun1.4.4+38afee6c8, Ubuntu26.04.1 x64: `node:child_process.spawnSync('docker',
['--version'], {env:{...process.env}})` after `process.env.PATH=''` still found Docker29.9.1.
The missing-engine regression checks our explicit resolver instead of trusting implicit lookup.
[Bun subprocess PATH documentation](https://bun.com/reference/bun/spawnSync) describes explicit
PATH handling; this observation records the exact configuration rather than a general limitation.

## Task 2: non-activating plans

`trsd platform plan --file CONFIG [--json]` validates an explicitly prepared local release bundle. It never downloads, installs packages, imports plugin code, runs scripts, binds ports, loads images, creates credentials or starts containers. Apply remains unsupported. Successful plans describe future effects, not an active or healthy installation.

Configuration retains installationId, engineContext, installationDirectory (absolute), origin (loopback), runtimeState, plugins (exact id/package/version/archive SHA-256) and credentialReferences (unique `secret://<slot>` values). Add `release: {directory: ABSOLUTE_PATH, manifestDigest: SHA256}`. The installation and bundle must be disjoint. JSON object keys and semantic sets normalize deterministically; artifact byte identities remain exact.

The SDK release inventory version 1 binds `packageJson`, `lockfile`, and `recipe` descriptors `{path,sha256}`, requiredPluginIds/requiredServices, package entries `{name,version,path,sha256}` and image entries `{id,reference,layout,indexSha256,manifestDigest}`. All paths inside the inventory are relative and contained without symlinks. Image references are digest-only and match the selected OCI manifest. Package archives exactly cover the flat locked runtime closure; Bun v2 registry and local tarball records are accepted, without resolving versions or contacting a registry. Unsupported lock forms fail closed. Selected plugin package metadata is produced from the SDK PluginDefinition declaration also used for class static provide/inject fields.

The recipe is a restricted Compose JSON object with services/volumes/secrets. Service fields: image, depends_on (names), ports (long-form target/published/host_ip/protocol tcp), volumes (type volume/source/target/read_only) and secrets (names). Exactly one published port matches origin; localhost maps to 127.0.0.1, IPv6 literals to ::1. Volume declarations are empty local objects; secret declarations are `{file: '.cordis/credentials/<slot>'}` and match configuration references bijectively. No command/entrypoint/environment/build/include/interpolation/host mount/custom network/privileged/external/hook fields. Named resources derive from `cordis-` plus the first 16 hex SHA-256 characters of canonical `{installationId,installationDirectory}`.

Deployment validates native Ubuntu 26.04 x64, local Docker Linux amd64 context/endpoint/daemon identity, capacity, ownership and ports. Port checks read Linux TCP tables without binding. Existing project containers/networks/volumes block; planning adopts no runtime. Only fresh/empty owned installation directories or valid owner-private plan-only state are accepted.

Plans bind normalized configuration, configuration/release/lock/recipe digests, expected engine, expectedComposition null, exact package/image artifacts and typed future effects. No timestamps or volatile capacity samples enter the digest. ID is `plan-<digest>`. Only unblocked plans are persisted under installation/.cordis (0700 directories, 0600 records), with no-overwrite atomic publication and verified read-back. Descriptor-anchored access rejects symlinks and unsafe ownership/permissions. Repetition revalidates inputs before byte-identical reuse. Interrupted/foreign/malformed state blocks; no automatic adoption or repair. Stored read-back does not require the source bundle, and grants no permission to apply.

CLI exits: 0 verified saved plan; 1 sanitized runtime/I/O failure; 2 invalid arguments/JSON/schema; 3 prerequisites/artifact/authority/state blockers. Blocked responses have result null, structured blockers and no saved reference. Never echo invalid input, archive content, credentials or engine stderr. SDK PlanningBlockedError carries only validated safe blockers. Seven remote operation IDs remain unchanged; platform.plan stays a write operation because saving a plan needs local ownership.

Verification: documentation first; outside-in built-program failure before implementation; exact read-back/modes/determinism; immutable/architecture/graph/recipe/secret/path/journal negative cases; no-runtime snapshots; actual default construction; all owner check/build/unit/integration/smoke gates plus assembled acceptance. Test fixtures are not a production application composition. CI must run a positive plan on ubuntu-26.04 and fail visibly if prerequisites are absent. No container starts, even in tests.

Tracked in #904; parent integration treeseed-ai/platform#697. Issues remain open until authorized release.

The public `./testing` development export provides PreparedReleaseFixture for owner/assembled tests. Its package compilation and lock generation occur before invoking planning, with package scripts disabled; the planner never calls it. Fixtures do not represent a deployable production application. Metadata reads are bounded to 4 MiB, package archives to 64 MiB, inventory to 256 packages/64 images; layers are hashed as streams.

Plans embed the validated recipe and selected plugin bindings, making exact ports, mounts and injection requirements inspectable after source removal. These are future declarations, not running services.

Owned installation directory components may contain spaces and Unicode. Artifact inventory paths retain their declared relative allowlist; archive member names may contain spaces/Unicode but must remain under package/ without traversal or links. These path checks finish before accepting a plan.

## Task 3A: native local Deployment composition

Implementation is authorized in #906; no apply/worker/installer behavior is included.
`DeploymentCapability` is the owner-defined executable token for the existing DeploymentHost
interface. `DeploymentPlugin` declares native provide/inject fields and mounts the real
ComposeDeploymentHost with selected DockerCommands, HostSystem and diagnostic-port services
in a native Cordis scope. `DeploymentComposition.registrations(artifact)` supplies these class
registrations; consumers use the SDK runtime locator/leases instead of constructing a Compose
host in the CLI. Package identity advances to 0.0.0-cordis.3 with the exact SDK archive pinned.

Contract suites exercise default native construction under Node and Bun, unchanged diagnostics
and exact plan-only persistence, distinct scopes, missing/incompatible selections and disposal.
The implementation's artifact verifier/private publication protocol remain coherent internal
invariants; their safe storage semantics cannot be weakened by swapping an arbitrary helper.
Engine/system/port I/O are typed provider seams. Network runtime, worker ownership, package
installation, active-state migration and live replacement remain future slices. A fixture
provider of DeploymentHost can prove substitution without replacing this owner or claiming a
production engine alternative.

## Task 3B: Durable installed host

ComposeDeploymentHost remains the selected public Deployment adapter. New apply(planId,digest,options), status and application read-back invoke a durable installation-private worker through a fixed versioned Unix socket protocol. One exclusive owner writer persists idempotent accepted intent before acknowledgement. Explicit format-2 migration preserves all format-1 bytes. Native PostgreSQL/edge/engine/journal plugins compose with same-owner API and Identity container providers; Dockerized services have typed capabilities and native lifecycle. No arbitrary host command, Docker socket exposure, remote source acquisition or implicit cleanup of durable resources is accepted.

Task 3B is authorized after the maintainer reviewed the isolated setup. Tracking: #908. Detailed integration plan: https://github.com/treeseed-ai/platform/blob/cordis/docs/superpowers/plans/2026-10-24-task3b-installed-composition.md. Implementation evidence is recorded separately; these requirements are not a passing-test claim.

Development: Bun 1.4.4, Node 24.19.0, TypeScript 5.9.3, native Cordis 4.0.0-rc.12. Run bun run verify (semantic class/source check, strict compiler, build and nonempty unit/integration/program smoke). Installed acceptance uses genuine exact package/OCI bytes, real identity/database/API/HTTPS and explicit isolated certificate trust. No global trust mutation or legacy service changes. All handwritten source, tools and tests are strict TypeScript classes.

All capabilities that can be plugins, including container services, are native Cordis class plugins with typed swappable contracts. No parallel DI graph. Keep independent repository/public package boundaries, exact archive pins and original licenses. Migration PRs target cordis with Part of issue references. All issues remain open until authorized release; installer/Agent/generalized recovery are later tasks.

Container declarations belong to their owner classes/packages (`cordisService` metadata), including bounded container argv, non-secret environment, private configuration slots and readiness expectations. The generic engine validates and renders those accepted declarations; it does not own a Keycloak/API configuration catalog. Format 1 remains unchanged; format 2 explicitly permits these owner projections and the sole API worker-socket bind. No arbitrary host path, shell hook, credential environment or privileged mode is allowed. Private JSON/property/text templates resolve declared secret references only after durable acceptance. Explicit `InstallationStore.migrate()` preserves and hashes the original plan-only receipt; plan/apply report MIGRATION_REQUIRED instead of invoking migration implicitly.

Docker image-store qualification: Docker 29.9.1/containerd registers a selected OCI manifest by manifest digest, while the classic store uses configuration identity. A real Node image save/load qualification preserved manifest/config/layer bytes and started no containers. Apply records a private per-role binding only after loading and inspecting an accepted manifest/config identity; Compose uses that immutable local identity with pull disabled. Resource read-back verifies the binding, configured image and selected manifest descriptor when available. See [Docker image-store documentation](https://docs.docker.com/engine/storage/containerd) and [Moby's inspect implementation](https://github.com/moby/moby/blob/master/daemon/containerd/image_inspect.go). No mutable upstream tag is changed.

## Task 3C contract

Owner issue: https://github.com/treeseed-ai/deployment/issues/910. Follow the approved Platform Task 3C service/provider/UI plan through exact public archives. Preserve independent repository ownership, strict TypeScript classes, native Cordis lifecycle, historical formats and all seven SDK operations. Expected-generation/idempotency, resource/credential/TLS retention and explicit unsafe restart/migration gates are mandatory. All issues remain open until release.

Every visual component must be mobile-first from 320 CSS pixels to widescreen monitors; test 320/375/768/1024/1440/1920/2560 widths, long content, keyboard/touch and 200% text resizing. Keep authored controls at least 44×44 CSS pixels, required actions visible, logical/fluid dimensions and no page overflow (labeled local semantic-table overflow is permitted). UI owns components/styles/renderers; consumers retain domain behavior and Identity retains Keycloak authority.

### Service graph 3 artifact resolution

`ServiceArtifactResolver.resolve(configuration)` accepts `ServiceSchemas.configuration` and
an exact format-3 local release. It validates archives, the complete flat Bun lock and OCI
bytes using the existing bounded artifact verifier. It does not import providers, invoke a
package manager, read credentials or create installation state. Provider references bind the
selected package name/version/hash and native class export (entry, classExport, deployment
contract 0.4). Container and probe exports must appear in the package's SDK-generated
`cordisPackage` format-4 projection. A service instance's configuration validates against that
export's projected JSON schema before planning; its definition equals the owner projection.

Named service instances replace fixed roles. Multiple instances may use one provider export;
bindings and dependency edges identify their distinct service identities. The declarative
recipe must exactly project each instance's selected digest-pinned image, named volumes,
scoped secrets, dependency names and sole loopback publication. Provider-owned environment
and argv remain in the typed service definition, never arbitrary Compose extensions. Resource
recipe keys are deterministic hashes of service identity plus local slot, avoiding ambiguity
and the Compose key length limit. Configuration secret references are exactly
`secret://<service-id>/<slot>`; recipe paths point to that future scoped private credential.
Unused packages, images, service definitions, mounts or secret slots fail validation. Planning
only validates these paths; activation is a separate durable worker operation.

Projected configuration schemas use the pinned `ajv@8.17.1` draft-2020-12 validator in strict
mode, without coercion, remote schema loading or provider imports. Unsupported schemas block.
Defaults are applied to a private configuration copy. Package asset descriptors are verified
against archive member hashes; `composition.assetDigest` binds the canonical sorted list of
`{package,version,path,sha256}` assets. The API image (the explicitly selected worker-socket
service) must also bind this digest and the complete package set in its OCI configuration labels.
See [Ajv draft-2020-12 support](https://ajv.js.org/json-schema.html#draft-2020-12-breaking).

Container exports inject `service.context` and `deployment.services`; Deployment supplies an
instance-scoped engine binding that rejects calls for another service. Probe exports need no
injected service to implement `observe(ProbeContext)`; its endpoint, deadline and granted
credential reader arrive in that typed call. Neither scope exposes the raw Docker socket.
Artifact fixtures compile the exact native classes used for metadata, including their named
exports. A separate calibration imports that archive outside planning, proving the import
canary is effective and the declared exports actually exist.

### Service-generation plans and journal

The default `ComposeDeploymentHost.plan` dispatches exact format-3 bundles to the generic
service planner. Initial plans describe each named instance and its stable resource identities;
they do not activate services. Configuration and semantic sets normalize before hashing.
Desired composition generation excludes expected current state; plan digest includes it.
Per-service generation excludes unrelated services, global package additions and timestamps.

`ServicePlanStore` recognizes a single format-3 installation journal under the existing
`.cordis` boundary and uses the same no-overwrite publisher and exclusive installation writer
as earlier formats. Fresh publication writes complete private plan bytes, then the installation
receipt; repetition freshly validates state before reusing exact bytes. Read-back validates
schema, digest, scope, engine and bindings without reopening source artifacts. Invalid,
foreign, symlinked, incorrectly permissioned or interrupted state fails closed. Formats 1/2
remain readable by their historical stores and require explicit migration before format 3;
planning does not implicitly adopt an active installation. Doctor recognizes valid format-3
plan-only state without calling it active. No credentials or runtime resources are created.

The mandatory Ubuntu 26.04 program test invokes the built default host, verifies exact saved
plan/read-back and deterministic repetition, removes the source bundle before read-back and
compares Docker resources, listeners and credential absence. Missing host/engine prerequisites
fail visibly. This initial-plan slice does not claim format-3 apply, source installation or
active resource retention; those remain subsequent Task 3C worker acceptance gates.

### Instance-neutral declaration materialization

`ServiceProjection.resolve(service, declaration, graph, configuration)` derives the exact
resolved definition/resources from dependency-port, context and validated configuration
markers. It reads no credential bytes and invokes no class or helper. Secret references resolve
to own slots or explicit dependency-port grants; template cycles and foreign references fail.
Environment and private configuration must match that complete owner projection. This lets
API/Identity consume renamed selected instances without literal database/identity DNS names.

Prepared helper archives are inspected against release-pinned complete file hashes/modes and
archive size before a plan can report `stage-helper`; planning never fetches or executes a helper.
Prepared helper archives use a tar/gzip file tree with inventory-relative paths and exact
owner-read-only (0400) or executable (0500) file modes. Qualification packages standard
tool bytes into this bounded tree; upstream installers and archives are never executed.
Public asset descriptors validate both size and SHA-256. Projected configuration uses standard
JSON Schema formats, rejects asynchronous schemas before invocation and exposes no raw error
or input value. The API/worker-socket image binds only its own locked runtime package closure
and selected UI asset set, so an unrelated private plugin cannot force an API image rebuild.
The complete installation package set remains bound by the release and plan.

Release-built `runtimeImages` associations select a packaged runtime entry without embedding
a future image digest in its own archive. The prepared release binds the final image; its
OCI configuration labels must bind the owning package's complete locked runtime archive
closure, packaged entry digest, and selected asset generation. External images retain exact
package descriptors. Every association belongs to one package and is used by its service.
Adding an unrelated private package preserves an existing runtime image's package-set label.

The public test-fixture export resolves its native provider module relative to its own compiled
package, independently of a consumer's working directory. A built Node program changes to a
fresh directory before preparing the fixture; owner source paths are not a public dependency.

### Format-3 observer/control boundary

`ServiceWorkerClient` is the public read-only protocol-3 client consumed by API and CLI. It
accepts an absolute `host.sock` observer path (or an installation directory), checks private
owner/socket identities around each descriptor-anchored exchange, bounds complete strict JSON
responses and validates the exact operation's result. It exposes only status and application
read-back. The future worker exposes the observer under `.cordis/run/host.sock`; its separately
mounted `.cordis/control/worker.sock` remains owner-local for plan/submit/plugin management.
A read-only API mount must never contain the control socket. The client is not the permission
boundary: the worker must independently restrict observer dispatch to its read-only operations.
Expected structured blockers retain their safe codes; malformed, timed-out, oversized or runtime
failures never become successful status or application observations. Historical protocol 2 stays
unchanged. SDK `.10` supplies the accepted evidence/plan/private protocol schemas; actual generic
worker activation and installed read-back remain the following delivery slice.

### Format-3 durable application and resource receipts

`ServicePlanStore` extends the same format-selected `.cordis` journal for application events,
resource receipts and committed composition snapshots. It reuses `InstallationWriter` and the
existing private atomic no-overwrite publisher; there is no second lock or mutable active pointer.
Application events have a contiguous global order and per-application sequence. Canonical intent,
installation, engine, exact saved plan and idempotency key bind acceptance before any effects.
Only one application may be pending. Uncertain failed effects require explicit repair; a new
request cannot silently adopt them. Identical keys recover the existing exact application while
conflicting intents block. Accepted requests bind the current composition/resource-set digest.

Immutable resource receipts bind scope, creator generation, definition/actual/content/image
identity and referencing compositions. Snapshots bind exact receipt bytes and target observations.
A completed ready event requires a previously published matching snapshot with ready target
acknowledgements. Read-back validates the entire ordered journal and installation scope without
opening the original bundle. A writer already held by the durable worker publishes plans and
records under that same authority. This persistence qualification uses explicit observation
fixtures; only actual engine/probe inspection in the worker can produce runtime readiness.
Historical journals and migration remain separate explicit boundaries.

### Immutable native service-provider staging

`ServiceProviderStager` prepares a selected container or probe only after its exact plan has a
persisted accepted application under the installation writer. It freshly validates the local
bundle against the saved plan, derives the selected package's complete runtime dependency/peer
closure, and copies only those verified archive files into an installation-private immutable
manifest directory. Unrelated bundle packages cannot change that provider identity. No imports,
package-manager commands or lifecycle scripts occur during staging. A later accepted activation
loads the exact named export through SDK's verified native provider loader, using the service's
installation/instance scope and validated configuration. Cordis owns construction and disposal.

Staged manifests and closure files use 0400, containing directories 0500, inside private 0700
store directories. Existing complete identities may be reused after full read-back verification;
unknown or interrupted staging state requires explicit repair. Descriptor-anchored extraction,
canonical manifests, no-overwrite publication and the same installation writer preserve scope
and byte identity. This stage does not start containers or claim target readiness. Engine/probe
qualification and actual retained-resource activation remain the following worker delivery.

The held installation writer pins its owner record's bytes and file identity. Replacement or
mutation fences that handle permanently; closing a fenced handle preserves the uncertain lock
and closes descriptors without deleting another owner's record. Explicit repair is required.

### Service-scoped private slot custody

`ServiceCredentials` prepares accepted service slots only under the current installation writer
and a durable application's prepare phase. It is part of the coherent journal/security boundary,
not a replaceable authorization policy. Owner containers/probes receive only typed scoped readers.
Random/UUID slots retain their original bytes; compatible derived slots retain their exact bytes
and receipts. A changed definition uses a new private version rather than overwriting an old
record. Logical `secret://<service>/<slot>` references are independent of private physical paths.
All directories remain 0700 and values/receipts 0600. Plaintext never enters plan/status/output.

Preparation validates the full reference graph and explicit dependency grants before creating
anything. It resolves only bounded secret/template data from the accepted owner projection;
no executable interpolation, ambient files, imports or lifecycle scripts are allowed. Cross-service
reads require the selected service's explicit grant and probe readers also require their declared
reference allowlist. Foreign/incomplete/unreceipted or changed files block instead of generating
replacement values. Receipt identity includes installation/service/slot/definition/content and
creator generation, so an unrelated added service cannot rotate existing credentials or authority.
Only the worker's actual observations can commit a ready composition; preparing files claims none.

Prepared values are limited to 4 MiB per materialization and 64 MiB in aggregate. Template
expansion is bounded during resolution, before private publication. `mount(service, slot)`
returns only the verified private path/resource/digest for an explicitly declared own-service
mount; it grants no arbitrary path choice. Probe access remains a separate reference allowlist.

### Exact installed image preparation

`ServiceImages` stages only the selected verified native OCI manifests/configurations/layers
from an accepted local bundle, under the application's stage phase and existing writer. It uses
a fixed verified local Unix endpoint for effects, while checking the selected context and daemon
identity before and after preparation. No registry pull, container startup, package script or
credential generation occurs. Exact already-present images may remain shared.

Private image cache entries contain the selected OCI closure, complete load archive and verified
binding record. Reuse freshly checks bundle/prerequisite bytes and the daemon's exact immutable
image identity; missing, foreign, incomplete or changed cache state blocks instead of overwriting
or adopting it. The result maps logical image IDs to actual immutable engine identities for the
bounded actuator. It makes no protocol-ready or active composition claim.

### Generic accepted service engine

`ServiceContainerEngine` executes only the saved format-3 plan's selected service definitions
under the existing installation writer and a current `activate` event. Each service receives a
`ServiceExecution` context and `ScopedServiceEngine` facade; a provider cannot start a different
instance or substitute a definition. These are adapters over the native Cordis services, not an
additional resolver or plugin lifecycle. Package classes remain mounted by Cordis.

The engine creates one owned network, instance-owned named volumes and digest-selected containers
through the pinned Unix Docker endpoint. It records actual resource identities, creator generation,
physical definition digest and referencing compositions. Existing exact resources require matching
receipts and labels; uncertain or foreign names block. It never pulls/builds images, reads arbitrary
host paths, enables privileges or changes an existing container implicitly. Credential mounts come
only from `ServiceCredentials`; API observer mounts require the explicit profile grant. Private
control sockets are never mounted. A subsequent worker slice supplies that observer directory.

`ready` in this engine reports only the absence of protocol qualification, even for running
containers. `ServiceRuntimeInspection` verifies resource identity, running state and direct probe
endpoints; only selected owner probe classes may establish readiness. No container-running result
can complete an application. Tests use a genuine pinned Node image with a compiled TypeScript
fixture service, explicitly disposable and independent of application/Keycloak readiness.

The development-only `./testing/runtime` export provides `ServiceRuntimeFixture`. It produces
its own compiled class service/image from the previously qualified exact Node base digest,
exports native OCI bytes, and constructs genuine provider archives and private slot declarations.
It pulls that exact fixture prerequisite only when absent, before invoking the engine; deployment
never pulls it. Cleanup selects only this fixture's unique project labels and image tag. This
producer is neither an application release nor evidence that API/Keycloak readiness is complete.

### Native per-instance container and probe scopes

`ServiceNativeScope.prepare` stages exact container/probe manifests during the current accepted
`stage` event. `ServiceNativeScope.open` imports them only during the matching `activate` event
and mounts both classes, the typed execution context and scoped engine adapter in native Cordis.
There is one actual Cordis scope per instance, with no provider instance cache or role dispatch.
Container initialization starts only its accepted definition. The selected probe implements the
owner protocol; running Docker resources alone never establish readiness.

Readiness uses a fresh verified direct endpoint, fixed accepted generations, an absolute deadline,
and only explicitly granted credential callbacks. The initial scope slice refuses authority export
until the generic authority custodian is implemented. Probe failures and malformed results return
safe unready observations. A timed-out call retains its native lease until its promise settles;
repeated calls cannot bypass that pending call. Scope disposal drains accepted leases and fences
an uncooperative scope instead of claiming completed cleanup. Closing provider scopes does not
stop installed containers or discard durable resources. A later worker owns application commit.

The native-scope program exercises two actual HTTP probe instances and a separately identified
probe-boundary fixture. That fixture returns wrong-instance and secret-like results, a false result,
and a late promise before qualifying immutable context and own/granted callback restrictions.
Neither malformed output nor late credential access is accepted. The late promise retains its
native lease; subsequent calls report pending until it settles. This qualifies the probe boundary,
not a replacement for the genuine HTTP or eventual API/Keycloak protocol tests.

Absolute deadlines are checked again when a probe promise settles. A blocked event loop must not
allow a late success through merely because its timeout callback has not run yet.

### Durable application coordination root

`ServiceApplicationRuntime.start(plan)` constructs the actual native Cordis host root and exposes
`submit`, `status` and `application` through the typed `ServiceApplicationHost` contract. Its
application plugin owns one installation writer and drives the existing format-3 journal through
validation, staging, private preparation, native service activation, protocol readiness and commit.
This is one coherent transaction authority over the existing store, not a second journal/resolver.
Native Cordis scopes own all selected container/probe instances and their cleanup.

The initial host accepts an unused format-3 installation only. It refuses historical applications
or uncertain prior effects; restart/adoption and explicit historical-format migration are subsequent
qualification. A submission first durably records its idempotency-bound intent, then returns an
application ID. Only a snapshot of actual receipted resources and ready selected-probe acknowledgements
can complete as ready. Status freshly probes the live scopes. Failures expose safe codes, preserve
evidence/resources and fence uncertain effects for explicit repair. Lost-response retries within the
running host return the same application; conflicting intent and concurrent new work are refused.

Closing the host drains its native scopes and releases its verified writer without stopping installed
containers or deleting credentials. Tests spawn the built host program and genuine fixture containers;
this qualifies the application coordinator, not yet the standalone durable worker/socket installer,
API/Keycloak application composition, retained active transitions or source acquisition.

Application validation rechecks the qualified host, storage, pinned daemon/capacity and listening
port before staging. A newly occupied publication produces a failed validation record with no
artifact store, credentials or runtime effects. Unready partial activation keeps its receipts,
returns no active composition/acknowledgements and reports an explicit repair blocker. Tests
establish both failure paths at the built-program boundary, in addition to successful/stopped
applications and a stopped-after-commit status check.

`ServiceApplicationRuntime.close(timeoutMs)` stops admission and drains accepted leases. If the
bound expires it reports pending and fences admission; it does not report successful cleanup.
After the known calls settle, a later close can finish disposal and release the writer. A fresh
unused installation may then reopen; installations with historical applications still require the
future explicit recovery path.

### One native installation authority

The host's existing store and writer are supplied by the native `deployment.installation` core
provider. Application coordination and the forthcoming private socket provider inject that same
authority; neither acquires a second writer or creates a parallel journal. It validates saved plan,
installation identity and unused state before dependent plugins start. Native dependency disposal
closes listeners/application scopes before releasing the writer. Constructor failure and deferred
close retain the existing conservative repair behavior.

This core authority is one coherent storage/ownership invariant, not a replaceable permission
policy. Installed third-party container/probe classes receive their separate service scope and
bounded engine/context only; this host-private capability is absent from those scopes. The public
application submit/status/application interface remains unchanged. Default built-program tests
must still prove durable application behavior and verified writer cleanup through this construction.

Accepted background applications retain a native lease on installation authority until their
actual promise settles. An immediate host close therefore reports pending even after submit's
response lease has been released. The built program verifies that admitted work finishes, then
native disposal releases the single writer. `ServiceApplicationRuntime.describe()` reports the
actual selected host-provider identities/readiness for default-root qualification.

### Separate private observation and owner control endpoints

`ServiceHostRuntime.start(plan)` mounts application, installation authority and Unix-socket protocol
providers in one native host root. The observer endpoint is `.cordis/run/host.sock`; it accepts only
format-3 status/application queries. The owner endpoint is `.cordis/control/worker.sock`; its initial
slice adds submit/status/application. Other owner requests remain explicitly unavailable until their
implementation. No remote installer endpoint or additional public operation ID is introduced.

Directories are owner-private 0700 and sockets 0600. Endpoints bind through held directory descriptors;
clients check socket/parent identities before and after exchange. Frames are strict bounded JSON,
with absolute deadlines, bounded connections and safe failure codes. Each accepted dispatch retains
a native application lease, while accepted applications retain installation authority independently
of the response connection. Losing a response cannot cancel or duplicate accepted intent.

The API receives only the observer mount in the forthcoming qualified worker profile. Control is
never mounted there. The server enforces observer refusal independently of client convenience APIs.
`ServiceWorkerOwnerClient` is owner-local; existing `ServiceWorkerClient` stays read-only.

Closing the host first stops socket admission and drains accepted requests, then disposes the native
root. Socket identity changes cause refusal, preserving unfamiliar entries. Verified ordinary close
removes only its own socket files and leaves private runtime directories/bookkeeping; a future start
refuses that prior runtime state until explicit recovery is qualified. A new host never adopts an
existing socket or directory. The standalone pinned worker installer remains a subsequent slice.

A failed second endpoint initialization must close the first listener it actually created while
preserving the unfamiliar entry that caused the failure. The failure test injects that filesystem
conflict inside a disposable fixture; its bounded fault injection is separate from the unmodified
default-host program. Initialization failure never authorizes adoption or deletion of foreign state.

Qualification uses Node 24.19.0's documented Unix-socket unlink behavior:
[Node IPC paths](https://nodejs.org/download/release/v24.19.0/docs/api/net.html#identifying-paths-for-ipc-connections).
The implementation checks its socket identity before normal close, which otherwise unlinks the
path. The built program verifies refusal/preservation after a replacement and explicit fixture
restoration, malformed/multiple-frame refusal, secret-canary redaction, and recovery of a discarded
accepted response through the original idempotency key. This is private host RPC qualification;
source resolution/acquisition and the standalone executable launcher remain subsequent work.

### Pinned standalone worker bootstrap

The forthcoming `ServiceWorkerLauncher.apply` verifies the saved plan's exact standalone worker
bytes and starts that worker with a bounded owner-only bootstrap handoff. An initial installation
writer creates an immutable private launch intent, publishes the exact executable and records its
child PID. Only after releasing that writer does the parent publish the handoff-ready record. The
selected child verifies its PID, nonce, executable identity and exact plan before acquiring the
single installation writer. Other callers cannot adopt that launch state. Concurrent launch,
interrupted handoff, unavailable/tampered worker bytes and stale runtime state require explicit
repair; there is no automatic lock deletion, process adoption or alternate runtime fallback.

The child mounts the real native host root and separate private observer/control endpoints. An
accepted application is still recorded before image/resource/credential effects. Parent response
loss is recovered through the same idempotency key and owner channel. Standalone execution needs
only the qualified Docker CLI on PATH; it never invokes an ambient Node/Bun/package manager.
The executable is built before planning through the owner's public build-time producer. Planning
and apply do not compile it. Graceful host shutdown preserves installed containers and durable
records; general restart/recovery remains Task 6. No original installation is launched by tests.

### Endpoint layout and alias refusal

Every accepted connection and parsed request verifies the entire known observer/control endpoint
layout, not just the pathname used to bind that listener. Socket link counts must be one; changed
inode, ownership, mode, symlink or unexpected entries refuse dispatch. This protects the observer
boundary from a linked alias of the control socket, independently of convenience client methods.
The built regression creates/restores only fixture-owned aliases and proves no application is
accepted. It does not treat arbitrary same-user host code as sandboxed.

The bootstrap-primitive fixture copies a genuine Node executable and runs an owner-built TypeScript
process fixture to isolate PID/nonce/executable ownership transfer. It proves selected-child claim,
interrupted/wrong/malformed handoff refusal and private writer release without runtime activation.
It is explicitly not the compiled production worker/launcher qualification. That producer and fixed
standalone entrypoint are the next slice. Malformed private launch records produce safe typed
blockers and remain unchanged.

### Standalone format-3 worker producer

`ServiceWorkerBuild.produce(directory)` is a build-time public interface. It requires an empty,
owner-private directory and Bun 1.4.4, compiles the fixed owner entry for Linux x64, and returns
`{path, sha256, size}` for the resulting immutable `worker` executable. It accepts no source entry,
compiler flags or application scripts. Release assembly copies and pins those exact bytes before
planning. A failed producer leaves its private evidence for explicit cleanup; it never overwrites
an existing output or runs during plan/apply. Compilation follows Bun's documented
[standalone executable interface](https://bun.com/docs/bundler/executables).

The standalone worker accepts exactly `--installation`, `--plan`, `--digest`, `--nonce` and
`--protocol 3`. It reads the saved plan, waits for the selected-child ownership handoff, and starts
the production native host root without auto-submitting an application. Invalid arguments exit 2;
failed startup exits 3 with no raw exception or credential output. SIGTERM/SIGINT drain accepted
work and native scopes before releasing the writer and private listeners. Failed bounded shutdown
exits unsuccessfully and retains uncertain state. It never stops installed containers implicitly.

The built executable qualification uses Docker-only PATH and genuine disposable service images.
It verifies five-instance application/read-back, same-key response-loss recovery after removal of
the original bundle, selected-child writer identity and shutdown that preserves resource IDs.
This qualifies the real compiled entry; the separate bootstrap fixture continues to isolate
malformed/interrupted ownership cases. Public host launcher integration is the following slice.

The worker hashes its executable on first verification. Only that process may reuse the verified
digest while both the saved selected-child record and fresh `/proc/self/exe` identity match the
same private inode, size and pinned digest. Linux prevents write access to a running executable
inode ([open(2), ETXTBSY](https://man7.org/linux/man-pages/man2/open.2.html)); this is not an
mtime-based cache. Every inspection still checks path, owner, mode, link count and launch records.
External readers and changed identities hash afresh or refuse the record. A built canary checks
kernel write refusal and rejects replacing the pathname even with identical executable bytes.
This removes redundant synchronous hashing from journal operations without accepting mutable
worker contents or extending the private RPC deadline.

### Default installed host, format 3

`new ComposeDeploymentHost().apply(planId, digest, {installationDirectory, idempotencyKey})`
selects the saved installation format. For format 3 it reads the exact stored plan, verifies a
native Linux x64 ELF worker before any launch state is written, and exclusively prepares its
private bootstrap. It spawns that pinned executable with fixed private flags, hands off ownership,
waits for the verified selected child, then submits the request through the owner endpoint.
It never compiles, downloads or invokes a shell/package manager during apply. The returned
`{id, accepted:true}` acknowledges durable acceptance; callers use application/status for readiness.

An existing verified worker handles repeated requests without another launch or bundle access.
The same idempotency key recovers the same application after the caller exits or loses its reply.
Private process/executable/writer identities are checked before owner submission. Foreign,
incomplete, stopped or uncertain host state requires explicit repair; no adoption, alternate
executable, automatic restart or lock deletion is allowed. Failed startup retains private evidence.
Public `status` and `application` read format-3 observations through the readonly endpoint.
Historical format-2 behavior remains separately selected by its stored format.

The default built-caller qualification runs with Docker-only PATH and starts the genuine compiled
worker. It exits the first caller, repeats the exact request, observes all five fixture services,
removes the source bundle and reads/replays again, then verifies graceful worker stop preserves
resources and a new apply does not silently restart it. A script-worker canary is refused before
launch publication or script execution. Active composition transitions remain the next contract.

### Verified plan bindings and observation contract

The resolver derives `plan.runtimeBindings` from native runtime declarations only after verifying
their exact package closure/entry and selected OCI labels. These accepted bindings are part of the
saved plan bytes. Fresh application validation compares them with newly verified artifacts before
effects; earlier plans without native runtime images keep the field absent.

`ServiceWorkerClient.observationContext(serviceId)` uses readonly private protocol operation
`observation.context`. The native application host requires a durably accepted application and
returns safe accepted identity/dependency metadata from its saved plan. It performs no readiness
probe, mutation or source-bundle access. Dependency endpoints are declared TCP transport addresses;
their typed owner contract determines application protocol. Unknown/unaccepted services fail safely.
The response makes no active/healthy claim and contains no private paths or credential bytes.

Native probe contexts receive a deeply frozen copy of this metadata. This enables direct/routed
owner probes to compare API-measured package/entry content and accepted service generations while
the engine independently verifies actual resource/image identity. It avoids a health endpoint
recursing through overall worker readiness. Every public SDK operation and historical transport
remains unchanged; private observation data does not confer write authority.

The host refuses observations before the application passes artifact validation, for unknown service
IDs, or after uncertain/failed application state. Observation reads do not inspect readiness or
mutate records. Runtime bindings come only from the accepted plan; external service images have
`runtime:null`. Data and dependency arrays returned inside the host are deeply frozen. The public
observer client validates response scope against the requested service ID. A probe's observation
identity must match its service, expected installation/composition/service generations and asset
digest. Dependency identities contain only its declared accepted bindings. Existing deadline,
cancellation, credential grants and native lease drain remain authoritative; metadata adds no
credential, host command or installation-writer capability.

### Declared public authority exports

`AuthorityArchive.read(bytes, filename)` inspects a bounded single-file public CA tar stream.
`LocalDockerCommands.archive(engine, containerId, path, timeout)` supplies the fixed no-extraction
container-copy transport. These privileged host helpers do not receive plugin authority from metadata.

`ServiceAuthorityExports(plan, writer?)` supplies custody behind `ProbeContext.authority(reference)`.
Its `read(serviceId, reference, { deadline, signal })` returns public certificate bytes; the optional
existing installation writer enables first publication only during accepted activation/readiness.
Only exact references in the service's readiness grant list are available, with cross-service
dependency/grant checks. `authorityIds` lists authority references; ordinary slot references remain
in `credentialReferences`. A probe receives bytes and bounded callbacks, never Docker commands,
host paths or the installation writer.

That custodian's first accepted activation reads a declared public CA certificate from a path beneath an owned
named-volume mount in its receipted container. The host verifies engine/resource identity and uses
Docker's bounded [tar-to-stdout copy](https://docs.docker.com/reference/cli/docker/container/cp/),
without extraction, shell/exec, helper container, link following or arbitrary host mounts. Accept
exactly one regular file, at most 128 KiB, containing exactly one valid PEM CA certificate and no
private-key/trailing material. Whole-stream output and deadlines are bounded.

Only a current accepted activation/readiness phase may publish a private immutable certificate
record and authority resource receipt. Existing exact exports retain their bytes, definition,
creator generation and fingerprint. Later status/probe reads verify saved bytes without creating
missing exports or repairing interrupted/foreign state. Expired/cancelled callbacks cannot publish.
Unknown files, changed definitions/content, scope/ownership/symlink failures and incomplete publication
require explicit repair. Named-volume and credential ownership remain with the existing service.
Tests use public fixture CAs and disposable service volumes; no original installation is accessed.

`AuthorityArchive.certificate(bytes)` applies the same strict PEM/DER/CA/validity policy to saved
certificate bytes. Authority receipts use `artifacts/authorities/<resourceId>.pem`, private 0700
parents and 0600 immutable records. Their definition binds service, authority declaration and
actual owned volume identity; content digest pins the public CA. Cached reads require matching
receipts and verify the complete authority directory without Docker copy or bundle access. Unknown
or missing files/receipts, symlinks and changed permissions fail instead of being adopted.

First publication verifies the actual source container and named-volume receipts before and after
the bounded copy. Deadline/cancellation and current accepted phase are checked after asynchronous
work and immediately before private publication. Concurrent requests re-read existing custody
before publication; interrupted certificate-without-receipt state requires repair. Probes cannot
request undeclared references, use authority references as ordinary credentials or obtain host
paths/writers. Disposable fixture CAs qualify this boundary; default Caddy and assembled Keycloak
remain subsequent acceptance.

### Native Postgres service and protocol probe

`PostgresServicePlugin` and `PostgresReadinessPlugin` are Deployment-owned native Cordis classes.
Their public descriptors bind `container.service`/`probe.service`, typed `storage.postgres@1.0.0`
and the `postgres` port. The engine remains independent of service IDs and database role names;
multiple renamed instances use the same provider with separate volumes, private password slots and
native scopes. The default declaration uses database/user `cordis`, a private `database-password`
slot and a writable `data` volume at `/var/lib/postgresql/data`. It has no public port by default.
Identity consumes the typed binding and its explicit credential grant through Identity's own plugin.

The prepared linux/amd64 Postgres 17.11 manifest is
`e4cb93687b062cd25a0e8f672d85a7708235009d70d31f8a7698d9370092a9c4`, selected from the existing
Task 3B pinned upstream index. Its normalized prepared index SHA-256 is
`d538f74d92b3b72ecfd667bc56b81c48695a819ba0b74526a9580657cec26acd`.
Planning verifies these exact local bytes; activation neither pulls nor builds an image.
The image reads its password through the documented
[`POSTGRES_PASSWORD_FILE` interface](https://hub.docker.com/_/postgres/).

Readiness uses pinned `postgres@3.4.9` over the accepted direct TCP endpoint and reads only the
probe's declared private password reference. It executes the fixed read-only `SELECT 1 AS cordis_ready`
query, with bounded connection/statement deadlines, no notices/debug output and awaited connection
teardown. Cancellation destroys the probe's own connection; raw driver errors and credentials never
enter observations. [Postgres.js teardown](https://github.com/porsager/postgres#teardown--cleanup)
defines the bounded close contract. No Docker exec, custom SQL, shell or new database authority is
exposed to probes.

Owner acceptance must run the genuine archived production classes through the default application
root with two renamed disposable Postgres instances. Verify both native bindings/readiness, separate
credential/volume identities, wrong-password refusal, cancellation and cleanup of connection effects.
The fixture producer may acquire the exact image before planning; the implementation path cannot.
Default Caddy, API/Keycloak assembly and retained active transitions remain subsequent slices.

### Bounded HTTP/TLS probe transport

`ServiceHttpRequests.read(context, { path, maximumBytes?, authorityReference? })` is the typed
Node transport contract used beneath owner-native protocol probes; `ServiceHttpClient` is its real
implementation. It returns exact response bytes, not an application-ready assertion. The selected
native probe still owns protocol validation, target acknowledgements and lifecycle. API health and
asset semantics remain API-owned.

The transport only sends GET to the accepted numeric service endpoint, with a bounded absolute path,
no supplied credentials/headers, no redirects, no content decoding and no ambient proxy transport.
The default response budget is 256 KiB; an explicit budget may be at most 8 MiB. Reject non-2xx,
truncation, excessive headers/body, unsafe endpoint/path, expired/cancelled work and incomplete close.
Every request has its own connection, bounded deadline and awaited close; no shared connection cache.
Errors contain a fixed safe code, never raw response bytes or network/TLS details.

HTTPS requires an exact reference in `context.authorityIds`; read its public CA through the bounded
callback and retain certificate-chain verification. Verify the certificate against the canonical
installation origin from accepted observation metadata while dialing the private service IP, using
[Node's `checkServerIdentity`](https://nodejs.org/download/release/v24.19.0/docs/api/tls.html#tlscheckserveridentityhostname-cert).
No TLS bypass, global trust store mutation, arbitrary URL or owner-local host path is accepted.
HTTP requires no authority reference. Method/path/byte admission and certificate handling cannot be
replaced with probe-supplied permission policy.

Built Node consumer qualification uses real HTTP and fresh private-CA TLS listeners, including a
certificate for `localhost` reached through an IP endpoint. Verify wrong hostname/CA, redirects,
oversize/truncation, stalled response cancellation, safe output and socket drain. These are explicit
protocol fixtures, not assembled Caddy/API/Keycloak evidence.

### Native Caddy edge service

`CaddyServicePlugin` is the Deployment-owned native `container.service` class for the default HTTPS
edge. It provides typed `edge.https@1.0.0`, depends on explicitly selected `platform.api@1.0.0` and
`identity.oidc@1.0.0` bindings and exports `public-ca` from its owned data volume. Dependency port
names express contracts; no container/service ID catalog or four-role limit enters the engine.
The provider owns its declarative Caddyfile, private configuration slot, data/config volumes and
restart-required policy. API owns the protocol-specific direct/routed health and asset probe.

The prepared linux/amd64 Caddy 2.10.2 manifest is
`d8c17a862962def15cde69863a3a463f25a2664942eafd7bdbf050e9c3116b83`; normalized index SHA-256
`521bf209930956584e111b7e9cf9b8608f0015a52c3a70fa814cc01aaadaa5e8`.
Use internal TLS without automatic trust installation, admin API, redirects or implicit route
updates. See [Caddy TLS](https://caddyserver.com/docs/caddyfile/directives/tls) and
[global options](https://caddyserver.com/docs/caddyfile/options#skip-install-trust). Forward the
existing bounded public OIDC paths to the selected Identity dependency and other paths to API;
exclude other Identity paths and pin forwarded origin headers. Resolve upstream addresses from
accepted typed endpoints. No arbitrary Caddyfile, command, host mount or external route is accepted.

Owner image metadata is a provider catalog. A bundle supplies exact artifacts only for selected
container definitions: an unselected Postgres/Caddy/runtime-image declaration must not require an
unused inventory entry. Continue rejecting unused inventory images, selected image mismatches and
ambiguous selected owners. Registering alternatives never implicitly selects their images/services.

A built default-root fixture must load the actual archived Caddy class, use two explicitly labelled
HTTP protocol fixtures at renamed dependency IDs, and verify real HTTPS proxy responses with the
exported CA. Check the private public-CA receipt, source-free status and unchanged CA/resources on
read-back; no host trust changes. This qualifies Caddy transport/configuration, not genuine API or
OIDC semantics. Real API/Keycloak direct+routed/browser assembly remains separately required.


Caddy fixture-build evidence: Bun 1.4.4, Node 24.19.0, jsonc-parser 3.3.1 and default
`bun build <entry> --target=node --outfile <output>` selected its UMD main and left an unresolved
`require('./impl/format')` in the archive. The fixture's explicit `--tsconfig-override` maps
`jsonc-parser` to the installed pinned `lib/esm/main.js`; the same native programme then passes.
This is a qualified fixture build configuration, not a general limitation of Bun or the library.

### Public package archive inspection

`PackageArchiveInspector.inspect(absoluteArchivePath, sha256)` returns the parsed package metadata
and a deterministic file index (`path`, SHA-256, size, original archive mode). File paths are
relative to the package root. This is the public Deployment artifact boundary for API image/runtime
auditing; consumers compare installed files and measured runtime entries without duplicating tar
parsing or importing archive code. It does not claim dependency-closure or application readiness.

Read the exact hash-pinned regular file through no-symlink descriptor-anchored access. Inspect the
archive without extraction, package-manager execution, imports or lifecycle scripts. Require valid
package identity and package-root paths; reject links, duplicate/traversal entries, invalid metadata,
truncation, ownership/path races and excessive input. Bound compressed input to 64 MiB, unpacked
contents to 64 MiB, file count to 4096, total entries to 8192 and individual files to 8 MiB; abort parsing as soon as a
budget is exceeded. Errors expose safe structured codes, not filenames, metadata or parser details.
No installation/store state is created. Built Node consumer tests use genuine prepared archives and
script/import canaries, plus wrong hashes, symlinks and an oversized entry.

### Privileged observer-directory mount

A format-3 service may request `workerSocket` only when selected by the profile's
`workerSocketServiceId`, running as the installation owner, with a verified owner runtime-image
binding. Deployment binds only the private `run` directory read-only at `/run/cordis-host`.
It contains exactly `host.sock`; owner control, writer authority, credentials and Docker.sock
are never included. A named volume or secret may not cover, replace or sit beneath this target.

Before Docker effects, open the directory without symlinks, verify its owner-private mode and
socket identity, and retain that descriptor through container creation. Bind the accepted
container receipt to directory/socket identities; check them and the actual read-only mount
before start and on later inspection. Missing, linked, replaced or incorrectly permissioned
endpoints fail closed. An uncertain create remains explicit repair state. A genuine fixture
must read accepted observations with the public client from inside a real container, prove
writes fail and owner submission is denied, and preserve source-free read-back. This does not
authorize implicit host-root restart or mounting the owner control endpoint.

Qualification note: on Ubuntu 26.04.1 / Linux 7.0.0-38, Docker 29.9.1 accepted an open
`/proc/<pid>/fd/<fd>` directory source at create time but runc rejected start with `EINVAL`;
adding `/.` or a child component did not qualify it. The same pinned Node image started with
the canonical directory source. The implementation retains the descriptor and checks directory/
socket identities and change times around the canonical-path create/start operations. This is
Docker's host-path bind interface, not descriptor transfer to its daemon. See the official
[bind-mount interface](https://docs.docker.com/engine/storage/bind-mounts/). No unsafe fallback
or extra directory is exposed on failure; an uncertain effect requires explicit repair.

The real container race fixture replaces and restores the observer socket after Docker create.
Without the pinned change-time checks, the regression starts the container and fails. With the
checks, it records explicit repair state before any start. No owner request is admitted.

### Public owner recipe materialization

`ServiceProjection.resolve(service, declaration, graph, configuration)` is the public data-only
preparation interface for owner image/integration producers. It validates the SDK container
projection and resolves typed dependency ports, configuration/context markers and explicitly
granted secret references into a service definition/resource declaration. It does not import
provider code, open credentials, write installation state or activate resources. Planning still
independently verifies the exact package projection, complete bundle and resulting recipe.
Consumers use this package export rather than private source files or their own resolver copy.

### Redundant peer metadata in Bun lock v2

Genuine `ajv-formats@3.0.1` declares AJV both as a regular dependency and as an optional peer
with the identical `^8.0.0` range. Bun 1.4.4 records the regular dependency once and omits the
redundant peer/optional-peer fields. The installed bundle reader recognizes that exact
normalization: a peer duplicated by the same regular dependency/range need not appear again in
lock metadata. Every archive-declared constraint is still checked against the one locked version;
missing regular dependencies, conflicting peer ranges, undeclared lock peers and integrity
mismatches remain blockers. Unselected optional peers remain optional only under their explicit
archive declaration and matching non-redundant lock metadata. This changes no activation policy.

### Multiple probes of one runtime target

A service's direct probe and a routed HTTPS probe may attest to the same target/scope.
Commit and fresh status must coalesce byte-equivalent validated acknowledgements, preserving
one target record. Every acknowledgement must be ready and bind the expected composition.
Conflicting runtime generations, observation digests or other fields for the same target/scope
block acceptance; they are not resolved by arrival order. A conflict during fresh status
reports not-ready with no acknowledgements. Per-service readiness remains independently required.

### Planning against an accepted live composition

An active format-3 installation plans through its existing owner-control endpoint and held
single writer. The default public host delegates to that endpoint; it never starts or adopts
another root. The host freshly verifies current readiness, engine/resource identity and the
new exact local bundle before publishing. A missing owner or uncertain state blocks planning.

`ServiceTransitions.plan(previous, desired)` is a data-only owner projection: stable service
identities are retained, private additions are additive, changed existing services carry explicit
restart/migration actions, and removals remain unsupported. Readiness-only changes retain
physical resources but still require explicit scope restart authorization. Dependencies affected
by a changed service are reported. Never infer restart or migration permission from a plan.

Plans bind the accepted previous composition/resource-set digest and retained resource receipts.
Only new/changed service effects are reported; existing credentials, volumes, containers and TLS
authority remain unchanged by planning. Saving/read-back of a prepared transition is not
activation. The next apply slice must separately enforce required actions, stale generations,
retained identities and fresh target acknowledgements before claiming the new generation active.

The private planning exchange has a bounded 180-second response window after a validated
owner request. Other frames and observer reads retain their existing ten-second bounds.
A lost planning reply never reports activation; repeat requests freshly validate the same
inputs and may read back the same immutable saved plan.

Live transition planning preserves the accepted desired runtime state and worker executable.
A runtime-state change or host-binary replacement is outside the qualified additive boundary
and blocks without a new saved plan. Those transitions require their own explicit qualification.

### Applying a qualified private addition

The existing host may accept a saved plan whose expected composition/resource set matches its
current accepted snapshot. For the additive slice, only `add`/`retain` changes with no required
actions are executable. Any restart scope or replacement/migration/removal remains action-required
until its separately qualified apply slice; the installer must not infer permission.

Under the same writer and native host root, freshly validate the new bundle and previous physical
identities before staging. Reopen bounded service-control scopes through native lifecycle while
retaining existing containers, volumes, credentials and CA exports. Extend receipt references
without overwriting historical bytes. Commit only after every selected service and actual target
acknowledges the desired generation. Repeated accepted requests read back their durable identity.
Partial effects retain evidence and require repair; nothing rolls back uncertain state implicitly.

SDK `.13` adds optional restart-intent contracts. This slice records/verifies those optional fields
correctly for read-back, while the host rejects restart-bearing submissions before accepting intent.
That contract adoption does not qualify a restart. Existing format-1/2 schemas and artifacts remain
immutable, and no second host or writer is started for a retained transition.

Exact SDK adoption for this slice: `.13` source
`752b6fd5909eae15a30f1d7519d16e1f4a40a75b`, archive SHA-256
`dca6c416b8cdf977f021efb632e82e8b1b2f2d1b4a61108fe27a5b59e5848e2c`.
Force a fresh local archive install and read back the installed contract identity.

Cold module entry is an executable boundary: loading the application/host/IPC/planning modules
first must work in both Bun and built Node consumers. Internal implementation imports must not
route through the public composition barrel. The default Docker command class belongs in one
leaf module and remains publicly re-exported; the host's token initialization cannot depend on
a previous unrelated import warming the module graph.

### Explicit scoped container replacement

An active format-3 host may execute a saved replacement/reconfiguration plan only when its
caller supplies `restartServices` equal to the exact set of restart-bearing service changes.
Missing, extra, stale or initial-install scope is refused before intent. Migration, retirement,
state-version changes, resource/secret ownership changes and worker replacement stay blocked.
The owner independently derives the transition from its accepted plan and freshly validates all
artifacts and previous physical identities before admitting effects. The accepted application
record binds the scope before any old container is stopped or removed.

Only explicitly authorized changed containers may be replaced. Every retained container, named
volume, credential slot and CA remains physically identical; historical receipts are immutable.
A running replacement uses its actual new container identity and protocol observations before
committing the new snapshot. Historical container receipts remain evidence rather than being
reinterpreted as current resources. A failed/interrupted replacement preserves its accepted
intent and partial receipts and fences further writes for explicit repair. There is no automatic
restart, rollback, resource deletion beyond exact authorized old containers, or second host.

The outside-in programme must run through the real compiled durable worker, change one selected
fixture container provider, verify an observable new response and physical ID, preserve all
unaffected IDs/private bytes, reject missing/extra scope and migration, and read back/replay after
original source removal. Final API-image/UI-only restart qualification remains an assembled gate.

Returning to a previously selected container definition is a fresh physical replacement, even
when its bytes and metadata match historical inputs. Allocate a fresh resource identity for
the new container while preserving the earlier immutable receipt; never overwrite the earlier
actual Docker identity. Unchanged current definitions continue to retain their current identity.
The compiled programme must replace and then revert one service under exact explicit scopes
and read back all three accepted requests after removing source. Interrupted scoped restarts
must leave the prior committed snapshot and private bytes intact and refuse further writes.

A composition digest describes desired inputs, rather than a unique running incarnation.
Returning to exact earlier release bytes may repeat that digest with different physical
resources. Journal read-back must bind the completed record's resource set and target
acknowledgements to its exact immutable snapshot, preserving every earlier snapshot.

Retained container identity comes from the verified saved plan's retained resource binding.
Fresh container identity binds its creating plan. Runtime inspection freshly checks physical
IDs and labels before effects, while generation-aware selection reads the current snapshot
and receipts to identify actual resources. Avoid repeated whole-journal reads for immutable
identity computation or for services with no restart action; keep physical inspection and
accepted-intent checks at every existing effect boundary.

### Shared service-intent contract alignment

The replacement fixture preparation selects SDK `.14`, source
`597a9abd79b76fb292a80cd86e4ea83042fbec62`, archive SHA-256
`c92fb068064a6db4823b29c31602b47e01c21200af759a770480a1a0cc4240a2`.
Use forced fresh installation and read back installed identity, vendor bytes and lock SRI.
This aligns future explicit instance/binding intent with UI/Identity/Admin candidates while
preserving the existing restart contract and seven operation IDs. Schema adoption and fixture
preparation alone do not grant replacement or source-install activation.

### Status during accepted application

While an accepted application is validating or changing the installation, status projects the
last committed snapshot with `ready: false`, no acknowledgements, an `APPLICATION_PENDING`
blocker and `application.pending` per-service observations. It performs no target readiness
invocation during that interval, preserving activation's exclusive readiness qualification.
The committed resource set remains explicitly the prior accepted set until the new snapshot
is committed. Steady status resumes fresh physical/protocol verification afterward.

An exact desired generation may recur with a different physical incarnation. Select the latest
completed application matching the committed snapshot, and report that snapshot's resource
identities. A historical desired-generation match cannot select an earlier container receipt.

### Current-phase effect permission

Container actuation, image/package staging, credential preparation and authority-cache publication
require the latest accepted application record for the exact saved plan and digest, the same
installation writer, an appropriate current phase and no recovery fence. A historical stage,
prepare or activate record grants no later permission. Failed and completed applications cannot
reuse a retained adapter to perform another effect. Admitted completed authority-cache reads remain source-free and read-only. An initial failed
application without completed admission refuses even cached access; no read repairs custody.
`records()` is a latest-state view per application, and the journal admits only one pending
application, so existing phase scans already enforce this permission invariant.

The genuine authority programme retains real adapters and an owner writer, records failed state,
then attempts all five effect seams. Typed refusals and unchanged private/resource inventories
are required. Valid default phase paths remain covered by their normal compiled programmes.
The programme verifies the existing permission invariant; it introduces no policy provider
or replacement runtime permission implementation.

### Durable plugin request custody

Plugin install/select is owned by Deployment and accepted through the installation owner,
never the observer endpoint. Before source access, the host persists the validated canonical
intent, caller-visible idempotency key, pinned expected composition and approved policy digest.
The same key recovers the exact accepted request and source resolution; changed intent or
policy conflicts before network/build work. A new bare CLI invocation generates a new key.

Private append-only request records live at `.cordis/plugins/requests`; an atomically replaced
private `head.json` commits the exact event count and final digest. A missing tail or an event
published without its matching head is uncertain state requiring repair. Each event binds the
prior event digest and a monotonic sequence; the original request identity and policy never
change. Resolution is persisted before archive acquisition; acquired source identity is
persisted before registration/activation. Existing accepted resolution/artifact/result values
cannot be replaced by retry. Unknown, interrupted, non-private, foreign or malformed state
fails closed rather than being adopted. Failed publication can leave private incomplete
state requiring repair. Installation's existing writer controls these records; registry
metadata grants no authority and adds no second dependency resolver or writer.

Request inspection/listing returns safe typed results and caller-visible keys, including
incomplete requests; it never exposes source credentials, configuration values or build output.
Only exact target observations may produce active/already-active. Prepared/pending/blocked
remain non-success activation outcomes. Acquisition/build and activation are separate bounded
continuations; this persistence slice itself imports no package and starts no container.

### Privately managed acquisition tools

Ordinary source acquisition uses exact release-pinned Bun/Git helper bundles, never ambient
Node/Bun/NPM/Git or a global tool installation. A trusted release identity must match the
plan's verified helper inventory before any helper can execute. The helper release identity
is SHA-256 of canonical `{formatVersion: 1, helpers}`; the CLI release pins that identity,
so repeating its label with a changed helper table is insufficient. Selected helpers bind native
Linux/amd64, exact version/archive size/hash, complete regular-file hashes/modes, entrypoint
and approved library/executable directories. Symlinks, extra/missing files, changed modes and
incomplete caches refuse safely. Hashes identify a helper; its approved release remains the
trust boundary. Installed service plugins receive neither this custody nor the owner writer.

Preparation follows a durable plugin request in resolving/resolved state, using that request's
actual owner writer. Helpers stage in owner-private artifact storage; publication follows full
archive/file verification. Complete accepted helper bytes are immutable and reused only after
fresh file/directory/entry checks. Reuse is independent of the original source bundle/network.
Invocations use exact verified executable descriptors, bounded arguments/output/deadlines and
a private working directory, with a minimal controlled environment and no inherited production
credentials or user tool configuration. Private helpers do not change global PATH or packages.
A Docker-only ambient PATH must still run genuine helper version/package operations.

The initial custody qualification uses the genuine pinned Bun binary as an explicitly identified
helper fixture. NPM/Git source resolution, trust decisions, lifecycle suppression, normalized
closure production and isolated approved builds remain source-adapter continuations. No container
or installed provider is activated by helper preparation.

The selected standard package manager supports registry metadata via [bun info](https://bun.com/docs/pm/cli/info)
and script suppression through [--ignore-scripts](https://bun.sh/docs/pm/lifecycle).
These documented APIs guide qualification of Bun 1.4.4; they do not replace the executable tests.
Git configuration isolation follows the [Git environment contract](https://git-scm.com/docs/git).

Helper processes run in a separate process group. Deadline/output failure kills that group and
waits for direct-child close. A helper that exits while retaining a live group member is refused;
its known group is killed and never reported as a successful operation. Qualification includes a
trusted child-process canary. This is lifecycle custody of approved tooling, not a sandbox for
untrusted package code; source-only builds require the separate approved isolated build adapter.

### Exact source-policy planning custody

A format-3 release may carry the SDK's versioned `acquisitionPolicy`. The default planner
validates its exact helper-release binding, canonical build-policy identities and every
hash-pinned public CA file before saving the plan. Policy semantic sets and object keys
normalize deterministically. The plan carries the accepted policy as data; missing policy
stays absent and authorizes no source acquisition. It is never inferred from package metadata.

Source access must match an explicit registry/origin, package and selected target grant.
Build/live qualification records remain exact owner-approved inputs, not a provider's permission
to replace itself or read credentials. Source CA references are confined to the prepared bundle;
symlinks, traversal, changed bytes, wrong helper roots and ambiguous grants block before plan
publication. Plan read-back requires no original bundle, credentials, network or helper execution.
Policy changes use an exact reviewed bundle and plan/apply; they do not implicitly restart
unchanged services or create a source/build/activation authority.

### Retained exact release artifacts

Accepted staging preserves an allowlisted, exact copy of release metadata, package archives,
selected OCI index/manifest/configuration/layers, worker bytes, prepared helper archives and
public source-trust files under private `.cordis/artifacts/releases/<release-digest>`. It copies
no unrelated bundle files and executes nothing. This custody allows later source installation
to assemble a successor from original accepted archives after the external bundle is removed;
repacking unchanged packages would change archive hashes and break runtime-image identity.

The existing writer and an exact current stage or acquisition request authorize preparation.
Files publish atomically as one complete immutable cache entry; existing entries are verified,
never overwritten or silently repaired. Directories are private, retained bundle directories
are 0500 and files 0400 (worker bytes 0500). A receipt binds scope, exact file identities and
modes. Cache opening checks receipt/scope and exhaustive inventory; every consumed file checks
its pinned bytes, and full verification streams every retained file. Links, wrong ownership,
changed modes, extra/missing files or interrupted entries refuse. No active/healthy claim or
resource reservation follows from cache custody. Read-back and exact reuse need no original
bundle, package manager, imports, scripts or new runtime resources.

Large retained files use asynchronous descriptor reads/writes and verification. Staging yields
between files and chunks so pending owner/observer status remains responsive; copying a worker
or image must not monopolize the durable host's event loop. The built custody test observes
partial progress through a large inspection-only worker fixture before publication, alongside
the existing concurrent-status compiled application tests.

### Exact NPM resolution (Task 3C bounded source prefix)

`NpmSourcePlugin` is a native Cordis provider for `source.npm`, injected with the existing
host-private installation authority. Its typed `PackageSourceResolver.resolve(record)` accepts
a previously persisted install intent and returns its durable exact resolution. It never imports
a plugin, runs package lifecycle scripts, downloads a package archive or activates a service.
The public `NpmSourceRuntime.start(plan)` exercises the same default native construction;
production host adoption uses that provider in the existing host authority scope.

The accepted release must grant the package and target at one unambiguous HTTPS registry,
bind a prepared Bun helper and optionally pin public CA bytes. The provider preserves the
exact release in installation-private custody, checks the real managed helper version and runs
`bun info <locator> --json --registry=... --no-cache --ignore-scripts --no-env-file` with its
private environment and optional pinned `--cafile`. Bun owns normal package/range/tag selection;
the adapter checks the returned name, exact version, SRI and same-registry HTTPS tarball edge.
It commits the canonical metadata digest and helper identity before any archive acquisition.
See [Bun info](https://bun.com/docs/pm/cli/info) for upstream selector semantics; the installed
Bun 1.4.4 fixture qualifies these exact flags rather than relying on documentation alone.

Repeated resolved requests return the saved version even after a registry tag moves or the
source disappears. A request left resolving without a committed resolution refuses another
mutable lookup and requires explicit repair; it never guesses which version an earlier reply
would have selected. The future host coordinator must join an in-flight request and report
bounded pending progress. Publisher/source approval remains separate from archive integrity.
This prefix provides no complete source acquisition, dependency closure or activation claim.

For custom source trust, hold the exact private CA file descriptor for the managed lookup and
verify its identity and bytes before committing resolution. A file modified and restored during
an otherwise valid TLS response is a trust race and must leave the request unresolved. Passing
a path to a certificate file is not sufficient evidence of which trust bytes the helper used.

### Verified NPM archive custody (Task 3C bounded acquisition prefix)

`PackageSourceResolver.fetch(record)` and the default `NpmSourceRuntime.fetch(record)` consume
an already committed exact NPM resolution. They fetch its same-registry HTTPS tarball with
certificate/hostname verification, no ambient proxy/credentials, no redirects, a deadline and
a 64 MiB compressed limit. SRI is verified before read-only archive inspection. Package name,
version, native Cordis package declaration, declared entries and asset bytes must match the
resolution and inspected archive. No extraction, imports, package manager or lifecycle execution
occurs during this fetch.

The exact original archive and its resolution receipt are published atomically inside the selected
installation's private artifact cache, with immutable files/directories and descriptor-anchored
read-back. Same bytes may be reused offline after fresh custody validation. Changed bytes,
wrong ownership/modes, symlinks, extra files or interrupted publication refuse adoption and never
overwrite the existing record. Fetch keeps the request at `resolved`: complete locked dependency
closure and the durable `acquired` receipt remain a later step. A single fetched archive must
never be described as a verified complete closure or active plugin.

This prefix also adopts exact SDK `.16`, source `4c0ecd2a0fc28545dbf677cc988ce69f0cf2f15d`,
archive SHA-256 `4084aa8dbe9767984fac9fef7f5cea30a0bec93ed416138d32c804e6389fdba5`.
Keep one exact SDK peer across the eventual owner closure; preserve all prior frozen artifacts.

### No-overwrite cache directory reservation

Retained releases and managed helper trees reserve their final digest directory with exclusive
creation. Files publish atomically and the directory becomes immutable only after the complete
allowlist and receipt have been written and verified. A concurrent empty destination, symlink,
unknown entry or interrupted partial directory is preserved and refused with a safe conflict;
there is no check-then-directory-rename or recursive cleanup of uncertain state. Existing complete
entries still require exact scoped read-back and byte verification before reuse.

This is required even for an empty destination: Linux rename may replace it after a precheck.
See [rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html). A disposable Node24.19.0
filesystem probe confirmed the replacement behavior; the built custody regressions inject that
specific destination race at the filesystem boundary. Ordinary default tests still exercise real
publication without injection. Private incomplete state needs explicit repair, not automatic adoption.

### Acquisition canary qualification

The owner-created NPM fixtures use `bun postinstall.ts` with a strict TypeScript class that
writes an absolute fixture-only lifecycle marker. Before acquisition tests, execute that exact
fixture script with the genuine pinned helper on an otherwise empty PATH, assert the marker,
then remove only that known marker. Similarly calibrate the archived native module's import
marker. The compiled production acquisition scenario must leave both absolute markers absent.
A relative `touch` marker checked in another directory cannot establish nonexecution. These
counterfactuals concern only disposable owner fixtures; fetched plugin scripts remain unexecuted.

### Shared approved registry lookup

Root package and forthcoming runtime-dependency acquisition use one private `NpmRegistryLookup`
class for approved package/target selection, exact managed Bun identity, metadata parsing,
SRI/tarball identity and held-descriptor CA verification. It remains part of the native `source.npm`
provider and the same installation writer. This helper is an invariant of source acquisition,
not a second provider resolver or an additional authority grant. Its extraction preserves the
existing public source contract and durable request stages; complete dependency closure is still
implemented and qualified separately.

### Complete locked source closure

`PackageSourceResolver.acquire(record)` and `NpmSourceRuntime.acquire(record)` finish an exact
source acquisition by saving a verified complete runtime closure and appending its SDK `acquired`
source receipt. The closure includes the selected package plus the current accepted release's
runtime packages and any new required ordinary dependencies. Reuse an existing exact version when
compatible; a previously unseen package uses approved managed Bun selector resolution. Every
required/peer edge must accept the one selected version. Conflicting/nested versions, aliases,
Git/workspace/patch dependencies, optional runtime dependencies and unsupported bundle forms block.
Optional peer declarations retain the existing narrowly checked runtime rules.
Bound the closure to 1,024 archives, 64 MiB per archive and 512 MiB of archive bytes in total;
check retained inventory sizes before reading the base closure into memory.

Approve each new package and target at an unambiguous registry before its lookup. Inspect source
archives without extraction or import. Generate a normal Bun v2 lock offline from exact local
archives with `--lockfile-only --offline --ignore-scripts --no-env-file`; independently validate
its full flat closure, metadata, SRI and package bytes using the existing release verifier. Include
no source script execution or activation. Absolute fixture lifecycle/import markers must remain
absent while the package manager runs.

Persist an exclusive request-bound closure attempt before dependency lookup/build effects.
In-process same-key callers join the same acquisition; an interrupted incomplete attempt refuses
mutable re-resolution and requires explicit repair. Publish complete immutable closure files and
read back every digest before appending the `acquired` receipt. Receipt/digest inputs exclude
clock samples and metadata publication times; source lookup evidence remains private bookkeeping.
Completed read-back works with the original bundle and registry gone. A closure is acquired data,
not a registration, plan, application or active/healthy claim. Full host/CLI integration still follows.

Bun 1.4.4's offline resolver requires a controlled exact-file override map for transitive semver
edges even when those packages are direct local archives. The resolver may emit this standard
Bun map only when both package metadata and the generated lock bind every root dependency to
its identical inventory archive path. The release verifier must check that equality, full archive
SRI and every original dependency range; arbitrary overrides, out-of-bundle paths and incompatible
versions remain blocked. Lock bytes are generated by Bun and never rewritten by this adapter.
A disposable three-archive probe reproduced the uncached-manifest failure without overrides
and produced the flat lock with exact-file overrides; see [Bun overrides](https://bun.com/docs/pm/overrides).

### Installation-private prepared releases

`NpmSourceRuntime.prepare(record, composition)` materializes an acquired closure and an explicit
typed service graph as a complete installation-private release. This is preparation only: it
does not register, plan, apply or import a provider. The current accepted release supplies exact
retained images, worker, helpers and trust files; the acquired closure supplies exact package
archives and Bun-generated root/lock bytes. The release resolver independently validates the
new package selections, service/provider/probe projections, recipe, asset identities and every
artifact before a complete private receipt is published.

Keep the bootstrap profile, worker and asset root unchanged in this bounded preparation path.
New image acquisition and changing public assets remain separately qualified transitions.
Derive the recipe and credential references from the typed graph; never accept arbitrary Compose
or credentials from a package. Persist under `.cordis/artifacts/prepared/<identity>/bundle`,
using the existing installation writer, descriptor-anchored streaming copies, exclusive directory
reservation and sealed directories/files. A complete receipt binds request intent/source receipt,
base release, composition and every retained file. Read-back verifies all bytes without source
access. Existing incomplete or changed state fails safely and requires explicit repair.

This path does not yet relax the planner's general overlapping-storage rejection. Only a future
owner-host request verified against this exact receipt may consume a private prepared release.

### Planning a prepared release under the owner root

The owner host may plan an exact private prepared release under its existing installation writer.
The private exception requires a complete sealed preparation receipt, the same immutable accepted
request/source receipt, the current base generation, unchanged installation/engine/origin scope
and independent artifact read-back. Arbitrary overlapping directories remain blocked. The public
observer socket cannot plan or mutate sources.

A fresh, non-serving root may replace its initial plan before the first application only while
the application/resource journals are empty. It preserves the bootstrap profile/worker/helper
and acquisition-policy roots and uses the existing writer rather than acquiring another one.
An active host continues to require exact current snapshot/resource scope and verified readiness.
Prepared planning executes no application, container, credential or source effect. A subsequent
explicit submission freshly verifies the candidate; initial publication never silently adopts
failed or interrupted application history.

### Native plugin-management operations

The default durable host owns native `deployment.plugins` and `source.npm` providers under its
existing installation authority. Its owner-only socket supports `plugin.install`, `plugin.list`
and `plugin.inspect` through `ServiceWorkerOwnerClient`. The observer socket rejects every plugin
operation. Acquisition and request persistence use the same authority/writer as applications;
acquired packages receive neither. Client adapters dispatch portable requests through that owner
boundary and contain no alternate provider resolver or start/stop scheduler.

An installation-scoped request saves its complete canonical intent before effects. Repeating an
idempotency key joins the same job or reads its exact durable record; a conflicting intent fails.
A bounded call returns `pending` while acquisition continues, with no active claim or fabricated
plan/application references. Native leases keep accepted background work counted during host
drain. Restarted unresolved lookups are fenced rather than re-resolving mutable source.

This registration slice persists an exact acquired alternative as `prepared`, with explicit next
actions and no active generation. List/inspect read private accepted custody without source access.
They never import a candidate or infer readiness from acquisition. Qualified container selection
uses the plan/apply path described below; unsupported targets and non-NPM sources remain explicit
actions. Existing credentials, resources and Keycloak authority stay unchanged.

`PluginRegistryReader` provides read-only cold list/inspect through the same result contracts.
It validates the installation and request journal, creates no store state and acquires no writer.
Prepared registration reads back exactly with the owner stopped and source unavailable. Historical
active results become recovery-required with no active generation/acknowledgements; stored data
cannot establish runtime health. Reading a closed root does not restart or adopt its endpoints.

### Safe container installation

An installation-scoped NPM request can activate a private container service when its package
selects one unambiguous typed container provider and compatible probe. `serviceId` names the
instance; omission uses a valid plugin ID or a deterministic private ID. `bindings` maps package
contract ports to explicit binding IDs. Provided ports default to instance-qualified binding IDs;
required dependencies never guess legacy roles. Configuration is validated/defaulted by the
package schema, then its declaration is materialized through the existing bounded projection.

Reuse only exact image selections already verified in the accepted release. Additional images/assets,
ambiguous providers/probes/ports, conflicting package/plugin selections, public-edge changes and
unproven target transitions remain prepared with explicit actions. They do not change selection.
The host prepares an exact private release, plans through the same application service and
automatically submits only additive/retained changes in a running composition. Restart, state
migration, removal, issuer or TLS-authority changes require separate explicit action.

`active` requires the completed application, current resource set and exact selected target
acknowledgements. Bounded replies remain pending until that evidence exists. A fresh request for
an already selected exact artifact/configuration validates source and actual readiness before
returning `already-active`; same-key retries reuse the exact durable request/application. Adding
another instance preserves existing container/volume identities, credentials, private authority
and listeners. Registry registration alone never establishes activation.

### Canonical service declaration equality

Saved plans normalize service ports, named-volume mounts, secret mounts and resource sets.
Artifact read-back compares both the selected definition/resources and package projection using
that same set semantics. Order alone cannot invalidate an unchanged archived declaration after
a saved-plan round trip. Normalization preserves every entry and value; command argument order,
JSON payload arrays and other meaningful ordered data remain exact. Changed mount targets,
secrets, grants or policy still fail independently before any activation.
The derived recipe also compares dependency/secret references, ports and mounts as sets on both
sides; it preserves every exact reference, target and publication value.

### Shared static image selections

Independent provider packages may consume one exact static OCI inventory selection. Each selected
package declaration must match its reference, index SHA-256 and manifest digest; the inventory edge,
configuration and layers are still independently verified. Sharing image bytes does not transfer
provider/package ownership, service identity, resource grants or private state between instances.

Runtime images bound to package closure, entry and asset labels retain one unambiguous owner.
Duplicate runtime ownership or mixed static/runtime ownership of an image ID remains blocked.
No image download, mutable reference or unselected inventory is introduced by static sharing.

### Default installed plugin-management adapter

`InstalledPluginManager(installationDirectory)` implements the public `PluginManager` contract.
It forwards install/select to the same durable owner worker. On a fresh plan-only installation,
install may launch the exact release-pinned worker from the single saved format-3 plan, without
applying that plan separately. Source resolution and safe activation still happen inside that
worker through the native manager and existing plan/apply admission. A missing or ambiguous
initial plan, unexpected application/resource history, uncertain launch state or foreign worker
fails rather than selecting a baseline or adopting a process. A started worker is durable after
the requesting process exits.

List/inspect use the live owner when its private control endpoint exists. With no owner endpoint,
they use verified cold registry read-back without launching a worker or claiming active health.
They never turn a socket failure into a silent cold fallback. Install validates the release's
source policy before first launch; it does not install global tools or create credentials outside
the admitted application. Explicit container restarts remain a separate plan/apply action.

Provider staging yields to the host event loop between independently verified provider
preparations. Owner inspection remains responsive while the durable application stages the
complete closure; the existing RPC deadlines and artifact checks remain in force.

### Public assembled-test fixture

`@treeseed-cordis/deployment/testing/plugins` exports `PluginInstallationFixture` for isolated
owner/Platform acceptance. `prepare()` creates a genuine four-service bundle, two versions of an
independent native container/probe package, a pinned compiled worker and managed Bun helper,
calibrated lifecycle markers and a disposable HTTPS registry with an explicit fixture CA.
The fixture returns the exact configuration, source locator and paths through public methods.
`startRegistry()` makes source access available; `stopRegistry()` supports source-free retry
checks. `close()` awaits registry disposal and removes only fixture-owned runtime resources.
Preparation starts no service containers and is never an installer implementation or production
plugin source. Consumers spawn their own built CLI and assert actual plans/applications/readiness,
retained resources and credential/TLS bytes through public contracts. No cross-checkout source
imports or copied Deployment host implementation are needed for assembled verification.

### Live transport read-back boundary

Installed-manager transport preflight verifies immutable saved plan/installation/launch identities,
private endpoints and the owning process. It delegates mutable request/application/resource journal
reads to the live owner. An external caller must not sample intermediate event/head publication
while the owner is writing. Cold reads still validate the complete stopped journal; malformed or
interrupted state, foreign scope, changed worker/socket identities and uncertain launch records
remain blocked. A published plan alone establishes neither journal completeness nor runtime health.

### Exact approved Git source resolution

Native `source.git` implements the same typed source-resolver seam as NPM. Resolution accepts only
SDK HTTPS Git locators under an exact installation source grant, with one unambiguous target.
It uses the release-pinned managed Git helper with ambient credentials/configuration/proxies and
hooks excluded. Explicit commit IDs stay exact; bare repositories resolve HEAD and named branches
or tags resolve to a single advertised commit. A branch/tag name collision is rejected rather
than choosing one. Annotated tags bind their peeled commit. Credential-bearing locators,
redirects and unapproved origins/targets fail.

The accepted request intent precedes lookup; the immutable resolved commit and exact helper
identities are saved before archive acquisition or build. An interrupted lookup requires repair;
a same-key resolved retry performs no network lookup, and a new key may resolve a moved ref.
Source trust comes from the pinned policy CA or normal verified HTTPS trust, with held-file
identity/hash checks around access. No Git checkout, imports, lifecycle hooks, dependency install,
container activation or source build occurs during resolution. Prepared archive/closure admission
and isolated build qualification follow through the same native source contract.

The bounded resolution prefix exposes `GitSourceRuntime` with genuine default native construction.
Archive/closure acquisition remains explicitly unqualified in this prefix; the durable installation
manager adopts the same provider once those gates pass. Git commands use a held installation-private bare repository with empty templates and owner-only
permissions. The explicit repository and held configuration checks exclude a containing development
checkout; the source lookup does not check out files. See the [Git repository option](https://git-scm.com/docs/git#Documentation/git.txt---git-dirpath) and [Git initialization documentation](https://git-scm.com/docs/git-init).

### Exact Git package archive custody

The Git source provider fetches the already accepted commit into private bare bookkeeping with
no checkout, hooks, submodules, ambient credentials or mutable-ref fallback. A bounded helper
process and private-work budget stop excessive object/archive acquisition. Reject symlinks,
submodules, excessive files/sizes and unsafe paths before accepting package bytes. Inspect the
resulting tar without extraction, imports, package-manager execution or lifecycle scripts.

A complete owner-private immutable receipt binds the original origin/commit/tree, helper identities,
installation scope, exact archive hash and native package descriptor. The declared package must
match an approved origin/target package grant; provider entries and asset identities must exist.
Publication reserves an exclusive directory before effects and never overwrites/adopts incomplete
state. Repeated fetch reads and verifies the exact stored bytes even after source/bundle removal;
tampered or missing accepted state requires explicit repair. Complete dependency closure, source-only
builds and installation activation remain separately gated after this archive slice.

The committed-tree archive path admits at most 4,096 regular files, 8 MiB per file and 64 MiB
of source bytes. Symlinks, submodules, `.gitmodules` and `.gitattributes` are refused in this
bounded path; archive attribute rewriting is not silently treated as exact committed bytes.
Git work is checked during execution and after each helper command (8,192 entries, 64 MiB
per file, 128 MiB total) with the existing 120-second helper deadline and process-group cleanup.
The archive explicitly uses `tar.umask=0022` to retain Git's executable/non-executable distinction
without group-write permissions. See [Git archive configuration and attributes](https://git-scm.com/docs/git-archive).

### Exact Git dependency closure

A prepared native Git package uses the same complete locked runtime-closure verifier as NPM.
The root archive is bound to its accepted origin, commit and tree; each missing registry dependency
needs its own approved package/target/origin grant. Retained exact packages may satisfy compatible
dependencies, and only one version per package is admitted. The managed Bun helper generates the
ordinary lock offline from verified archives, with lifecycle scripts disabled. No Git package code
runs on the host. The acquired receipt binds root archive, complete closure and helper identities;
source-free repeated acquisition revalidates these bytes. Missing/tampered or uncertain closure
state is refused. Source-only packages still require the separate approved isolated-build path.

### Approved isolated Git builds

Committed source without distributable exports returns `BUILD_REQUIRED` unless the accepted
Git grant names an exact build policy. The policy digest covers its origin, commit, source entry
and SHA-256, output package directory, digest-pinned Linux/amd64 build image, managed helper
release, disabled network and bounded deadline. Package lifecycle fields grant no execution.

The native build provider runs only that approved entry in a disposable non-serving Docker
container: non-root UID, read-only root, dropped capabilities, no-new-privileges, no network,
ports, installation socket or credentials, bounded memory/process/CPU/tmpfs and deadline. Its
only host inputs are held read-only copies of verified source/helper/driver bytes. Writable build
output stays inside bounded tmpfs. The generated TypeScript-class driver suppresses source logs,
packs only the declared output directory with managed Bun and lifecycle scripts disabled, and
returns bounded archive bytes for the same non-executing package/metadata verifier. It never
runs source scripts on the host or mounts the installation root. Exact owned build containers
are removed and absence verified before success. Unknown effects or interrupted publication
leave private evidence and refuse reuse; they cannot produce an active result.

Immutable build receipts bind installation/engine, raw commit/tree/archive, complete policy and
helper identities, and produced native archive. Source-free reuse verifies all retained bytes;
future closure and activation retain their own admission checks. A failed build cannot silently
fall back to a prepared artifact or a different image/entry. Keycloak identity is unchanged.

The Docker daemon receives exact sealed staging paths; host filesystem reads stay anchored to
held descriptors with linked identity/content checks before and after execution. No parent
installation directory is mounted. Cleanup verifies the created container's exact ID, image and
owned-build label independently of execution admission, so a refused isolation configuration
still removes only that created resource. See [Docker read-only bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).

The isolated-build slice exposes `PluginBuildRuntime` and its typed native `PluginBuildAdapter`
for host qualification. Installed Git routing and source-build closure adoption are a following
slice; this prefix alone does not claim a successful installed source-only plugin.

### Git build and closure adoption

The native Git source provider first admits exact committed distributable exports. Source-only
packages require the selected native build provider and the accepted exact build policy; missing
policy returns `BUILD_REQUIRED`. Both paths enter the same complete locked closure verifier.
Git source receipts bind the original commit/tree and either a null build identity for committed
exports or the exact approved build policy and produced archive. Original source custody, built
artifact and complete runtime closure remain separate immutable evidence. Source-free read-back
checks each receipt and its bytes without reacquiring, rebuilding or launching containers.

The Git runtime's default construction registers the same native build provider used by the
installed host. A build receipt alone does not grant activation: registration, selection, coherent
planning, application completion and actual target-generation/resource acknowledgements remain
required. Keycloak identity and existing installation ownership are preserved.

### Mutable helper work and accepted custody

The in-flight helper work walk measures owned regular files, rejects symlinks and enforces the
same file/entry/byte bounds while a trusted pinned helper is running. It must allow transient
regular-file hard links: Git publishes an object by linking its temporary file and then removing
the temporary name. Paths are counted conservatively, including both names. Completed helper
work and every accepted artifact still require single-link files before success. A persistent
hard link is refused at the final check; this distinction never raises a resource budget or
relaxes archive/custody validation. See [Git object publication](https://github.com/git/git/blob/v2.55.0/object-file.c).

### Installed Git providers

The durable host registers the same native NPM, Git and approved-build providers used by their
standalone qualification roots. `PluginManager.install` selects the source adapter from the
accepted locator; both adapters produce the same verified package/closure before the existing
registration, selection, private release, plan/apply and target read-back path. No Git-specific
container engine, second writer or separate activation implementation is introduced.

Committed distributable Git packages and explicitly approved source-only Git builds can add
qualified private service instances when safe. The same contract suite checks original resource,
credential and TLS retention, direct service behavior, exact replay after source shutdown,
already-active selection and prepared/action-required unsafe state changes. A fresh installed
manager launches the exact compiled durable owner; cold readers still make no current health
claim and cannot implicitly restart an uncertain owner. Keycloak authority is unchanged.

### Cold worker module prelude

The actual compiled worker must finish loading its runtime modules before it parses arguments
or opens installation state. The build-artifact reader is loaded only when accepted built-source
custody is read; it must not eagerly construct a build/runtime-root dependency during bootstrap
schema initialization. This preserves one native authority and the same artifact verification.
An argument-only compiled-worker smoke returns exit 2 with no output or installation effects,
without Node, Bun, Git or Docker on its PATH. The longer default-owner/apply checks remain required.

### Registered provider selection

`PluginManager.select` selects an exact provider from previously verified installation records;
it never resolves a mutable package locator. Scope, target, capability, service identity and
expected generation remain explicit. Duplicate accepted records for the same artifact are one
candidate; different artifacts advertising the same provider are ambiguous and are refused.
The selected closure and bytes are verified again before any decision. An already-selected
container requires fresh application/resource/target read-back and returns `already-active`;
unsafe transitions remain prepared with explicit actions. Unknown providers, capabilities,
foreign scopes and stale generations cannot activate. A select request has its own durable
idempotency record and preserves the original source provenance. No download or lifecycle script
is allowed merely to discover a registered candidate. Qualified live-probe admission is a
separate verified transition; metadata alone never grants it.
The public `@treeseed-cordis/deployment/testing/plugins` fixture also supports
`startGit(build = false)`. After `prepare()`, it packages a genuine local Git helper and its
libraries, serves an actual bare repository over private-CA HTTPS, records its exact grant and
refreshes the release inventory. `source()` returns the Git locator; version 2 selects the
second genuine commit. With `build = true`, the first source is an exact source-only commit
with an explicitly pinned isolated build policy. This is fixture preparation, not activation.
The same `stopRegistry()`/`close()` closes either transport; a fixture cannot start both.
Consumer tests must import this packed public interface and use the real installer, not copy
source acquisition or import another checkout. Neither planning nor fixture preparation executes
a package lifecycle script or creates installation credentials. The caller still owns explicit
fixture cleanup; Keycloak identity authority is unchanged.

### Qualified live readiness-provider selection

A registered `probe.service` may replace an existing service's observer without replacing its
container only when the accepted acquisition policy binds the exact previous/next artifacts,
provider IDs, deployment target, state version and qualification digest. The selected package
must advertise that same live qualification. Metadata alone is insufficient. The container,
image, service configuration, bindings, grants, endpoint, observation contract, probe configuration
and owned state remain identical. Any wider transition still requires explicit restart/migration.

Native service scopes drain admitted leases before awaited Cordis disposal and reconstruction
within the same durable owner. No container restart or second writer is implied by a native
scope change. Candidate readiness and exact target/resource generation read-back precede active
publication. Pending drain/disposal is not activation; timeout or uncertain cleanup fences the
transition and requires explicit repair. Existing resources, credential bytes, TLS/issuer identity
and the installed host root remain intact. Full cross-runtime replacement remains Task 4.

A new registered selection after another accepted composition must prepare a complete lock
against the current retained release. Reuse the exact accepted root/archive provenance, reverify
the current package closure and use the privately managed offline helper; never reopen a mutable
locator or download a missing dependency. If retained packages cannot satisfy the selection,
return an explicit blocker rather than acquiring new bytes. The new selection receipt binds its
new closure while preserving source resolution, root integrity and helper/policy identity.
Accepted idempotent retries reuse that exact result. Selecting another instance of a registered
provider remains an explicit new generation and requires actual target/resource read-back.

The public `@treeseed-cordis/deployment/testing/live` fixture prepares a genuine installed-live
qualification bundle: exact native old/next readiness classes, their declared qualification,
complete package lock, OCI bytes and the actual compiled durable worker. `prepareLive()` is
preparation only. `startRegistry()` adds its private-CA disposable source and accepted exact
transition policy; `source()` names the fixture package. `stopRegistry()` makes subsequent exact
replay/registered-selection checks source-free. The public `dispose()` awaits the exact fixture
worker's shutdown before removing only fixture-owned resources and bytes. Consumers must use
these public artifacts, not copy provider code or import a sibling checkout. The installed
programme must verify an independent owner PID, actual new probe observations, retained physical
resources, exact replay and public apply read-back. This fixture grants no Keycloak/session or
production installation authority.

`install` also activates a readiness provider when an existing service is explicitly identified
and its provider selection is unambiguous. An explicit provider ID determines its capability from
the verified descriptor. A probe-only package with one compatible provider may infer that
provider; a package advertising containers retains container selection by default. Probe
installation uses the same exact accepted qualification, native drain and target read-back as
registered `select`. It never invents a service scope or ignores container-binding arguments.
Ambiguous or unqualified choices remain prepared/action-required.

## Explicit non-serving format-2 custody migration

`InstallationStore.migrate({from:2,expectedComposition,authorization:'non-serving'})`
uses the existing installation writer and independently verifies the legacy saved plan,
completed application, Docker daemon, four stopped owned containers, exact images, owned
network/volumes, private credential receipt and retained TLS authority. It neither stops
services nor starts them: caller-authorized quiescence must already be observable. An active
API, old worker socket/writer, changed resource, foreign file or uncertain journal blocks
before publication. No caller-supplied quiescence assertion substitutes for observations.

The format-3 custody receipt records exact legacy service/resource identities, private slot
paths and authority digest. Old plans/applications/artifacts are retained byte-for-byte and
never appended to by format-3 operations. Legacy provider classes do not acquire fabricated
format-4 contracts or active acknowledgements. Custody read-back reports migrated custody and unverified current runtime;
provider/runtime upgrade still requires an independently qualified explicit migration/restart
plan. Normal install/plan/apply cannot silently adopt these resources.

Publication seals a private intent, resource inventory and source-file manifest, retains the
original receipt with an exclusive hard-link publication and unlink handoff, then publishes the format-3 receipt atomically. Any interrupted
publication fences the installation for explicit repair. Readers verify stored evidence
without reopening the source bundle; live migration admission separately rechecks daemon and
physical non-serving state. All migration issues remain open until release.

## Compiled worker package resolution

The trusted worker compiler enables package.json loading for verified installed package
resolution and explicitly disables dotenv, bunfig and tsconfig autoloading. This is the same
policy used by the fixed production worker and the compiled external-package qualification
programme. Package metadata loading supplies ordinary module resolution; accepted archive
hashes, closed dependency inventories, native declarations and scoped grants remain required.
No package-manager execution, ambient preload or lifecycle script runs during activation.

Bun 1.4.4's compile defaults disable runtime package metadata loading. The earlier producer
therefore failed to import Cordis from a genuine sealed Postgres provider, although the full
package was present and development import worked. The exact-archive compiled spike and the
genuine default API assembly are required evidence, alongside the cold worker prelude. See
[the official executable configuration documentation](https://bun.sh/docs/bundler/executables)
and open issue #1004. This correction makes no claim that arbitrary unverified plugins are safe.

The combined Deployment76 candidate retains the migration and compiled-worker corrections
without changing repository ownership or runtime authority. Direct migration admission also
requires an absolute canonical installation path before any filesystem access; callers cannot
commit a migration through an ambiguous path and then fail its scoped read-back.

## Explicit restart of asset-bound private configuration

A reviewed UI asset/image replacement may update an existing JSON configuration's `assetDigest`
projection together with its bound composition asset identity. Qualify only this exact change:
slot names/kinds, credential references/values, issuer/account/grant data, volume layouts,
authorities and worker privileges remain identical. Updated configuration must be a leaf;
references from another service require separate migration qualification. No arbitrary private
configuration update is admitted. The provider's state version stays fixed and the exact
affected restart scopes remain mandatory.

Retain every previous private file and all unchanged resource identities. Publish the new
asset-bound configuration under its new definition digest and mount it only in the explicitly
replaced container. Readiness/asset generation acknowledgements must verify the new closure;
no implicit restart or live image replacement is inferred. Identity remains Identity-owned.

## Bounded complete CI history

Cordis verification fetches the exact candidate and `refs/heads/cordis` histories, rather than
all unrelated legacy branches and tags. Two pinned checkout steps use a maximum positive depth
to select targeted refs; the following gate requires non-shallow history, the integration ref
and the exact candidate HEAD. A `blob:limit=1m` filter excludes large unrelated historical blobs;
current checkout and the original readability baseline remain available. Baseline source
fingerprints and ancestry are still verified by the existing owner gate.

Both actions remove credentials before checks or untrusted package fixtures execute. All seven
smoke partitions, hosted Ubuntu 26.04, immutable Kata qualification, fifteen-minute limits and
the aggregate required gate remain unchanged. Checkout incompleteness fails visibly; it never
permits baseline replacement, skipped tests or an accepted partial run.

Native npm-source fixture failures retain their original blocker plus bounded read-only Docker
prerequisite read-back. The fixed status/timing diagnostics expose no raw host data and change
no assertions, timeouts or production errors. See [fixture diagnostics](docs/docker-fixture-diagnostics.md).

## Effective runtime policy custody

See [the bounded effective-policy contract](docs/runtime-policy-custody.md). This read-only
prerequisite does not advertise a native profile or admit a warm sandbox.

Retained policy and actual native boot binding are specified in [the launch reference](docs/kata-launch-binding.md).
Host profile publication and warm admission still require their owner integration.
The effective-policy maximum includes exact retained image-backed NVDIMM address space;
it keeps that allowance distinct from ordinary startup RAM. See the owner contract (#1067).
