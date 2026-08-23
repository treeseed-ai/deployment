# Deployment workspace guidance

TreeSeed Deployment is an Apache-2.0 repository. Human and agent changes use
the same durable pull-request record and exact-head verification, review,
staging, and release gates.

Preserve independent package builds and exact component-release custody. Keep
the privileged supervisor limited to fixed operations, keep project source out
of automatic host updates, and never add Market or Market API custody or a
hosted Market dependency. Production services consume immutable published
artifacts; the manager must not build downloaded project source.
