# Cordis read-only host diagnostics

`DeploymentHost.diagnose(configuration?) → Promise<DiagnosticReport>` is the public typed
contract. `ComposeDeploymentHost` supplies the real default Docker CLI, host/filesystem and
loopback port probes. The CLI consumes this package unchanged. No plan/apply, Compose up,
container lifecycle, journal, credential or installation creation exists in Task 1.

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

Storage inspection rejects symlinks in any component, foreign/nonempty destinations, wrong
ownership and unwritable/unsearchable ancestors. It uses stat/statfs/access only and creates
nothing. No Task1 installation journal is recognized. The port probe temporarily binds and
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
