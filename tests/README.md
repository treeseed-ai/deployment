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

Scoped restart fixtures retain five genuine service containers, all owned volumes and credential
slots, and two explicit public-CA owners (instances 0 and 2). Other instances use the ordinary
protocol probe. The full authority/cross-grant suite continues to qualify all authority owners;
the scoped programme concentrates repeated observation on its unchanged CA owner and replaced
CA-bearing service. Preserve all resource/private-byte assertions, actual HTTP output, immutable
reversion history, exact scopes and default compiled worker. This bounds repeated authority
inspection within the existing 15-minute serial CI budget without weakening runtime audits.
