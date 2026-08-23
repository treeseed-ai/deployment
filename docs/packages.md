# Debian package boundaries

- `treeseed`: configured bootstrap seed, APT source/key enrollment, and one-shot seeder.
- `treeseed-manager`: unprivileged reconciler, mTLS API, receipts, and fixed root supervisor.
- `treeseed-host-runtime`: Node 24 runtime, Docker Engine/Compose integration, directories, users, and systemd units.
- `treeseed-sdk` and `treeseed-cli`: signed host payloads for the exact accepted SDK and `trsd` client.
- `treeseed-release-catalog`: signed catalog and compatibility metadata.
- `treeseed-edge`: Caddy package/configuration and the dedicated edge network.
- `treeseed-component-api`, `-agent`, `-treedx`, and `-ai`: thin exact-digest runtime bundles.
- `treeseed-lab`: optional Mailpit, read-only diagnostics, smoke clients, and development-only routes.

All packages are independently versioned Debian artifacts from the Deployment APT repository. Stable and development suites use independent signing keys. Project repositories continue to own their application release bundles and OCI images.
