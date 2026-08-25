# Deployment workspace guidance

TreeSeed Deployment is an Apache-2.0 repository. Human and agent changes use
the same durable pull-request record and exact-head verification, review,
staging, and release gates.

Preserve independent package builds and exact component-release custody. Keep
the privileged supervisor limited to fixed operations, keep project source out
of automatic host updates, and never add Market or Market API custody or a
hosted Market dependency. Production services consume immutable published
artifacts; the manager must not build downloaded project source.

## Project library

Use `trsd library show deployment` and `status` before querying `treeseed-ai/deployment-library`. Read root-level paths with `trsd library read deployment <path> --ref <exact-commit>` and use `search`, `query`, or `context` for discovery. Author only through `trsd library workspace` and governed reviews. Never recreate `src/content` or edit `.treeseed/data` directly.
