# Debian package boundaries

- `treeseed`: configured bootstrap seed, APT source/key enrollment, and one-shot seeder.
- `treeseed-manager`: unprivileged reconciler, mTLS API, receipts, and fixed root supervisor.
- `treeseed-host-runtime`: Node 24 runtime, Docker Engine/Compose integration, directories, users, and systemd units.
- `treeseed-sdk` and `treeseed-cli`: signed host payloads for the exact accepted SDK and `trsd` client.
- `treeseed-release-catalog`: signed stable-base catalog and compatibility metadata.
- `treeseed-release-catalog-development`: co-installable signed development overlay; stable refreshes cannot remove it.
- `treeseed-edge`: Caddy package/configuration and the dedicated edge network.
- `treeseed-component-api`, `-agent`, `-treedx`, and `-ai`: thin exact-digest runtime bundles.
- `treeseed-lab`: optional Mailpit, read-only diagnostics, smoke clients, and development-only routes.

All packages are independently versioned Debian artifacts from the Deployment APT repository. Stable and development suites use independent signing keys. Project repositories continue to own their application release bundles and OCI images.

External payloads are selected by exact Platform `treeseed.integration-release/v1` locks. Deployment accepts those locks only from immutable Platform commit URLs, then verifies every selected component manifest, Compose file, and host payload by SHA-256 before packaging. Component packages use the selected Debian revision—not the Deployment manager version—so reconciliation can request the exact package recorded by the catalog. `treeseed-sdk` and `treeseed-cli` contain the exact selected public npm payloads and execute with the private pinned host runtime. The repackaged CLI Debian revision also includes the Deployment composition version, ensuring a changed exact SDK dependency can never reuse an immutable APT pool filename.
