# Complete verification within bounded jobs

This continues the accepted exhaustive scheduling strategy in Deployment #954. Every permanent
acceptance file belongs to exactly one smoke partition, and `verify` requires successful checks
and every matrix member. Keep the complete local `bun run verify` gate, original assertions,
individual test deadlines, trusted exact-head checkout and the existing fifteen-minute job limit.

Task 3D launch candidate #1070 demonstrated the remaining capacity problem: its corrected native
launch passed on both Ubuntu 26.04 runners, but both foundation jobs reached the fifteen-minute
limit. One completed all106 tests with zero failures in859.67 seconds before cancellation during
job cleanup. Passing individual tests does not make the cancelled job acceptable.

Add a `kata` partition for acceptance filenames beginning `kata-`. Preserve the seven existing
partitions and their ownership rules for every other file. Known core Kata programs remain required;
future `kata-*.test.ts` files join the new partition automatically. The existing foundation group
continues to receive remaining capability files. Reject omitted required files, duplicate/foreign
paths, empty groups and unknown partition names before execution. Check exhaustive discovery and
disjoint membership against the actual acceptance directory.

Both foundation and Kata groups prepare the same pinned fixture: foundation still verifies
installed runtime artifacts. Retain Ubuntu26.04/KVM/vhost qualification, exact compressed size/hash,
isolated owner runtime state, unchanged trusted-repository admission and every cleanup assertion.
The matrix grows by one entry; no job becomes optional, and `verify` must still reject any failed,
cancelled or skipped required job. This is scheduling within the accepted gate, not a timeout
increase, early-fast-gate proposal or permission to execute Kata on a developer workstation.

Delivery order: commit this reference and changelog; update executable workflow/inventory
regressions and capture their intended missing-partition failure; implement the bounded scheduler
and matrix change; run check/build/all lower tiers plus both full hosted closures. Preserve all
runtime source, dependencies, locks and immutable archives. The previously proposed process changes
#1032/#1060 and Platform#848 remain separate. Keep every issue open and real Work/models in Task10.
