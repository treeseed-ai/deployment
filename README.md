# TreeSeed Deployment

TreeSeed Deployment is the shared Debian bootstrap, host manager, service edge,
and release-catalog implementation for independently released TreeSeed
components. It is the host lifecycle foundation shared by TreeSeed Platform,
TreeAI, and TreeDX without merging their application repositories.

The one-time qualification-host transition from the retired TreeAI manager is
defined in [docs/treeai-handoff.md](docs/treeai-handoff.md).

Implementation changes are integrated through `staging` and released from
`main`. The repository never owns Market or Market API deployment.

## Development

The clean-clone toolchain is Node 24 with the committed npm lockfile.

```sh
npm ci
npm run verify:direct
npm run build:deb
```

The Debian build emits independent packages under `release/out`, including one
generic `treeseed` bootstrap. It contains only public APT trust, suite
selection, and the foundation installer—never host configuration, identity,
capacity, or credentials:

```sh
sudo apt install ./treeseed_VERSION_amd64.deb
```

The package detects the invoking non-root account when available and enrolls it
in `treeseed-operators`; a new login session may be required before that group
membership is visible. Its one-shot service installs the exact manager, SDK,
CLI, host runtimes, and release catalog for the protected suite. It starts only
the local manager foundation and does not install or reconcile applications.
Initialization is a separate explicit operation:

```sh
trsd host bootstrap status --json
trsd host initialize --profile capacity-provider --json
```

Profile initialization remains fail-closed until its SDK, CLI, and manager
contract is released. The generic package is safe to distribute before that
command exists because it carries no credential and activates no component.

An accepted host can be returned to a fresh, unseeded application state through
the protected local manager socket:

```sh
trsd host reset --plan
trsd host reset --confirm
```

Reset removes manager-owned component databases and files, rendered component
configuration, provider enrollment state, receipts, update state, and backups.
It preserves the signed APT configuration, installed packages, host identity,
host configuration, TLS authority, and credential files, then immediately
reconciles clean services from the accepted catalog. The Platform seed and
capacity-provider enrollment are deliberately separate post-reset operations.

See [architecture](docs/architecture.md) and [package boundaries](docs/packages.md).

## Protected publication

The manually dispatched publication workflow authenticates to Docker Hub with
the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets from the selected
`development` or `stable` GitHub environment. The Docker Hub credential must
have push access to the `treeseed` namespace. Deployment publishes only the
manager-owned lab support images, `treeseed/diagnostics` and
`treeseed/mailpit`; application projects publish their own service images.
