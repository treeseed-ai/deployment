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

The Debian build emits independent packages under `release/out`. A configured
bootstrap is intentionally separate because it can contain plaintext bootstrap
credentials:

```sh
npm run build:configured -- \
  --configuration /path/to/platform.json \
  --credentials /path/to/ephemeral-credentials.json \
  --consume-credentials \
  --suite development
```

The generator consumes the credential input, emits a checksum without echoing
secret data, and marks the resulting package mode `0600`. After installation,
the operator must securely delete the downloaded configured package.

APT normally reads local packages through its unprivileged `_apt` account. To
keep a configured package private without triggering an unsandboxed-download
warning, stage a root-controlled copy owned by `_apt`, install that copy, and
remove it after manager handoff:

```sh
sudo install -o _apt -g root -m 0600 /path/to/treeseed-configured.deb \
  /var/cache/apt/archives/treeseed-configured.deb
sudo apt install /var/cache/apt/archives/treeseed-configured.deb
sudo rm -f /var/cache/apt/archives/treeseed-configured.deb
```

Do not make the credential-bearing package world-readable or loosen the
operator home-directory permissions merely to suppress the APT warning.

The development workstation has a stricter convenience entrypoint. It accepts a
private Codex login cache, generates the API database and session secrets in
memory, packages the declared manager-owned credential files, and consumes its
temporary credential envelope:

```sh
npm run build:workstation -- \
  --configuration /path/to/development-workstation.json \
  --codex-auth-file "$HOME/.codex/auth.json" \
  --suite development
```

A failed first adoption may be rebuilt with
`--reset-unaccepted-components api`. This recovery request is embedded in the
root-only bootstrap seed and fails closed once any known-good receipt or active
component set exists. It is not an upgrade-time state reset and must never be
used for migrated or accepted data.

The login cache must be a regular, non-symlink file with no group or world
permissions. The command never prints credentials. A website configuration
handler must apply the same no-store response, redacted request logging,
ephemeral generation, immediate server deletion, and root-only installation
policy; the generated package itself remains password-equivalent until the
bootstrap handoff deletes its embedded seed. Bootstrap pauses scheduled
reconciliation, restarts the newly installed manager payload, performs any
explicit unaccepted-state recovery, runs one initial reconciliation, and only
then resumes the stable and development timers.

An AI-only host uses the same manager and repository through the explicit,
opt-in Platform `ai-factory` profile. The builder generates the complete
credential set ephemerally, leaves mode-control mTLS enrollment to the manager,
and emits the single disposable `treeseed-ai` bootstrap package:

```sh
npm run build:ai-bootstrap -- \
  --profile /path/to/platform/deployment/profiles/ai-factory.json \
  --stable-lock https://raw.githubusercontent.com/treeseed-ai/platform/EXACT_COMMIT/deployment/integration-releases/stable.json \
  --development-lock https://raw.githubusercontent.com/treeseed-ai/platform/EXACT_COMMIT/deployment/integration-releases/development.json \
  --suite development \
  --operator-user "$USER"
```

The resulting package and its redacted checksum receipt are printed on
success. Its plaintext seed is consumed during bootstrap, so the root-owned
package must be deleted after the manager reports a complete handoff.

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
