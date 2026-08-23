# TreeSeed Deployment

TreeSeed Deployment is the shared Debian bootstrap, host manager, service edge,
and release-catalog implementation for independently released TreeSeed
components. It is the host lifecycle foundation shared by TreeSeed Platform,
TreeAI, and TreeDX without merging their application repositories.

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

The workstation canary has a stricter convenience entrypoint. It accepts a
private Codex login cache, generates the API database and session secrets in
memory, packages the declared manager-owned credential files, and consumes its
temporary credential envelope:

```sh
npm run build:workstation -- \
  --configuration /path/to/workstation-canary.json \
  --codex-auth-file "$HOME/.codex/auth.json" \
  --suite development
```

The login cache must be a regular, non-symlink file with no group or world
permissions. The command never prints credentials. A website configuration
handler must apply the same no-store response, redacted request logging,
ephemeral generation, immediate server deletion, and root-only installation
policy; the generated package itself remains password-equivalent until the
bootstrap handoff deletes its embedded seed.

See [architecture](docs/architecture.md) and [package boundaries](docs/packages.md).
