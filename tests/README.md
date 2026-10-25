# Deployment owner test boundaries

Tests that construct `ComposeDeploymentHost` and call `plan` use the real Docker/host boundary,
even when their final assertions inspect frozen data. They belong to the integration tier and
need an explicit bounded budget for cold engine/fixture preparation. The accepted-observation
metadata test uses a 60-second budget; missing prerequisites and the production command timeouts
still fail visibly. It must finish before its fixture cleanup, rather than outliving Bun's
five-second default and deleting state underneath a pending host inspection.
