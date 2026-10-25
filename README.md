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
