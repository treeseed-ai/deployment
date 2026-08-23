# Deployment architecture

Deployment is the only software allowed to own the lifecycle of a TreeSeed host. The SDK owns portable schemas; this repository owns reconciliation, Debian integration, the root supervisor, the manager mTLS API, Caddy configuration, receipts, backup/recovery orchestration, and thin component packages.

The manager reads `/etc/treeseed/platform.json`, resolves a signed stable catalog plus explicitly compatible development overlays, and converges immutable project images through packaged production Compose bundles. It never fetches project source and rejects Compose `build` directives, mutable image references, undeclared host ports, missing health gates, unsafe aliases, and mixed-track overlays that do not bind the selected stable base.

The unprivileged manager plans and observes. A root supervisor accepts only a fixed local socket protocol for package installation, Compose activation, edge reload, systemd control, backup, migration, and rollback. Arguments are validated before fixed executable invocations. The remote API uses mutual TLS; it cannot run arbitrary commands.

One Caddy instance owns host ingress. Only declared `.localhost` aliases are emitted. Databases, workers, runners, raw inference services, object stores, migration jobs, and control sockets stay on private Compose networks.

Stable metadata is checked daily and activated in the configured weekly window. Development components poll every 60 seconds and may replace only their own compatible overlay. A failed drain, migration, or health gate restores the last known-good generation.
