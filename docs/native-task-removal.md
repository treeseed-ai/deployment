# Bounded native task removal

Deployment owns physical task/container removal below the selected native Cordis sandbox provider.
Agent owns pool and assignment policy. An internal `NativeTaskRemoval` class orchestrates the exact
owner-verified resource through the existing command client. It is not a configurable provider,
second scheduler or public grant of host authority: ownership admission and the final physical
read-back stay one coherent host operation.

Part of #1086 / approved Task 3D. Baseline `cordis`
`366709a04a994a1825c878376acb369089bd5a0f`. Profile candidate #1085 stays separate and blocked until
this correction is accepted and consumed through fresh `origin/cordis`.

## Contract

After existing owner/resource validation, admit only exact
`cordis-sandbox-<24 lowercase hex>-<24 lowercase hex>` names. Require a live cancellation signal
before inspection and each command. List tasks through the existing verified client. For a present
task issue `tasks delete --force <owned-name>`, then remove its container. For an absent task remove
only its container. Never issue a separate standalone kill or retry a failed command. A failed stop
must not proceed to container removal; cancellation between steps stops further effects.

Pinned [containerd task deletion](https://github.com/containerd/containerd/blob/v2.4.2/cmd/ctr/commands/tasks/delete.go#L48-L94)
uses [`WithProcessKill`](https://github.com/containerd/containerd/blob/v2.4.2/client/task_opts.go#L135-L168).
That implementation registers the exit waiter before SIGKILL, handles a kill which reports not-found
after succeeding, and waits before deletion. An additional preceding kill creates another failure
boundary outside that contract. This source supports the correction; actual hosted qualification
must still prove physical behavior. Prior mixed profile runs located failure in destruction but
did not establish which exact containerd subcommand failed.

Keep existing safe error codes. Stop/container command failures add only a fixed `operation` value,
`task-delete` or `container-delete`; no raw arguments, private input or nested causes. Unexpected
transport errors become `KATA_CLEANUP_FAILED`. Failed operations do not become successful cleanup.

The backend retains its final container/task absence, snapshot absence, exact original process
generation termination, runner disposal and durable destruction receipt checks. Removing a command
is not removing a physical assertion. Failed or uncertain cleanup keeps the owned record pending
and requires explicit repair; there is no silent adoption, overwrite or automatic retry.

## Verification

Commit reference/plan before regression specifications and implementation. A controlled transport
must model the standalone-kill failure boundary and accept only the upstream wait-and-delete
sequence. Assert exact ordering and that failed stop cannot remove the container. Separate unit
cases cover missing tasks, invalid names, cancellation and safe operation errors; injected fixtures
do not count as physical qualification.

The existing built default native Cordis program must retain every CPU/network/policy/descriptor,
admission, destruction and cleanup assertion and deadline. Run both complete actual hosted Ubuntu
closures, normal checks/build/full tiers and a frozen safe-mode exact archive with a fresh-cache,
scripts-disabled strict public consumer. No workstation Kata or runtime execution, dependency,
workflow, baseline, exception or timeout changes. Stay within ten files/twenty canonical method lines.
Every issue remains open, including platform#678. Work/models/accounting remain Task10. No legacy
mutation, production publication or cutover; the remaining Task3D integrations remain unfinished.
