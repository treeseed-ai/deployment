# Host runtime development

Manager, supervisor, sandbox-broker, and Kata integration changes are tested as local host-development generations before a release candidate is created.

```sh
trsd dev host activate
trsd dev host status
trsd dev host deactivate
```

`activate` builds the Deployment worktree without root privileges. The installed supervisor verifies every output file against the CLI manifest, copies it into root-owned generation custody, and switches the manager API, supervisor, and broker together. The switch helper checks all three services and restores the installed generation automatically when activation fails. It never installs an APT package or changes the host update channel.

Pass another Deployment worktree explicitly when needed. `--guest-image sha256:<digest>` additionally binds an exact, already published sandbox guest image; mutable image tags are rejected. Provider-local guest build and import commands remain separate from the host runtime switch so private execution-provider images do not enter the public release catalog.

The bridge is available only through the protected local manager socket and only on development rollout groups. `--plan` performs no build or mutation.

## Candidate boundary

Use local generations for ordinary edit/build/test cycles. A release candidate is created only after:

1. Direct SDK, CLI, and Deployment verification passes.
2. The local host generation activates without rollback.
3. Sandbox doctor and provider reconciliation pass.
4. A real Kata assignment completes within its product latency target.
5. Deactivation restores the installed generation cleanly.

The accepted local source commit and verification evidence then become the release candidate. Package publication is not a development transport.
