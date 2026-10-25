# Deployment owner test boundaries

Tests that construct `ComposeDeploymentHost` and call `plan` use the real Docker/host boundary,
even when their final assertions inspect frozen data. They belong to the integration tier and
need an explicit bounded budget for cold engine/fixture preparation. The accepted-observation
metadata test uses a 60-second budget; missing prerequisites and the production command timeouts
still fail visibly. It must finish before its fixture cleanup, rather than outliving Bun's
five-second default and deleting state underneath a pending host inspection.

The complete serial Docker gate now includes a compiled retained-transition scene and cold
module-entry probes. Measured local predecessor smoke was 472 seconds and the new compiled
scene 144 seconds, before CI setup. The job budget is 15 minutes; individual protocol/test
deadlines and missing-prerequisite failures remain enforced, with no skipped positive cases.

The malformed/incomplete journal test invokes real `ComposeDeploymentHost.plan`, including
read-only host/engine inspection. Classify it as integration with a 60-second cold-host
budget. CI reproduced 5.443 seconds against the previous implicit five-second unit budget.
The same assertions and production command deadlines remain unchanged.
