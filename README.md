# Cordis diagnostics and non-activating planning

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
reuse a retained adapter to perform another effect. Cached authority reads retain their declared
read-only scope and never repair or create custody implicitly.

The genuine authority programme retains real adapters and an owner writer, records failed state,
then attempts all five effect seams. Typed refusals and unchanged private/resource inventories
are required. Valid default phase paths remain covered by their normal compiled programmes.
This is a fixed permission invariant, not a selectable policy or a second plugin framework.
