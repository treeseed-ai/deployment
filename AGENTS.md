# Deployment workspace guidance

TreeSeed Deployment is an Apache-2.0 repository. Human and agent changes use
the same durable pull-request record and exact-head verification, review,
staging, and release gates.

Preserve independent package builds and exact component-release custody. Keep
the privileged supervisor limited to fixed operations, keep project source out
of automatic host updates, and never add Market or Market API custody or a
hosted Market dependency. Production services consume immutable published
artifacts; the manager must not build downloaded project source.

## Branch and deployment boundary

`main` is the only production branch and maps only to the `production` deployment environment. `staging` is the only development-integration branch and maps only to the `staging` deployment environment. Short-lived pull-request branches may validate without deploying, but they must never define another deployment environment. Do not create or use `development`, `preview`, `stable`, or any other GitHub deployment environment; preview deployments are prohibited. Release tags may promote an exact reviewed `staging` commit to `production` without creating another branch or environment. Artifact channel names must never become GitHub deployment environments.

## Project library

Use `trsd library show deployment` and `status` before querying `treeseed-ai/deployment-library`. Read root-level paths with `trsd library read deployment <path> --ref <exact-commit>` and use `search`, `query`, or `context` for discovery. Author only through `trsd library workspace` and governed reviews. Never recreate `src/content` or edit `.treeseed/data` directly.
